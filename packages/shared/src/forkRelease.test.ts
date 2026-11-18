import { describe, expect, it } from "vite-plus/test";
import { decodeForkReleaseManifest, FORK_RELEASE_REPOSITORY } from "./forkRelease.ts";

const android = () => ({
  platform: "android",
  arch: "arm64",
  kind: "apk",
  productVersion: "0.1.0",
  build: 1,
  androidVersionCode: 35,
  fileName: "T3Code-LM-0.1.0-1-android-arm64-apk.apk",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  url: `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/v0.1.0-1/T3Code-LM-0.1.0-1-android-arm64-apk.apk`,
});
const manifest = () => ({
  schemaVersion: 1,
  product: "T3Code-LM",
  channel: "release",
  repository: FORK_RELEASE_REPOSITORY,
  tag: "v0.1.0-1",
  sourceCommit: "b".repeat(40),
  assets: [android()],
});
describe("fork release manifest", () => {
  it("accepts a single-platform release and validates immutable package identity", () => {
    expect(decodeForkReleaseManifest(manifest(), "v0.1.0-1")?.assets).toHaveLength(1);
    for (const patch of [
      { repository: "another/fork" },
      { channel: "nightly" },
      { tag: "v0.1.0-2" },
      { sourceCommit: "short" },
    ]) {
      expect(decodeForkReleaseManifest({ ...manifest(), ...patch }, "v0.1.0-1")).toBeUndefined();
    }
    for (const patch of [
      { build: 2 },
      { sha256: "bad" },
      { fileName: "../package.apk" },
      { sizeBytes: 0 },
      { url: "https://example.com/package.apk" },
      { androidVersionCode: 34 },
      { androidVersionCode: undefined },
    ]) {
      expect(
        decodeForkReleaseManifest(
          { ...manifest(), assets: [{ ...android(), ...patch }] },
          "v0.1.0-1",
        ),
      ).toBeUndefined();
    }
    expect(
      decodeForkReleaseManifest({ ...manifest(), assets: [android(), android()] }, "v0.1.0-1"),
    ).toBeUndefined();
  });
  it("requires a Windows installer and portable ZIP from the same release", () => {
    const installer = {
      ...android(),
      platform: "windows",
      arch: "x64",
      kind: "installer",
      androidVersionCode: undefined,
      fileName: "T3Code-LM-0.1.0-1-windows-x64-installer.exe",
      url: `https://github.com/${FORK_RELEASE_REPOSITORY}/releases/download/v0.1.0-1/T3Code-LM-0.1.0-1-windows-x64-installer.exe`,
    };
    const portable = {
      ...installer,
      kind: "portable",
      fileName: installer.fileName.replace("installer.exe", "portable.zip"),
      url: installer.url.replace("installer.exe", "portable.zip"),
    };
    expect(
      decodeForkReleaseManifest({ ...manifest(), assets: [installer] }, "v0.1.0-1"),
    ).toBeUndefined();
    expect(
      decodeForkReleaseManifest({ ...manifest(), assets: [installer, portable] }, "v0.1.0-1")
        ?.assets,
    ).toHaveLength(2);
    expect(
      decodeForkReleaseManifest(
        { ...manifest(), assets: [installer, { ...portable, arch: "arm64" }] },
        "v0.1.0-1",
      ),
    ).toBeUndefined();
  });
});
