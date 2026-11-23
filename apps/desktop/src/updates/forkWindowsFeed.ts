import { cliReleaseIndexPageUrl } from "@t3tools/shared/cliRelease";
import {
  decodeForkReleaseManifest,
  decodeForkReleasePlatforms,
  FORK_RELEASE_MANIFEST_FILE,
  FORK_RELEASE_PLATFORMS_FILE,
  forkReleaseDownloadUrl,
  isForkReleaseTag,
  matchesForkReleaseChannel,
  type ForkUpdateChannel,
} from "@t3tools/shared/forkRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

interface WindowsFeed {
  readonly url: string;
  readonly version: string;
  readonly channel: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function findForkWindowsFeed(
  channel: ForkUpdateChannel,
  arch: string,
  signal: AbortSignal,
  read: typeof fetch = fetch,
): Promise<WindowsFeed | null> {
  const candidates: { tag: string; grouped: boolean; names: ReadonlySet<string> }[] = [];
  for (let page = 1; page <= 5; page++) {
    const response = await read(cliReleaseIndexPageUrl(page), { signal });
    if (!response.ok) throw new Error("无法读取 GitHub 发布信息，请检查网络后重试。");
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) throw new Error("GitHub 发布信息格式异常。");
    for (const release of releases) {
      if (
        !isRecord(release) ||
        !matchesForkReleaseChannel(
          { draft: release.draft === true, prerelease: release.prerelease === true },
          channel,
        ) ||
        typeof release.tag_name !== "string" ||
        !isForkReleaseTag(release.tag_name) ||
        !Array.isArray(release.assets)
      ) {
        continue;
      }
      const names = new Set<string>(
        release.assets.flatMap((asset) =>
          isRecord(asset) &&
          typeof asset.name === "string" &&
          (asset.state === undefined || asset.state === "uploaded")
            ? [asset.name]
            : [],
        ),
      );
      if (![...names].some((name) => name.endsWith(`-windows-${arch}-installer.exe`))) {
        continue;
      }
      const grouped = names.has(FORK_RELEASE_PLATFORMS_FILE);
      if (grouped || names.has(FORK_RELEASE_MANIFEST_FILE)) {
        candidates.push({ tag: release.tag_name, grouped, names });
      }
    }
    if (releases.length < 100) break;
  }
  candidates.sort((a, b) => compareSemverVersions(b.tag.slice(1), a.tag.slice(1)));
  let best: WindowsFeed | null = null;
  for (const { tag, grouped, names } of candidates) {
    const url = forkReleaseDownloadUrl(tag);
    const feedChannels = [`latest-${arch}`, "latest"].filter((name) => names.has(`${name}.yml`));
    if (feedChannels.length === 0) continue;
    const file = grouped ? FORK_RELEASE_PLATFORMS_FILE : FORK_RELEASE_MANIFEST_FILE;
    const response = await read(`${url}/${file}`, { signal });
    if (!response.ok) throw new Error("无法读取桌面端发布清单。");
    const raw: unknown = await response.json();
    const manifest = grouped
      ? decodeForkReleasePlatforms(raw, tag)
      : decodeForkReleaseManifest(raw, tag);
    if (!manifest) throw new Error("桌面端发布清单校验失败。");
    if (channel === "stable" && manifest.channel === "beta") continue;
    const installer = manifest.assets.find(
      (asset) =>
        asset.platform === "windows" &&
        asset.arch === arch &&
        asset.kind === "installer" &&
        names.has(asset.fileName),
    );
    if (!installer) continue;
    const version = `${installer.productVersion}-${installer.build}`;
    if (best && compareSemverVersions(version, best.version) <= 0) continue;
    for (const feedChannel of feedChannels) {
      const feed = await read(`${url}/${feedChannel}.yml`, { signal });
      if (!feed.ok) throw new Error("无法读取桌面端更新清单。");
      const yml = await feed.text();
      // Electron 仍按 YAML 下载校验 SHA-512。这里先核对更新清单是否指向匹配的安装包。
      const feedVersion = /^version:\s*(.+)$/m
        .exec(yml)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "");
      const feedFile = /^path:\s*(.+)$/m
        .exec(yml)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "");
      const fileUrl = /^\s*-\s+url:\s*(.+)$/m
        .exec(yml)?.[1]
        ?.trim()
        .replace(/^['"]|['"]$/g, "");
      if (feedVersion === version && feedFile === installer.fileName && fileUrl === feedFile) {
        best = { url, version, channel: feedChannel };
        break;
      }
    }
  }
  return best;
}
