import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  managedUpdatesDenial,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  isProviderUpdateActive,
} from "@t3tools/client-runtime/providerUpdates";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { resolveForkUpdateTarget, type ForkUpdateChannel } from "@t3tools/shared/forkRelease";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../../state/server";
import { environmentSession, sessionHasScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { workspaceConnections } from "../../state/workspace";
import type { AndroidUpdateAsset } from "./androidAppUpdate";
import { supportsEnvironmentUpdate } from "./environment-maintenance";

interface UpdateChoiceBase {
  readonly key: string;
  readonly label: string;
  readonly device: string;
  readonly fromVersion: string;
  readonly targetVersion: string;
}

export interface AppUpdateChoice extends UpdateChoiceBase {
  readonly kind: "app";
  readonly asset: AndroidUpdateAsset;
}

export interface ServerUpdateChoice extends UpdateChoiceBase {
  readonly kind: "server";
  readonly environmentId: EnvironmentId;
  readonly desktopManaged: boolean;
  readonly confirmedDesktopUpdateVersion: boolean;
  readonly activeSessions: number | null;
}

export interface CliUpdateChoice extends UpdateChoiceBase {
  readonly kind: "cli";
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}

export type RemoteUpdateChoice = ServerUpdateChoice | CliUpdateChoice;
export type UpdateChoice = AppUpdateChoice | RemoteUpdateChoice;

function activeSessionCount(shell: EnvironmentShellState): number | null {
  if (shell.status !== "live" || Option.isNone(shell.snapshot)) return null;
  return shell.snapshot.value.threads.filter(
    (thread) =>
      thread.deletedAt == null &&
      (thread.activityRunStatus != null ||
        thread.status === "preparing" ||
        thread.status === "starting" ||
        thread.status === "running" ||
        thread.status === "waiting"),
  ).length;
}

function cliLabel(provider: ServerProvider): string {
  const product = provider.driver === "codex" ? "Codex CLI" : "Claude Code";
  const custom = provider.displayName?.trim();
  return custom && !["Codex", "Claude", product].includes(custom)
    ? `${product} · ${custom}`
    : product;
}

function makeRemoteUpdateDeviceAtom(environmentId: EnvironmentId, channel: ForkUpdateChannel) {
  return Atom.make((get) => {
    const environment = get(workspaceConnections.environmentsAtom).find(
      (entry) => entry.environmentId === environmentId && entry.isEnabled,
    );
    if (!environment) return null;
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const config = get(serverEnvironment.configValueAtom(environmentId));
    const initialConfig = get(environmentSession.initialConfigValueAtom(environmentId));
    const state = get(serverEnvironment.updateStateAtom(environmentId));
    const connected = environment.connectionState === "connected";
    const canRead = sessionHasScope(session, AuthOrchestrationReadScope);
    const canMaintain = sessionHasScope(session, AuthEnvironmentMaintainScope);
    const canManageProviders = sessionHasScope(session, AuthProvidersManageScope);
    const capabilities = config?.environment.capabilities;
    const device =
      initialConfig?.environment.label ?? config?.environment.label ?? environment.environmentLabel;
    const runningVersion = connected ? initialConfig?.environment.serverVersion : undefined;
    const lastVersion = config?.environment.serverVersion;
    const providers = config?.providers ?? [];
    const running = state.status === "running";
    const providerBusy = providers.some(isProviderUpdateActive);
    const supportsLookup = capabilities?.npmReleaseLookup === true;
    const canInstall = capabilities !== undefined && supportsEnvironmentUpdate(capabilities);
    const denied = managedUpdatesDenial(config?.managedPolicy) !== undefined;
    const releaseAtom =
      connected && canRead && supportsLookup && !denied
        ? serverEnvironment.npmRelease({
            environmentId,
            input: { spec: channel === "beta" ? "beta" : "latest" },
          })
        : null;
    const releaseResult = releaseAtom ? get(releaseAtom) : null;
    const releaseError =
      releaseResult?._tag === "Failure" ? Cause.squash(releaseResult.cause) : null;
    const release =
      releaseResult?._tag === "Success" && runningVersion
        ? resolveForkUpdateTarget(runningVersion, releaseResult.value?.version ?? null)
        : null;
    const targetVersion = release?.targetVersion ?? null;
    const shell = connected && canRead ? get(environmentShell.stateValueAtom(environmentId)) : null;
    const activeSessions = shell === null ? null : activeSessionCount(shell);
    const server: ServerUpdateChoice | null =
      connected &&
      canMaintain &&
      !denied &&
      canInstall &&
      !running &&
      !providerBusy &&
      runningVersion &&
      targetVersion
        ? {
            key: JSON.stringify([environmentId, "server"]),
            kind: "server",
            label: "T3 服务端",
            device,
            environmentId,
            fromVersion: runningVersion,
            targetVersion,
            desktopManaged: capabilities.serverSelfUpdate === "desktop-managed",
            confirmedDesktopUpdateVersion: capabilities.confirmedDesktopUpdateVersion === true,
            activeSessions,
          }
        : null;

    const candidates = new Map(
      collectProviderUpdateCandidates(providers).map((provider) => [provider.instanceId, provider]),
    );
    const cliRows = providers
      .filter(
        (provider) =>
          provider.enabled &&
          provider.installed &&
          (provider.driver === "codex" || provider.driver === "claudeAgent"),
      )
      .map((provider) => {
        const label = cliLabel(provider);
        const fromVersion = provider.installedVersion ?? provider.version ?? "未知";
        const target =
          provider.versionAdvisory?.status === "behind_latest"
            ? provider.versionAdvisory.latestVersion
            : null;
        const candidate = candidates.get(provider.instanceId);
        const choice: CliUpdateChoice | null =
          connected &&
          canManageProviders &&
          !running &&
          !providerBusy &&
          target &&
          candidate &&
          canOneClickUpdateProviderCandidate(candidate, providers)
            ? {
                key: JSON.stringify([environmentId, "cli", provider.instanceId]),
                kind: "cli",
                label,
                device,
                environmentId,
                driver: provider.driver,
                instanceId: provider.instanceId,
                fromVersion,
                targetVersion: target,
              }
            : null;
        return { provider, label, fromVersion, target, choice };
      });
    return {
      environmentId,
      device,
      connected,
      state,
      server,
      runningVersion,
      lastVersion,
      cliRows,
      activeSessions,
      canManageProviders,
      providerBusy,
      releaseAtom,
      releaseError,
      releaseChecking: releaseResult?.waiting === true,
      targetVersion,
      upToDate:
        releaseResult?._tag === "Success" &&
        releaseResult.value?.version != null &&
        release !== null &&
        !release.manualCheckRequired &&
        targetVersion === null,
      manual:
        canMaintain &&
        !denied &&
        connected &&
        (!supportsLookup ||
          !canRead ||
          release?.manualCheckRequired === true ||
          (!canInstall && targetVersion !== null)),
      serverNote: denied
        ? "组织策略关闭了服务端更新。"
        : !connected
          ? "连接后可检查和更新此设备。"
          : !canMaintain
            ? "当前连接没有服务端维护权限。"
            : providerBusy
              ? "CLI 更新完成后可更新服务端。"
              : null,
    };
  });
}

export const remoteUpdateDeviceAtom = Atom.family((environmentId: EnvironmentId) =>
  makeRemoteUpdateDeviceAtom(environmentId, "stable"),
);
const betaRemoteUpdateDeviceAtom = Atom.family((environmentId: EnvironmentId) =>
  makeRemoteUpdateDeviceAtom(environmentId, "beta"),
);

export const remoteUpdateDevicesAtom = Atom.family((channel: ForkUpdateChannel) =>
  Atom.make((get) =>
    get(workspaceConnections.environmentsAtom).flatMap(({ environmentId, isEnabled }) => {
      const forEnvironment =
        channel === "beta" ? betaRemoteUpdateDeviceAtom : remoteUpdateDeviceAtom;
      const device = isEnabled ? get(forEnvironment(environmentId)) : null;
      return device ? [device] : [];
    }),
  ).pipe(Atom.withLabel(`mobile:remote-update-devices:${channel}`)),
);

export type RemoteUpdateDevice = Atom.Type<ReturnType<typeof remoteUpdateDevicesAtom>>[number];

export function remoteUpdateChoices(device: RemoteUpdateDevice): RemoteUpdateChoice[] {
  return [
    ...device.cliRows.flatMap(({ choice }) => (choice ? [choice] : [])),
    ...(device.server ? [device.server] : []),
  ];
}

export function matchesConfirmedUpdate(confirmed: UpdateChoice, current: UpdateChoice) {
  if (
    current.key !== confirmed.key ||
    current.fromVersion !== confirmed.fromVersion ||
    current.targetVersion !== confirmed.targetVersion
  )
    return false;
  if (confirmed.kind === "app" && current.kind === "app") {
    return confirmed.asset.sha256 === current.asset.sha256;
  }
  if (confirmed.kind === "server" && current.kind === "server") {
    if (
      confirmed.desktopManaged !== current.desktopManaged ||
      confirmed.confirmedDesktopUpdateVersion !== current.confirmedDesktopUpdateVersion
    )
      return false;
    return (
      confirmed.activeSessions === null ||
      (current.activeSessions !== null && current.activeSessions <= confirmed.activeSessions)
    );
  }
  return confirmed.kind === current.kind;
}

export function serverUpdateImpact(choice: ServerUpdateChoice): string {
  if (choice.desktopManaged) {
    const known =
      choice.activeSessions === null
        ? "此环境的活动会话数量未知。"
        : `此环境有 ${choice.activeSessions} 个活动会话。`;
    const version = choice.confirmedDesktopUpdateVersion
      ? ""
      : "旧版桌面端按设备更新源的实际可用版本安装，所示目标版本供参考。";
    return `远端 PC 的桌面应用和它托管的所有后端（含 WSL）将重启。${known}其他后端的会话数未知。重启后 App 会重新连接。${version}`;
  }
  const restart = "T3 服务端将重启。";
  const disruption =
    choice.activeSessions === null
      ? "目前无法确认运行中的会话数量，设备上的活动会话可能会中断。"
      : choice.activeSessions === 0
        ? "当前没有运行中的会话。"
        : `${choice.activeSessions} 个运行中的会话可能会中断。`;
  return `${restart}${disruption}恢复后 App 会自动重新连接，可打开会话检查状态。`;
}

export function providerUpdateResult(status: ServerProvider["updateState"] | undefined) {
  switch (status?.status) {
    case "queued":
      return "已排队，等待其他 CLI 更新完成。";
    case "running":
      return "正在更新，完成后会重新读取已安装版本。";
    case "succeeded":
      return "CLI 更新已完成。";
    case "failed":
      return "CLI 更新失败，可检查详情后重试。";
    case "unchanged":
      return "CLI 更新命令已完成，尚未确认版本改变。";
    default:
      return null;
  }
}
