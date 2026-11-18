import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import { usageSettingsBillingSource, usageSettingsFields } from "./headerUsageSettingsModel";

export interface HeaderUsageTarget {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId?: ProviderInstanceId;
}

export interface HeaderUsageTargetConfig {
  readonly environment: { readonly capabilities: { readonly headerUsage?: boolean } };
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly providers: readonly Pick<
    ServerProvider,
    "instanceId" | "driver" | "enabled" | "displayName"
  >[];
}

/** Pick one labelled account; never sum unrelated environment balances. */
export function resolveHeaderUsageTarget(input: {
  readonly environmentIds: readonly EnvironmentId[];
  readonly configs: ReadonlyMap<EnvironmentId, HeaderUsageTargetConfig>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly preferred: HeaderUsageTarget | null;
}): HeaderUsageTarget | null {
  const { environmentIds, configs, selectedEnvironmentId, preferred } = input;
  if (selectedEnvironmentId) {
    return {
      environmentId: selectedEnvironmentId,
      ...(preferred?.environmentId === selectedEnvironmentId && preferred.providerInstanceId
        ? { providerInstanceId: preferred.providerInstanceId }
        : {}),
    };
  }
  if (preferred && environmentIds.includes(preferred.environmentId)) return preferred;
  const configured = environmentIds.find((id) => {
    const config = configs.get(id);
    return (
      config?.environment.capabilities.headerUsage &&
      Object.values(config.settings.providerInstances).some(
        (instance) =>
          usageSettingsFields(instance.config).billingUrl ||
          usageSettingsBillingSource(instance.driver, instance.config) === "ccSwitch",
      )
    );
  });
  const id =
    configured ??
    environmentIds.find((id) => configs.get(id)?.environment.capabilities.headerUsage) ??
    environmentIds[0];
  return id ? { environmentId: id } : null;
}

export function resolveHeaderUsageProvider(
  config: HeaderUsageTargetConfig | undefined,
  instanceId?: string,
) {
  const providers =
    config?.providers.filter(
      (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
    ) ?? [];
  if (instanceId) return providers.find((provider) => provider.instanceId === instanceId);
  return (
    providers.find((provider) => {
      const fields = config?.settings.providerInstances[provider.instanceId]?.config;
      return (
        provider.enabled &&
        (usageSettingsFields(fields).billingUrl ||
          usageSettingsBillingSource(provider.driver, fields) === "ccSwitch")
      );
    }) ??
    providers.find((provider) => provider.enabled) ??
    providers[0]
  );
}
