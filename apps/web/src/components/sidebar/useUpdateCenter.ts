import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  managedUpdatesDenial,
  PROVIDER_DISPLAY_NAMES,
  type DesktopUpdateState,
  type EnvironmentId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { formatProviderMaintenanceMessage } from "@t3tools/client-runtime/providerUpdates";
import { crossesReleaseTrack } from "@t3tools/shared/cliRelease";
import { resolveForkUpdateTarget, type ForkUpdateChannel } from "@t3tools/shared/forkRelease";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";

import { APP_VERSION, DESKTOP_APP_VERSION, DESKTOP_DEVICE_NAME } from "~/branding";
import { isElectron } from "~/env";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { useEnvironmentProviders, useEnvironments } from "~/state/environments";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentSession, useEnvironmentsWithScope } from "~/state/session";
import { resolveServerSelfUpdateCapability, supportsDesktopAppUpdate } from "~/versionSkew";
import {
  canCheckForUpdate,
  getDesktopUpdateDownloadedVersion,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { providerUpdateId, useCheckProviderUpdates } from "../ProviderUpdatesAction";
import { serverUpdateStageLabel, type ServerUpdateTarget } from "../ServerUpdateAction";
import {
  desktopUpdateId,
  useIsHostedByThisApp,
  serverUpdateId,
  useUpdateEverything,
} from "./useUpdateEverything";
import { downloadLocalUpdate, installLocalUpdate } from "./desktopUpdateActions";

const updateChannelSchema = Schema.Literals(["stable", "beta"]);
const releaseAtom = (environmentId: EnvironmentId, channel: ForkUpdateChannel) =>
  serverEnvironment.npmRelease({
    environmentId,
    input: { spec: channel === "beta" ? "beta" : "latest" },
  });
const releaseAtoms = {
  stable: environmentAtomList("update-center-releases:stable", (id) => releaseAtom(id, "stable")),
  beta: environmentAtomList("update-center-releases:beta", (id) => releaseAtom(id, "beta")),
};
const liveConfigsAtom = environmentAtomList(
  "update-center-versions",
  environmentSession.initialConfigValueAtom,
);

const localDeviceId = "this-computer";

export interface UpdateCenterItem {
  readonly id: string;
  readonly name: string;
  readonly current: string | null;
  readonly target: string | null;
  readonly selectable: boolean;
  readonly remoteDesktopUpdate?: "confirmed-version" | "reference-version";
  readonly detail?: string;
  readonly error?: string;
}

export interface UpdateCenterDevice {
  readonly id: string;
  readonly name: string;
  readonly local: boolean;
  readonly items: ReadonlyArray<UpdateCenterItem>;
  readonly restartEnvironments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly continuesThreads: boolean;
    readonly canReadThreads: boolean;
  }>;
}

export function updateCenterProviderName(driver: ProviderDriverKind) {
  if (driver === ProviderDriverKind.make("codex")) return "Codex CLI";
  if (driver === ProviderDriverKind.make("claudeAgent")) return "Claude Code";
  return PROVIDER_DISPLAY_NAMES[driver] ?? driver;
}

function desktopStatus(state: DesktopUpdateState | null): string {
  switch (state?.status) {
    case "checking":
      return "正在检查更新…";
    case "downloading":
      return state.downloadPercent === null
        ? "正在下载更新…"
        : `正在下载更新… ${Math.floor(state.downloadPercent)}%`;
    case "up-to-date":
      return "已是最新版本";
    case "error":
      return "更新失败";
    default:
      return "未确认可更新版本";
  }
}

export function useUpdateCenter() {
  const [storedChannel, storeChannel] = useLocalStorage(
    "t3code:fork-update-channel",
    "stable",
    updateChannelSchema,
  );
  const isHostedByThisApp = useIsHostedByThisApp();
  const desktopState = useDesktopUpdateState();
  const desktopDenial = managedUpdatesDenial(usePrimaryManagedPolicy());
  const managedDesktop = isElectron && typeof window !== "undefined" && window.desktopBridge;
  const channel =
    managedDesktop && desktopState
      ? desktopState.channel === "beta"
        ? "beta"
        : "stable"
      : storedChannel;
  const desktopAction = desktopState ? resolveDesktopUpdateButtonAction(desktopState) : "none";
  const desktopTarget =
    managedDesktop &&
    desktopState &&
    desktopState.channel === (channel === "stable" ? "latest" : "beta") &&
    !desktopDenial &&
    desktopAction !== "none"
      ? getDesktopUpdateDownloadedVersion(desktopState)
      : null;

  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.entry.enabled && environment.connection.phase === "connected",
  );
  const canRead = useEnvironmentsWithScope(connected, AuthOrchestrationReadScope);
  const canMaintain = useEnvironmentsWithScope(connected, AuthEnvironmentMaintainScope);
  const canManageProviders = useEnvironmentsWithScope(connected, AuthProvidersManageScope);
  const lookupIds = connected
    .filter(
      (environment) =>
        !isHostedByThisApp(environment) &&
        canRead.has(environment.environmentId) &&
        environment.serverConfig?.environment.capabilities.npmReleaseLookup === true,
    )
    .map(({ environmentId }) => environmentId);
  const releases = useAtomValue(releaseAtoms[channel](environmentIdsKey(lookupIds)));
  const connectedKey = environmentIdsKey(connected.map(({ environmentId }) => environmentId));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(connectedKey));
  const liveConfigs = useAtomValue(liveConfigsAtom(connectedKey));
  const versions = new Map(lookupIds.map((id, index) => [id, releases[index]!] as const));
  const serverTargets: ServerUpdateTarget[] = [];
  const devices = new Map(
    connected.map((environment, index) => {
      const { environmentId, serverConfig } = environment;
      const local = isHostedByThisApp(environment);
      const live = liveConfigs[index];
      const runningVersion = live?.environment.serverVersion ?? null;
      const label = live?.environment.label ?? serverConfig?.environment.label ?? environment.label;
      const release = versions.get(environmentId);
      const state = updateStates[index]!;
      const selfUpdate = resolveServerSelfUpdateCapability(serverConfig);
      const desktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
      const confirmedDesktopVersion =
        selfUpdate === "desktop-managed" &&
        serverConfig?.environment.capabilities.confirmedDesktopUpdateVersion === true;
      const canInstall =
        selfUpdate !== null && (selfUpdate !== "desktop-managed" || desktopAppUpdate);
      const denial = managedUpdatesDenial(serverConfig?.managedPolicy);
      const offered =
        runningVersion && release?._tag === "Success"
          ? resolveForkUpdateTarget(runningVersion, release.value?.version ?? null)
          : null;
      const target = local
        ? desktopTarget
        : state.status === "running"
          ? state.targetVersion
          : (offered?.targetVersion ?? null);
      const trackMismatch =
        runningVersion !== null && target !== null && crossesReleaseTrack(runningVersion, target);
      const selectable =
        !local &&
        target !== null &&
        canMaintain.has(environmentId) &&
        canInstall &&
        !denial &&
        !trackMismatch &&
        state.status !== "running";
      if (selectable) {
        serverTargets.push({
          environmentId,
          serverLabel: label,
          selfUpdate,
          desktopAppUpdate,
          installation: serverConfig?.environment.capabilities.serverInstallation,
          targetVersion: target,
          ...(confirmedDesktopVersion ? { requireConfirmedDesktopVersion: true } : {}),
        });
      }
      let detail: string | undefined;
      if (local) detail = "随本机 T3 桌面端更新";
      else if (state.status === "running") detail = serverUpdateStageLabel(state.stage);
      else if (state.status === "failed") detail = "服务端更新失败";
      else if (denial) detail = "组织策略限制更新";
      else if (!canMaintain.has(environmentId)) detail = "当前连接没有维护权限";
      else if (release?.waiting) detail = "正在检查更新…";
      else if (release?._tag === "Failure") detail = "无法检查服务端更新";
      else if (trackMismatch || offered?.manualCheckRequired || !canInstall) {
        detail = "需要在环境页查看更新方式";
      } else if (offered === null) detail = "可更新版本未确认";
      else if (offered.targetVersion === null) detail = "已是最新版本";
      const item: UpdateCenterItem = {
        id: serverUpdateId(environmentId),
        name: selfUpdate === "desktop-managed" && !local ? "T3 桌面端与服务端" : "T3 服务端",
        current: runningVersion,
        target,
        selectable,
        ...(selfUpdate === "desktop-managed" && !local
          ? {
              remoteDesktopUpdate: confirmedDesktopVersion
                ? "confirmed-version"
                : "reference-version",
            }
          : {}),
        ...(detail ? { detail } : {}),
        ...(state.status === "failed" ? { error: state.message } : {}),
      };
      return [
        environmentId,
        {
          local,
          label,
          items:
            local || canRead.has(environmentId) || canMaintain.has(environmentId) ? [item] : [],
          environment,
        },
      ] as const;
    }),
  );
  const everything = useUpdateEverything(desktopTarget, undefined, serverTargets);
  const providers = useEnvironmentProviders();
  const localItems: UpdateCenterItem[] = [];
  const remoteDevices: UpdateCenterDevice[] = [];
  const localRestarts: UpdateCenterDevice["restartEnvironments"][number][] = environments
    .filter(
      (environment) =>
        environment.entry.enabled &&
        environment.connection.phase !== "connected" &&
        isHostedByThisApp(environment),
    )
    .map(({ environmentId }) => ({
      environmentId,
      continuesThreads: false,
      canReadThreads: false,
    }));
  const multipleLocalEnvironments = connected.filter(isHostedByThisApp).length > 1;
  const providerMachines = new Map(
    everything.providerMachines.map((machine) => [machine.environmentId, machine.candidates]),
  );
  if (managedDesktop) {
    localItems.push({
      id: desktopUpdateId,
      name: "T3 桌面端",
      current: DESKTOP_APP_VERSION ?? desktopState?.currentVersion ?? APP_VERSION,
      target: desktopTarget,
      selectable: desktopTarget !== null,
      ...(desktopTarget === null
        ? { detail: desktopDenial ? "组织策略限制更新" : desktopStatus(desktopState) }
        : {}),
      ...(desktopState?.status === "error" && desktopState.message
        ? { error: desktopState.message }
        : {}),
    });
  }
  for (const [environmentId, { local, label, items, environment }] of devices) {
    if (canRead.has(environmentId) || canManageProviders.has(environmentId)) {
      const candidates = providerMachines.get(environmentId) ?? [];
      const allProviders = providers.get(environmentId) ?? [];
      const drivers = new Set([
        ...candidates.map(({ driver }) => driver),
        ...allProviders
          .filter(({ enabled, installed }) => enabled && installed)
          .map(({ driver }) => driver),
      ]);
      for (const driver of drivers) {
        const candidate = candidates.find((provider) => provider.driver === driver);
        const installed =
          candidate ??
          allProviders.find(
            (provider) => provider.driver === driver && provider.enabled && provider.installed,
          );
        if (!installed) continue;
        const target = installed.versionAdvisory?.latestVersion ?? null;
        const active =
          installed.updateState?.status === "running" || installed.updateState?.status === "queued";
        const latest = installed.versionAdvisory?.status === "behind_latest" ? target : null;
        const detail = active
          ? "正在更新…"
          : !canManageProviders.has(environmentId)
            ? "当前连接没有 CLI 管理权限"
            : latest && candidate === undefined
              ? "需手动更新"
              : target === null || installed.versionAdvisory?.status === "unknown"
                ? "可更新版本未确认"
                : latest === null
                  ? "已是最新版本"
                  : undefined;
        const error =
          installed.updateState?.status === "failed" ? installed.updateState.message : null;
        items.push({
          id: providerUpdateId(environmentId, installed),
          name: updateCenterProviderName(driver),
          current: installed.version,
          target: latest,
          selectable: canManageProviders.has(environmentId) && candidate !== undefined && !active,
          ...(detail ? { detail } : {}),
          ...(error ? { error: formatProviderMaintenanceMessage(error) } : {}),
        });
      }
    }
    const restart = {
      environmentId,
      continuesThreads:
        environment.serverConfig?.settings.continueThreadsAfterServerUpdate === true,
      canReadThreads: canRead.has(environmentId),
    };
    if (local) {
      localRestarts.push(restart);
      localItems.push(
        ...(multipleLocalEnvironments
          ? items.map((item) => ({ ...item, name: `${item.name} · ${label}` }))
          : items),
      );
    } else if (items.length > 0) {
      remoteDevices.push({
        id: environmentId,
        name: label,
        local: false,
        items,
        restartEnvironments: [restart],
      });
    }
  }
  const groups: UpdateCenterDevice[] = [
    ...(localItems.length > 0
      ? [
          {
            id: localDeviceId,
            name: DESKTOP_DEVICE_NAME ?? "此电脑",
            local: true,
            items: localItems,
            restartEnvironments: localRestarts,
          },
        ]
      : []),
    ...remoteDevices,
  ];
  const checkProviders = useCheckProviderUpdates();
  const check = async () => {
    for (const id of lookupIds) appAtomRegistry.refresh(releaseAtom(id, channel));
    const bridge = window.desktopBridge;
    const promises = await Promise.allSettled([
      checkProviders({ quiet: true }).then((failures) => {
        if (failures.length) throw new Error(failures.join("\n"));
      }),
      ...(managedDesktop && bridge && !desktopDenial && canCheckForUpdate(desktopState)
        ? [
            bridge.checkForUpdate().then((result) => {
              if (!result.checked) throw new Error(result.state.message ?? "无法检查桌面端更新。");
            }),
          ]
        : []),
    ]);
    const failure = promises.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  };

  const setChannel = async (next: ForkUpdateChannel) => {
    const bridge = window.desktopBridge;
    if (managedDesktop && bridge && !desktopDenial) {
      const requested = next === "beta" ? "beta" : "latest";
      const state = await bridge.setUpdateChannel(requested);
      if (state.channel !== requested) throw new Error("此桌面版本无法切换更新通道。");
    }
    storeChannel(next);
  };

  return {
    channel,
    setChannel,
    desktopState: managedDesktop ? desktopState : null,
    groups,
    check,
    canCheck:
      lookupIds.length > 0 ||
      canManageProviders.size > 0 ||
      Boolean(managedDesktop && !desktopDenial && canCheckForUpdate(desktopState)),
    checking: releases.some((release) => release.waiting) || desktopState?.status === "checking",
    run: (selected: ReadonlySet<string>) => {
      const bridge = window.desktopBridge;
      const expected = desktopTarget;
      const includeDesktop = selected.has(desktopUpdateId) && managedDesktop && bridge && expected;
      return everything.run({
        selection: selected,
        ...(includeDesktop && desktopAction === "download"
          ? {
              downloadLocal: (reportError) =>
                downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
            }
          : {}),
        ...(includeDesktop
          ? { installLocal: (reportError) => installLocalUpdate(bridge, reportError, expected) }
          : {}),
      });
    },
  };
}
