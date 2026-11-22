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
const manifest = (build: number, androidVersionCode = 36) => ({
  schemaVersion: 1,
  product: "T3Code-LM",
  repository: "Luomo520/T3Code-LM",
  channel: "release",
  tag: `v0.1.0-${build}`,
  sourceCommit: "a".repeat(40),
  assets: [asset("arm64", build, androidVersionCode)],
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

  it("prefers a newer compatible APK even when an older arm64 build is listed first", () => {
    const older = asset("arm64", 1, 35);
    const newest = asset("universal", 3, 37);
    expect(selectAndroidUpdate([older, newest], 34, ["arm64-v8a"])).toBe(newest);
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

  it("selects the highest numeric build across release pages and rejects equal Android codes", async () => {
    const calls: string[] = [];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const address = String(url);
      calls.push(address);
      const value = address.includes("page=1")
        ? [release(2), ...Array.from({ length: 19 }, () => release(3, false))]
        : address.includes("page=2")
          ? [release(10)]
          : address.includes("/v0.1.0-10/")
            ? manifest(10, 37)
            : manifest(2);
      return new Response(JSON.stringify(value), { status: 200 });
    });
    const signal = new AbortController().signal;
    expect(
      await findAndroidAppUpdate({ installedBuild: 35, architectures: ["arm64-v8a"] }, signal),
    ).toMatchObject({ build: 10, androidVersionCode: 37 });
    expect(calls[2]).toContain("/v0.1.0-10/");
    expect(
      await findAndroidAppUpdate({ installedBuild: 37, architectures: ["arm64-v8a"] }, signal),
    ).toBeNull();
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

describe.each(["v0.1.0", "v0.1.0-2"])("grouped release %s", (tag) => {
  it("finds the Android build by its own code and uses the grouped manifest before the legacy manifest", async () => {
    const file = (build: number, code: number, arch: "arm64" | "universal") => {
      const row = asset(arch, build, code);
      return {
        ...row,
        sourceCommit: "c".repeat(40),
        url: `https://github.com/Luomo520/T3Code-LM/releases/download/${tag}/${row.fileName}`,
      };
    };
    const legacy = file(2, 36, "arm64");
    const latest = file(4, 38, "universal");
    const calls: string[] = [];
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const address = String(url);
      calls.push(address);
      if (address.includes("api.github.com")) {
        return Response.json([
          {
            tag_name: tag,
            assets: [
              { name: "T3Code-LM-platforms.json" },
              { name: "T3Code-LM-release.json" },
              { name: latest.fileName },
              { name: legacy.fileName },
            ],
          },
        ]);
      }
      expect(address).toBe(
        `https://github.com/Luomo520/T3Code-LM/releases/download/${tag}/T3Code-LM-platforms.json`,
      );
      return Response.json({
        schemaVersion: 2,
        product: "T3Code-LM",
        channel: "release",
        repository: "Luomo520/T3Code-LM",
        tag,
        productVersion: "0.1.0",
        assets: [legacy, latest],
      });
    });
    const find = (installedBuild: number) =>
      findAndroidAppUpdate(
        { installedBuild, architectures: ["arm64-v8a"] },
        new AbortController().signal,
      );
    expect(await find(35)).toMatchObject({
      androidVersionCode: 38,
      build: 4,
      fileName: latest.fileName,
    });
    expect(await find(38)).toBeNull();
    expect(calls).toHaveLength(4);
  });
});
