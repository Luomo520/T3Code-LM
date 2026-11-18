import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isIndependentCodexChild, isNativeOnlyCodexTarget } from "./codexSubagentPolicy.ts";

describe("native-only Codex subagents", () => {
  it("recognizes the default instance and custom Codex instances by driver", () => {
    expect(isNativeOnlyCodexTarget({ instanceId: ProviderInstanceId.make("codex") })).toBe(true);
    expect(
      isNativeOnlyCodexTarget({ instanceId: ProviderInstanceId.make("custom"), driver: "codex" }),
    ).toBe(true);
    expect(
      isNativeOnlyCodexTarget({
        instanceId: ProviderInstanceId.make("codex"),
        driver: "claudeAgent",
      }),
    ).toBe(false);
    expect(isNativeOnlyCodexTarget({ instanceId: ProviderInstanceId.make("claudeAgent") })).toBe(
      false,
    );
  });

  it("reads a custom instance driver without guessing from its identifier", () => {
    expect(
      isNativeOnlyCodexTarget({
        instanceId: ProviderInstanceId.make("local_provider"),
        settings: {
          providerInstances: {
            [ProviderInstanceId.make("local_provider")]: {
              driver: ProviderDriverKind.make("codex"),
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("allows real native children and ordinary root/fork threads", () => {
    expect(
      isIndependentCodexChild({
        driver: "codex",
        relationshipToParent: "subagent",
        origin: "provider_native",
      }),
    ).toBe(false);
    expect(
      isIndependentCodexChild({ driver: "codex", relationshipToParent: null, origin: null }),
    ).toBe(false);
    expect(
      isIndependentCodexChild({
        driver: "codex",
        relationshipToParent: "fork",
        origin: "app_owned",
      }),
    ).toBe(false);
  });

  it("refuses independent Codex children including missing ownership evidence", () => {
    for (const origin of ["app_owned", undefined, null]) {
      expect(
        isIndependentCodexChild({ driver: "codex", relationshipToParent: "subagent", origin }),
      ).toBe(true);
    }
    expect(
      isIndependentCodexChild({
        driver: "claudeAgent",
        relationshipToParent: "subagent",
        origin: "app_owned",
      }),
    ).toBe(false);
  });
});
