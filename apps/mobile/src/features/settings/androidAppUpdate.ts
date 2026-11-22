import {
  decodeForkReleaseManifest,
  decodeForkReleasePlatforms,
  FORK_RELEASE_MANIFEST_FILE,
  FORK_RELEASE_PLATFORMS_FILE,
  FORK_RELEASE_REPOSITORY,
  forkReleaseManifestUrl,
  forkReleasePlatformsUrl,
  isForkReleaseTag,
  type ForkReleaseAsset,
} from "@t3tools/shared/forkRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

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
  // 同一发布页可保留多个构建。按 Android 内部版本号选择，同版优先原生架构。
  return (
    compatible.sort(
      (a, b) =>
        b.androidVersionCode - a.androidVersionCode ||
        Number(b.arch === "arm64") - Number(a.arch === "arm64"),
    )[0] ?? null
  );
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
  const candidates = new Map<string, Set<string>>();
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
        !isForkReleaseTag(release.tag_name) ||
        !Array.isArray(release.assets)
      ) {
        continue;
      }
      const names = new Set(
        release.assets.flatMap((asset) =>
          isRecord(asset) &&
          typeof asset.name === "string" &&
          (asset.state === undefined || asset.state === "uploaded")
            ? [asset.name]
            : [],
        ),
      );
      if (names.has(FORK_RELEASE_PLATFORMS_FILE)) {
        if (
          [...names].some(
            (name) =>
              name.endsWith("-android-arm64-apk.apk") ||
              name.endsWith("-android-universal-apk.apk"),
          )
        ) {
          candidates.set(release.tag_name, names);
        }
        continue;
      }
      const apkPrefix = `T3Code-LM-${release.tag_name.slice(1)}-android-`;
      if (
        names.has(FORK_RELEASE_MANIFEST_FILE) &&
        (names.has(`${apkPrefix}arm64-apk.apk`) || names.has(`${apkPrefix}universal-apk.apk`))
      ) {
        candidates.set(release.tag_name, names);
      }
    }
    if (releases.length < 20) break;
  }
  // GitHub's release order can differ from the product and build version order.
  const ordered = [...candidates].sort(([left], [right]) =>
    compareSemverVersions(right.slice(1), left.slice(1)),
  );
  for (const [tag, names] of ordered) {
    const grouped = names.has(FORK_RELEASE_PLATFORMS_FILE);
    const manifestUrl = grouped ? forkReleasePlatformsUrl(tag) : forkReleaseManifestUrl(tag);
    const manifestResponse = await fetch(manifestUrl, { signal });
    if (!manifestResponse.ok) throw new Error("无法读取更新清单，请稍后重试。");
    const raw: unknown = await manifestResponse.json();
    const manifest = grouped
      ? decodeForkReleasePlatforms(raw, tag)
      : decodeForkReleaseManifest(raw, tag);
    if (!manifest) throw new Error("更新清单校验失败，未提供下载。");
    const asset = selectAndroidUpdate(
      manifest.assets.filter((row) => names.has(row.fileName)),
      input.installedBuild,
      input.architectures,
    );
    if (asset) return asset;
  }
  return null;
}
