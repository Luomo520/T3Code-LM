import { compareSemverVersions } from "./semver.ts";
import { FORK_RELEASE_MANIFEST_FILE, FORK_RELEASE_REPOSITORY } from "./forkRelease.generated.ts";
export * from "./forkRelease.generated.ts";
/** Fork publication tags encode the build as a numeric suffix. */
export function isForkBuildVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[1-9]\d*$/.test(version);
}

/** The release was already selected by the host for its own platform and architecture. */
export function resolveForkUpdateTarget(
  currentVersion: string,
  releaseVersion: string | null,
): { readonly targetVersion: string | null; readonly manualCheckRequired: boolean } {
  if (releaseVersion === null) return { targetVersion: null, manualCheckRequired: false };
  if (!isForkBuildVersion(releaseVersion))
    return { targetVersion: null, manualCheckRequired: true };
  const newer =
    !isForkBuildVersion(currentVersion) ||
    compareSemverVersions(releaseVersion, currentVersion) > 0;
  return { targetVersion: newer ? releaseVersion : null, manualCheckRequired: false };
}

export interface ForkReleaseAsset {
  readonly platform: "windows" | "linux" | "android";
  readonly arch: "x64" | "arm64" | "universal";
  readonly kind: "installer" | "portable" | "server" | "apk";
  readonly productVersion: string;
  readonly build: number;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly url: string;
  /** Android installation compares this independently from the display version. */
  readonly androidVersionCode?: number;
  readonly sourceCommit?: string;
}
export type ForkUpdateChannel = "stable" | "beta";

export function matchesForkReleaseChannel(
  release: { readonly prerelease?: boolean | undefined; readonly draft?: boolean | undefined },
  channel: ForkUpdateChannel,
): boolean {
  return release.draft !== true && (release.prerelease === true) === (channel === "beta");
}

export function forkReleaseDownloadUrl(tag: string): string {
  return `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;
}

export const FORK_RELEASE_PLATFORMS_FILE = "T3Code-LM-platforms.json";

export function isForkReleaseTag(tag: string): boolean {
  return /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[1-9]\d*)?$/.test(tag);
}

export const forkReleasePlatformsUrl = (tag: string) =>
  `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${FORK_RELEASE_PLATFORMS_FILE}`;

export interface ForkReleasePlatforms {
  readonly tag: string;
  readonly channel: "release" | "beta";
  readonly productVersion: string;
  readonly assets: readonly (ForkReleaseAsset & { readonly sourceCommit: string })[];
}

export interface ForkReleaseManifest {
  readonly tag: string;
  readonly channel: "release" | "beta";
  readonly assets: readonly ForkReleaseAsset[];
  readonly sourceCommit: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const forkReleaseManifestUrl = (tag: string) =>
  `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${FORK_RELEASE_MANIFEST_FILE}`;
/** Validate identity and origin before offering an asset; downloaded bytes still need a digest check. */
export function decodeForkReleaseManifest(
  value: unknown,
  tag: string,
): ForkReleaseManifest | undefined {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.product !== "T3Code-LM" ||
    (value.channel !== "release" && value.channel !== "beta") ||
    value.repository !== FORK_RELEASE_REPOSITORY ||
    value.tag !== tag ||
    !Array.isArray(value.assets) ||
    !value.assets.length ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    return;
  const assets = decodeAssets(value.assets, tag);
  if (assets) return { tag, channel: value.channel, sourceCommit: value.sourceCommit, assets };
}

export function decodeForkReleasePlatforms(
  value: unknown,
  tag: string,
): ForkReleasePlatforms | undefined {
  if (
    !record(value) ||
    !isForkReleaseTag(tag) ||
    value.schemaVersion !== 2 ||
    value.product !== "T3Code-LM" ||
    (value.channel !== "release" && value.channel !== "beta") ||
    value.repository !== FORK_RELEASE_REPOSITORY ||
    value.tag !== tag ||
    typeof value.productVersion !== "string" ||
    value.productVersion !== tag.slice(1).split("-")[0] ||
    !Array.isArray(value.assets) ||
    !value.assets.length
  )
    return;
  const assets = decodeAssets(value.assets, tag, value.productVersion);
  if (assets) return { tag, channel: value.channel, productVersion: value.productVersion, assets };
}

function decodeAssets(rows: unknown[], tag: string): ForkReleaseAsset[] | undefined;
function decodeAssets(
  rows: unknown[],
  tag: string,
  productVersion: string,
): (ForkReleaseAsset & { readonly sourceCommit: string })[] | undefined;
function decodeAssets(rows: unknown[], tag: string, productVersion?: string) {
  const assets: ForkReleaseAsset[] = [];
  const seen = new Set<string>();
  for (const asset of rows) {
    if (
      !record(asset) ||
      typeof asset.productVersion !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(asset.productVersion) ||
      !Number.isSafeInteger(asset.build) ||
      (asset.build as number) <= 0 ||
      !Number.isSafeInteger(asset.sizeBytes) ||
      (asset.sizeBytes as number) <= 0 ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      return;
    if (
      asset.platform === "android" &&
      (!Number.isSafeInteger(asset.androidVersionCode) || (asset.androidVersionCode as number) < 35)
    )
      return;
    if (asset.platform !== "android" && asset.androidVersionCode !== undefined) return;
    const extension =
      asset.platform === "windows" && asset.kind === "installer"
        ? "exe"
        : asset.platform === "windows" && asset.kind === "portable"
          ? "zip"
          : asset.platform === "linux" && asset.kind === "server"
            ? "tar.gz"
            : asset.platform === "android" && asset.kind === "apk"
              ? "apk"
              : undefined;
    if (
      extension === undefined ||
      !(asset.platform === "android" ? ["arm64", "universal"] : ["x64", "arm64"]).includes(
        String(asset.arch),
      )
    )
      return;
    if (
      productVersion !== undefined &&
      (typeof asset.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(asset.sourceCommit))
    )
      return;
    const expected = `T3Code-LM-${asset.productVersion}-${asset.build}-${asset.platform}-${asset.arch}-${asset.kind}.${extension}`;
    if (
      (productVersion === undefined
        ? tag !== `v${asset.productVersion}-${asset.build}`
        : asset.productVersion !== productVersion) ||
      asset.fileName !== expected ||
      asset.url !==
        `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(expected)}`
    )
      return;
    const key = `${asset.platform}/${asset.arch}/${asset.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    assets.push(asset as unknown as ForkReleaseAsset);
  }
  for (const asset of assets.filter((item) => item.platform === "windows")) {
    if (
      !assets.some(
        (other) =>
          other.platform === "windows" &&
          other.arch === asset.arch &&
          other.kind !== asset.kind &&
          other.productVersion === asset.productVersion &&
          other.build === asset.build &&
          (productVersion === undefined || other.sourceCommit === asset.sourceCommit),
      )
    )
      return;
  }
  return assets;
}
