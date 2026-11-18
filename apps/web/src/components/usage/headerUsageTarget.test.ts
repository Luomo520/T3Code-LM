import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  resolveHeaderUsageProvider,
  resolveHeaderUsageTarget,
  type HeaderUsageTargetConfig,
} from "./headerUsageTarget";

const a = EnvironmentId.make("environment-a");
const b = EnvironmentId.make("environment-b");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
function provider(id: string, enabled = true) {
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make(id),
    enabled,
  };
}
function config(manual = false, supported = true): HeaderUsageTargetConfig {
  return {
    environment: { capabilities: { headerUsage: supported } },
    settings: {
      providerInstances: manual
        ? {
            [codex]: {
              driver: ProviderDriverKind.make("codex"),
              config: { billingUrl: "https://example.test/v1/usage" },
            },
          }
        : {},
    },
    providers: [provider("codex"), provider("claudeAgent")],
  };
}

describe("header account selection", () => {
  it("recognizes Codex CC follow mode without a manual URL when choosing an environment", () => {
    const following = {
      ...config(),
      settings: {
        providerInstances: {
          [codex]: {
            driver: ProviderDriverKind.make("codex"),
            config: { billingSource: "ccSwitch" },
          },
        },
      },
    };
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs: new Map([
          [a, config()],
          [b, following],
        ]),
        selectedEnvironmentId: null,
        preferred: null,
      }),
    ).toEqual({ environmentId: b });
  });
  it("selects an enabled Codex follower behind another provider and honors explicit selection", () => {
    const following = {
      ...config(),
      providers: [provider("claudeAgent"), provider("codex")],
      settings: {
        providerInstances: {
          [codex]: {
            driver: ProviderDriverKind.make("codex"),
            config: { billingSource: "ccSwitch" },
          },
        },
      },
    };
    expect(resolveHeaderUsageProvider(following)?.instanceId).toBe(codex);
    expect(resolveHeaderUsageProvider(following, claude)?.instanceId).toBe(claude);
  });
  it("does not treat a non-Codex source marker or disabled follower as configured", () => {
    const unsupported = {
      ...config(),
      settings: {
        providerInstances: {
          [claude]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: { billingSource: "ccSwitch" },
          },
        },
      },
    };
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs: new Map([
          [a, config()],
          [b, unsupported],
        ]),
        selectedEnvironmentId: null,
        preferred: null,
      }),
    ).toEqual({ environmentId: a });
    const disabled = {
      ...config(),
      providers: [provider("claudeAgent"), provider("codex", false)],
      settings: {
        providerInstances: {
          [codex]: {
            driver: ProviderDriverKind.make("codex"),
            config: { billingSource: "ccSwitch" },
          },
        },
      },
    };
    expect(resolveHeaderUsageProvider(disabled)?.instanceId).toBe(claude);
  });

  it("keeps querying in all-environments mode, preferring an account with billing configured", () => {
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs: new Map([
          [a, config(false)],
          [b, config(true)],
        ]),
        selectedEnvironmentId: null,
        preferred: null,
      }),
    ).toEqual({ environmentId: b });
  });
  it("follows the last viewed conversation account without changing the list filter", () => {
    const preferred = { environmentId: a, providerInstanceId: claude };
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs: new Map([[b, config(true)]]),
        selectedEnvironmentId: null,
        preferred,
      }),
    ).toEqual(preferred);
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs: new Map(),
        selectedEnvironmentId: b,
        preferred,
      }),
    ).toEqual({ environmentId: b });
  });
  it("drops removed environments and keeps an explicit same-environment provider", () => {
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [b],
        configs: new Map(),
        selectedEnvironmentId: null,
        preferred: { environmentId: a },
      }),
    ).toEqual({ environmentId: b });
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a],
        configs: new Map(),
        selectedEnvironmentId: a,
        preferred: { environmentId: a, providerInstanceId: claude },
      }),
    ).toEqual({ environmentId: a, providerInstanceId: claude });
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [],
        configs: new Map(),
        selectedEnvironmentId: null,
        preferred: null,
      }),
    ).toBeNull();
  });
  it("prefers a supported backend while keeping a disconnected explicit selection visible", () => {
    const configs = new Map([
      [a, config(false, false)],
      [b, config()],
    ]);
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs,
        selectedEnvironmentId: null,
        preferred: null,
      }),
    ).toEqual({ environmentId: b });
    expect(
      resolveHeaderUsageTarget({
        environmentIds: [a, b],
        configs,
        selectedEnvironmentId: a,
        preferred: null,
      }),
    ).toEqual({ environmentId: a });
  });
  it("opens exactly the tapped provider and never silently edits another account", () => {
    const current = config(true);
    expect(resolveHeaderUsageProvider(current, claude)?.instanceId).toBe(claude);
    expect(resolveHeaderUsageProvider(current, "deleted")).toBeUndefined();
    expect(resolveHeaderUsageProvider(current)?.instanceId).toBe(codex);
    expect(resolveHeaderUsageProvider(undefined)).toBeUndefined();
  });
});
