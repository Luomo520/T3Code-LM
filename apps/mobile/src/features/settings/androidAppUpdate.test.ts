import { describe, expect, it, vi } from "vite-plus/test";
import type { ForkReleaseAsset } from "@t3tools/shared/forkRelease";
import {
  findAndroidAppUpdate,
  requiresMobileDownloadConfirmation,
  selectAndroidUpdate,
} from "./androidAppUpdate";

const asset = (
  arch: "arm64" | "universal",
  build = 2,
  androidVersionCode = 36,
): ForkReleaseAsset => ({
  platform: "android",
  arch,
  kind: "apk",
  productVersion: "0.1.0",
  build,
  androidVersionCode,
  fileName: `T3Code-LM-0.1.0-${build}-android-${arch}-apk.apk`,
  sizeBytes: 1024,
  sha256: "a".repeat(64),
  url: `https://github.com/Luomo520/T3Code-LM/releases/download/v0.1.0-${build}/T3Code-LM-0.1.0-${build}-android-${arch}-apk.apk`,
});
const release = (build: number, hasApk = true) => ({
  tag_name: `v0.1.0-${build}`,
  draft: false,
  prerelease: false,
  assets: [
    { name: "T3Code-LM-release.json" },
    ...(hasApk ? [{ name: `T3Code-LM-0.1.0-${build}-android-arm64-apk.apk` }] : []),
  ],
});
const manifest = (build: number) => ({
  schemaVersion: 1,
  product: "T3Code-LM",
  repository: "Luomo520/T3Code-LM",
  channel: "release",
  tag: `v0.1.0-${build}`,
  sourceCommit: "a".repeat(40),
  assets: [asset("arm64", build)],
});

describe("Android release selection", () => {
  it("uses Android's build code across the old version naming and selects a compatible APK", () => {
    const universal = asset("universal");
    const arm64 = asset("arm64");
    expect(selectAndroidUpdate([universal, arm64], 34, ["arm64-v8a"])).toBe(arm64);
    expect(selectAndroidUpdate([universal, arm64], 34, ["x86_64"])).toBe(universal);
    expect(selectAndroidUpdate([arm64], 34, ["x86_64"])).toBeNull();
    expect(selectAndroidUpdate([arm64], 36, ["arm64-v8a"])).toBeNull();
    expect(
      selectAndroidUpdate([{ ...arm64, androidVersionCode: undefined }], 34, ["arm64-v8a"]),
    ).toBeNull();
  });

  it("requires explicit confirmation on mobile and unknown networks", () => {
    for (const type of ["CELLULAR", "UNKNOWN", "OTHER", "NONE"]) {
      expect(requiresMobileDownloadConfirmation(type)).toBe(true);
    }
    expect(requiresMobileDownloadConfirmation("WIFI")).toBe(false);
    expect(requiresMobileDownloadConfirmation("ETHERNET")).toBe(false);
  });

  it("finds Android updates behind a newer Windows-only release without downloading an APK", async () => {
    const calls: string[] = [];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify(calls.length === 1 ? [release(3, false), release(2)] : manifest(2)),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    });
    const result = await findAndroidAppUpdate(
      { installedBuild: 35, architectures: ["arm64-v8a"] },
      new AbortController().signal,
    );
    expect(result?.androidVersionCode).toBe(36);
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => !url.endsWith(".apk"))).toBe(true);
  });

  it("rejects a manifest redirected to another package origin before offering a download", async () => {
    let calls = 0;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      const value =
        calls === 1
          ? [release(2)]
          : {
              ...manifest(2),
              assets: [{ ...asset("arm64"), url: "https://other.example/update.apk" }],
            };
      return new Response(JSON.stringify(value), { status: 200 });
    });
    await expect(
      findAndroidAppUpdate(
        { installedBuild: 35, architectures: ["arm64-v8a"] },
        new AbortController().signal,
      ),
    ).rejects.toThrow("更新清单校验失败");
  });
});
