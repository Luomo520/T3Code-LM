import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  FORK_ANDROID_VERSION_CODE,
  FORK_RELEASE_VERSION,
} from "../../packages/shared/src/forkRelease.generated.ts";
import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined, mobileVersionPolicy?: string) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  vi.stubEnv("MOBILE_VERSION_POLICY", mobileVersionPolicy);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "production", "com.t3tools.t3code", "t3code", "fingerprint"],
  ["development", "development", "com.t3tools.t3code.dev", "t3code-dev", "appVersion"],
  ["preview", "preview", "com.t3tools.t3code.preview", "t3code-preview", "fingerprint"],
  ["production", "production", "com.t3tools.t3code", "t3code", "fingerprint"],
] as const)(
  "configures the package, links and update policy for APP_VARIANT=%j",
  async (value, variant, iosIdentifier, scheme, runtimePolicy) => {
    const config = await loadConfig(value);
    expect(config.extra?.appVariant).toBe(variant);
    expect(config.ios?.bundleIdentifier).toBe(iosIdentifier);
    expect(config.android?.package).toBe("com.t3tools.t3code.zh");
    expect(config.android?.versionCode).toBe(FORK_ANDROID_VERSION_CODE);
    expect(config.version).toBe(FORK_RELEASE_VERSION);
    expect(config.scheme).toBe(scheme);
    expect(config.runtimeVersion).toEqual({ policy: runtimePolicy });
    expect(config.updates?.enabled).toBe(false);

    const host = new URL(DEFAULT_HOSTED_APP_URL).host;
    expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
    expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
      `${config.ios?.appleTeamId}.${iosIdentifier}`,
    );
    expect(config.android?.intentFilters).toContainEqual({
      action: "VIEW",
      autoVerify: true,
      category: ["BROWSABLE", "DEFAULT"],
      data: [{ scheme: "https", host, pathPrefix: "/threads/" }],
    });
  },
);

it("keeps the hosted Android link records for the upstream packages", () => {
  expect(assetLinks.map((link) => link.target.package_name)).toEqual(
    expect.arrayContaining([
      "com.t3tools.t3code",
      "com.t3tools.t3code.preview",
      "com.t3tools.t3code.dev",
    ]),
  );
});

it("applies an explicit runtime policy while keeping Expo updates disabled", async () => {
  const config = await loadConfig("development", "fingerprint");
  expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
  expect(config.updates?.enabled).toBe(false);
});
