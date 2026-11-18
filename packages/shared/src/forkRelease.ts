import { FORK_RELEASE_MANIFEST_FILE, FORK_RELEASE_REPOSITORY } from "./forkRelease.generated.ts";
export * from "./forkRelease.generated.ts";
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
}
export interface ForkReleaseManifest {
  readonly tag: string;
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
    value.channel !== "release" ||
    value.repository !== FORK_RELEASE_REPOSITORY ||
    value.tag !== tag ||
    !Array.isArray(value.assets) ||
    !value.assets.length ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit)
  )
    return;
  const assets: ForkReleaseAsset[] = [];
  const seen = new Set<string>();
  for (const asset of value.assets) {
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
    const expected = `T3Code-LM-${asset.productVersion}-${asset.build}-${asset.platform}-${asset.arch}-${asset.kind}.${extension}`;
    if (
      tag !== `v${asset.productVersion}-${asset.build}` ||
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
          other.build === asset.build,
      )
    )
      return;
  }
  return { tag, sourceCommit: value.sourceCommit, assets };
}
