import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  dedupeProvidersByDriver,
  formatProviderMaintenanceMessage,
  isProviderUpdateActive,
} from "@t3tools/client-runtime/providerUpdates";

export {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  hasOneClickUpdateProviderCandidate,
  isProviderSettingsUpdateCandidate,
  isProviderUpdateCandidate,
  isProviderUpdateActive,
  type ProviderUpdateCandidate,
  type ProviderSettingsUpdateCandidate,
} from "@t3tools/client-runtime/providerUpdates";

export type ProviderUpdateSidebarPillTone = "loading" | "warning" | "error" | "success";

export interface ProviderUpdateSidebarPillView {
  readonly key: string;
  readonly tone: ProviderUpdateSidebarPillTone;
  readonly title: string;
  readonly description: string;
  readonly dismissible?: boolean;
  readonly dismissAfterVisibleMs?: number;
}

interface ProviderUpdateSidebarPillOptions {
  readonly visibleAfterIso?: string;
  readonly dismissedKeys?: ReadonlySet<string>;
}

const PROVIDER_UPDATE_SUCCESS_VISIBLE_MS = 3_000;

function formatVersion(value: string): string {
  return value.startsWith("v") ? value : `v${value}`;
}

function getProviderUpdatedTitle(
  provider: Pick<ServerProvider, "driver" | "version" | "installedVersion">,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const version = provider.installedVersion ?? provider.version;
  return version ? `${providerName} 已更新：${formatVersion(version)}` : `${providerName} 已更新`;
}

// Only OpenCode reports an installed CLI apart from a running external server.
export function getProviderRestartNotice(
  provider: Pick<ServerProvider, "version" | "installedVersion" | "updateState">,
): string | null {
  return provider.updateState?.status === "succeeded" &&
    provider.installedVersion != null &&
    provider.version != null &&
    provider.installedVersion !== provider.version &&
    provider.updateState.message
    ? formatProviderMaintenanceMessage(provider.updateState.message)
    : null;
}

const providerUpdatedDescription = "新会话将使用更新后的 CLI。";

function getProviderFailedUpdateTitle(
  provider: Pick<ServerProvider, "driver" | "versionAdvisory">,
): string {
  const providerName = PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
  const attemptedVersion = provider.versionAdvisory?.latestVersion;
  return attemptedVersion
    ? `${providerName} ${formatVersion(attemptedVersion)} 更新失败`
    : `${providerName} 更新失败`;
}

function formatProviderList(providers: ReadonlyArray<Pick<ServerProvider, "driver">>) {
  const names = providers.map(
    (provider) => PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver,
  );
  return names.join("、");
}

export interface ProviderUpdateRun {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly result: AtomCommandResult<
    { readonly providers: ReadonlyArray<ServerProvider> },
    unknown
  >;
}

export function getProviderUpdateRunOutcome(
  run: ProviderUpdateRun,
):
  | { readonly status: "interrupted" }
  | { readonly status: "updated"; readonly message: string | null }
  | { readonly status: "failed"; readonly line: string } {
  if (isAtomCommandInterrupted(run.result)) return { status: "interrupted" };
  const label = `${run.machineLabel} · ${PROVIDER_DISPLAY_NAMES[run.driver] ?? run.driver}`;
  if (run.result._tag === "Failure") {
    const error = squashAtomCommandFailure(run.result);
    return {
      status: "failed",
      line: `${label}: ${error instanceof Error ? formatProviderMaintenanceMessage(error.message) : "CLI 更新失败"}`,
    };
  }
  const provider = run.result.value.providers.find(
    (candidate) => candidate.instanceId === run.instanceId,
  );
  const updateState = provider?.updateState;
  const restartNotice = provider ? getProviderRestartNotice(provider) : null;
  return updateState?.status === "succeeded"
    ? { status: "updated", message: restartNotice ? `${label}: ${restartNotice}` : null }
    : {
        status: "failed",
        line: `${label}: ${updateState?.message ? formatProviderMaintenanceMessage(updateState.message) : "CLI 更新未完成"}`,
      };
}

export function getProviderUpdateRunToastView(runs: ReadonlyArray<ProviderUpdateRun>): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description: string;
} | null {
  const settled = runs
    .map(getProviderUpdateRunOutcome)
    .filter((outcome) => outcome.status !== "interrupted");
  if (settled.length === 0) {
    return null;
  }
  const failureLines = settled.flatMap((outcome) =>
    outcome.status === "failed" ? [outcome.line] : [],
  );
  const successMessages = [
    ...new Set(
      settled.flatMap((outcome) =>
        outcome.status === "updated" && outcome.message ? [outcome.message] : [],
      ),
    ),
  ];
  if (failureLines.length === 0) {
    return {
      type: "success",
      title: `已更新 ${settled.length} 项 CLI`,
      description: successMessages.join("\n") || providerUpdatedDescription,
    };
  }
  return {
    type: "error",
    title:
      failureLines.length < settled.length
        ? `${settled.length} 项 CLI 中有 ${failureLines.length} 项更新失败`
        : "CLI 更新失败",
    description: [...failureLines, ...successMessages].join("\n"),
  };
}

function getUpdateFinishedAt(provider: ServerProvider): string | null {
  return provider.updateState?.finishedAt ?? null;
}

function isRecentTerminalProvider(
  provider: ServerProvider,
  visibleAfterIso: string | undefined,
): boolean {
  const status = provider.updateState?.status;
  if (status !== "failed" && status !== "unchanged" && status !== "succeeded") {
    return false;
  }
  if (visibleAfterIso === undefined) {
    return true;
  }
  const finishedAt = getUpdateFinishedAt(provider);
  return finishedAt !== null && finishedAt >= visibleAfterIso;
}

function latestFinishedAtForProviders(providers: ReadonlyArray<ServerProvider>): string | null {
  return providers.reduce<string | null>((latest, provider) => {
    const finishedAt = getUpdateFinishedAt(provider);
    if (finishedAt === null) {
      return latest;
    }
    return latest === null || finishedAt > latest ? finishedAt : latest;
  }, null);
}

/** Use each driver's latest finished instance so an older default-instance result cannot hide it. */
function latestTerminalProvidersByDriver(providers: ReadonlyArray<ServerProvider>) {
  const latestProviderByDriver = new Map<ProviderDriverKind, ServerProvider>();

  for (const provider of providers) {
    const current = latestProviderByDriver.get(provider.driver);
    if (!current || (getUpdateFinishedAt(provider) ?? "") >= (getUpdateFinishedAt(current) ?? "")) {
      latestProviderByDriver.set(provider.driver, provider);
    }
  }

  return [...latestProviderByDriver.values()];
}

export function getProviderUpdateSidebarPillView(
  providers: ReadonlyArray<ServerProvider>,
  options?: ProviderUpdateSidebarPillOptions,
): ProviderUpdateSidebarPillView | null {
  // Filter active instances before deduplicating drivers because update state is per instance.
  const activeProviders = dedupeProvidersByDriver(providers.filter(isProviderUpdateActive));
  if (activeProviders.length > 0) {
    const activeProvider = activeProviders[0]!;
    const activeProviderName =
      PROVIDER_DISPLAY_NAMES[activeProvider.driver] ?? activeProvider.driver;
    return {
      key: `loading:${activeProviders
        .map((provider) => `${provider.driver}:${provider.updateState?.status ?? "idle"}`)
        .toSorted()
        .join("|")}`,
      tone: "loading",
      title:
        activeProviders.length === 1
          ? `正在更新 ${activeProviderName}`
          : `正在更新 ${activeProviders.length} 项 CLI`,
      description: `${formatProviderList(activeProviders)} 正在更新。`,
    };
  }

  const recentTerminalProviders = latestTerminalProvidersByDriver(
    providers.filter((provider) => isRecentTerminalProvider(provider, options?.visibleAfterIso)),
  );
  const terminalCandidates: ProviderUpdateSidebarPillView[] = [];

  const failedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "failed",
  );
  if (failedProviders.length > 0) {
    const failedProvider = failedProviders[0]!;
    terminalCandidates.push({
      key: `failed:${failedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "error",
      title:
        failedProviders.length === 1
          ? getProviderFailedUpdateTitle(failedProvider)
          : `${failedProviders.length} 项 CLI 更新失败`,
      description: getFailedProviderUpdateDescription(failedProviders),
      dismissible: true,
    });
  }

  const unchangedProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "unchanged",
  );
  if (unchangedProviders.length > 0) {
    const unchangedProvider = unchangedProviders[0]!;
    const unchangedProviderName =
      PROVIDER_DISPLAY_NAMES[unchangedProvider.driver] ?? unchangedProvider.driver;
    terminalCandidates.push({
      key: `unchanged:${unchangedProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "warning",
      title:
        unchangedProviders.length === 1
          ? `${unchangedProviderName} 仍需更新`
          : `${unchangedProviders.length} 项 CLI 仍需更新`,
      description: `${formatProviderList(unchangedProviders)} 仍为旧版，请在供应商设置中查看详情。`,
      dismissible: true,
    });
  }

  const succeededProviders = recentTerminalProviders.filter(
    (provider) => provider.updateState?.status === "succeeded",
  );
  if (succeededProviders.length > 0) {
    const succeededProvider = succeededProviders[0]!;
    terminalCandidates.push({
      key: `succeeded:${succeededProviders
        .map(
          (provider) =>
            `${provider.driver}:${provider.updateState?.finishedAt ?? "pending"}:${provider.updateState?.message ?? ""}`,
        )
        .toSorted()
        .join("|")}`,
      tone: "success",
      title:
        succeededProviders.length === 1
          ? getProviderUpdatedTitle(succeededProvider)
          : `已更新 ${succeededProviders.length} 项 CLI`,
      description:
        [...new Set(succeededProviders.map(getProviderRestartNotice).filter(Boolean))].join("\n") ||
        providerUpdatedDescription,
      dismissAfterVisibleMs: PROVIDER_UPDATE_SUCCESS_VISIBLE_MS,
    });
  }

  return (
    terminalCandidates
      .toSorted((left, right) => {
        const leftProviders =
          left.tone === "error"
            ? failedProviders
            : left.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        const rightProviders =
          right.tone === "error"
            ? failedProviders
            : right.tone === "warning"
              ? unchangedProviders
              : succeededProviders;
        const leftFinishedAt = latestFinishedAtForProviders(leftProviders) ?? "";
        const rightFinishedAt = latestFinishedAtForProviders(rightProviders) ?? "";
        return rightFinishedAt.localeCompare(leftFinishedAt);
      })
      .find((candidate) => !options?.dismissedKeys?.has(candidate.key)) ?? null
  );
}

function getFailedProviderUpdateDescription(providers: ReadonlyArray<ServerProvider>): string {
  if (providers.length === 1) {
    const provider = providers[0]!;
    if (provider.updateState?.message) {
      return formatProviderMaintenanceMessage(provider.updateState.message);
    }
  }
  return `${formatProviderList(providers)} 更新失败，请在供应商设置中查看详情。`;
}
