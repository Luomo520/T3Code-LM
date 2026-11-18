import {
  decodeForkReleaseManifest,
  FORK_RELEASE_MANIFEST_FILE,
  FORK_RELEASE_REPOSITORY,
  forkReleaseManifestUrl,
  type ForkReleaseAsset,
} from "@t3tools/shared/forkRelease";

export type AndroidUpdateAsset = ForkReleaseAsset & { readonly androidVersionCode: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function selectAndroidUpdate(
  assets: readonly ForkReleaseAsset[],
  installedBuild: number,
  architectures: readonly string[],
): AndroidUpdateAsset | null {
  const arm64 = architectures.some((arch) => arch === "arm64-v8a" || arch === "arm64 v8");
  const compatible = assets.filter(
    (asset): asset is AndroidUpdateAsset =>
      asset.platform === "android" &&
      asset.kind === "apk" &&
      (asset.arch === "universal" || (arm64 && asset.arch === "arm64")) &&
      "androidVersionCode" in asset &&
      Number.isSafeInteger(asset.androidVersionCode) &&
      (asset.androidVersionCode as number) > installedBuild,
  );
  return compatible.find((asset) => asset.arch === "arm64") ?? compatible[0] ?? null;
}

/** Wi-Fi/Ethernet submissions cannot silently continue over mobile data later. */
export function requiresMobileDownloadConfirmation(type: string | undefined): boolean {
  return type !== "WIFI" && type !== "ETHERNET";
}

/** Called only by Check for updates; never starts an APK download. */
export async function findAndroidAppUpdate(
  input: { readonly installedBuild: number; readonly architectures: readonly string[] },
  signal: AbortSignal,
): Promise<AndroidUpdateAsset | null> {
  if (!Number.isSafeInteger(input.installedBuild) || input.installedBuild < 1) {
    throw new Error("无法识别已安装 App 的构建号，请重新打开 App 后重试。");
  }
  // A Windows-only release must not hide the latest Android package.
  for (let page = 1; page <= 3; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${FORK_RELEASE_REPOSITORY}/releases?per_page=20&page=${page}`,
      { signal, headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 403 || response.status === 429
          ? "GitHub 暂时限制查询，请稍后重试。"
          : "无法检查更新，请检查 GitHub 连接后重试。",
      );
    }
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) throw new Error("GitHub 发布信息格式异常，请稍后重试。");
    for (const release of releases) {
      if (
        !isRecord(release) ||
        release.draft === true ||
        release.prerelease === true ||
        typeof release.tag_name !== "string" ||
        !/^v\d+\.\d+\.\d+-[1-9]\d*$/.test(release.tag_name) ||
        !Array.isArray(release.assets) ||
        !release.assets.some(
          (asset) => isRecord(asset) && asset.name === FORK_RELEASE_MANIFEST_FILE,
        ) ||
        !release.assets.some(
          (asset) =>
            isRecord(asset) &&
            typeof asset.name === "string" &&
            /-android-(arm64|universal)-apk\.apk$/.test(asset.name),
        )
      ) {
        continue;
      }
      const manifestResponse = await fetch(forkReleaseManifestUrl(release.tag_name), { signal });
      if (!manifestResponse.ok) throw new Error("无法读取更新清单，请稍后重试。");
      const manifest = decodeForkReleaseManifest(await manifestResponse.json(), release.tag_name);
      if (!manifest) throw new Error("更新清单校验失败，未提供下载。");
      const asset = selectAndroidUpdate(manifest.assets, input.installedBuild, input.architectures);
      if (asset) return asset;
    }
    if (releases.length < 20) break;
  }
  return null;
}
