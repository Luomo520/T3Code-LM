import type { ProviderInstanceId, ServerSettings } from "@t3tools/contracts";

/** This build never falls back from native Codex agents to ordinary Codex threads. */
export const CODEX_NATIVE_SUBAGENTS_ONLY =
  "Codex child tasks must use the parent's native subagent tools. T3 delegate_task cannot create " +
  "native Codex agents and ordinary child threads are disabled. Do not fall back to create_threads, " +
  "t3_thread_launch, an attached fork, another provider, or modified source/parent metadata. " +
  "If native tools cannot preserve the requested model, options, or isolation, report the " +
  "capability mismatch and keep the task in the parent; do not silently discard settings.";

export function isNativeOnlyCodexTarget(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver?: string | undefined;
  readonly settings?: Pick<ServerSettings, "providerInstances">;
}): boolean {
  return (
    (input.driver ??
      input.settings?.providerInstances[input.instanceId]?.driver ??
      input.instanceId) === "codex"
  );
}

/** Provider-native events keep their real identity; app-owned storage is not native creation. */
export function isIndependentCodexChild(input: {
  readonly driver: string;
  readonly relationshipToParent: string | null | undefined;
  readonly origin: string | null | undefined;
}): boolean {
  return (
    input.driver === "codex" &&
    input.relationshipToParent === "subagent" &&
    input.origin !== "provider_native"
  );
}
