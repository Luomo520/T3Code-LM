import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  managedUpdatesDenial,
  type DesktopUpdateState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import { resolveForkUpdateTarget } from "@t3tools/shared/forkRelease";

import { useEnvironment, type EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { environmentSession, useEnvironmentScope } from "~/state/session";
import { resolveServerSelfUpdateCapability, supportsDesktopAppUpdate } from "~/versionSkew";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

const unknownConfigAtom = serverEnvironment.configValueAtom(null);

export function useServerVersionUpdate(
  environment: EnvironmentPresentation | null,
  lookupEnabled = true,
) {
  const environmentId = environment?.environmentId ?? null;
  const serverConfig = environment?.serverConfig;
  const sessionConfig = useAtomValue(
    environmentId === null
      ? unknownConfigAtom
      : environmentSession.initialConfigValueAtom(environmentId),
  );
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const denial = managedUpdatesDenial(serverConfig?.managedPolicy);
  const selfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const desktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const canInstall = selfUpdate !== null && (selfUpdate !== "desktop-managed" || desktopAppUpdate);
  const connected = environment?.entry.enabled && environment.connection.phase === "connected";
  const canCheck = connected && canMaintain && denial === undefined;
  const supportsLookup =
    lookupEnabled && serverConfig?.environment.capabilities.npmReleaseLookup === true;
  const lookup = useEnvironmentQuery(
    environmentId !== null && connected && canRead && supportsLookup
      ? serverEnvironment.npmRelease({ environmentId, input: { spec: "latest" } })
      : null,
  );
  const runningVersion = connected ? sessionConfig?.environment.serverVersion : undefined;
  const deviceName =
    sessionConfig?.environment.label ?? serverConfig?.environment.label ?? environment?.label;
  const release =
    lookup.isSuccess && runningVersion
      ? resolveForkUpdateTarget(runningVersion, lookup.data?.version ?? null)
      : null;
  const targetVersion = release?.targetVersion ?? null;
  return {
    state,
    runningVersion,
    serverVersion: serverConfig?.environment.serverVersion,
    deviceName,
    lookup,
    release,
    target:
      targetVersion === null || environment === null
        ? null
        : {
            environmentId: environment.environmentId,
            serverLabel: deviceName ?? environment.label,
            selfUpdate,
            installation: serverConfig?.environment.capabilities.serverInstallation,
            desktopAppUpdate,
            targetVersion,
          },
    canCheck,
    denial,
    canInstall,
    manual:
      canCheck &&
      (!supportsLookup ||
        !canRead ||
        release?.manualCheckRequired ||
        (!canInstall && targetVersion !== null)),
  };
}

export function ServerVersionUpdateControl({
  update,
  label = "更新服务端",
}: {
  readonly update: ReturnType<typeof useServerVersionUpdate>;
  readonly label?: string;
}) {
  if (update.state.status === "running" || !update.canCheck) return null;
  if (update.target && update.canInstall) {
    return (
      <ServerUpdateAction
        {...update.target}
        size="sm"
        confirmServerRestart
        label={update.state.status === "failed" ? "重试更新服务端" : label}
      />
    );
  }
  if (update.manual) {
    return (
      <Button
        size="sm"
        variant="outline"
        render={<a href={CLI_RELEASES_PAGE_URL} target="_blank" rel="noreferrer noopener" />}
      >
        查看发布包
      </Button>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={update.lookup.isPending}
      onClick={update.lookup.refresh}
    >
      {update.lookup.isPending ? "正在检查…" : "检查服务端更新"}
    </Button>
  );
}

export function ServerVersionUpdateStatus({
  update,
  showAvailability = false,
}: {
  readonly update: ReturnType<typeof useServerVersionUpdate>;
  readonly showAvailability?: boolean;
}) {
  if (showAvailability) {
    const version =
      update.state.status === "running" ? update.state.targetVersion : update.target?.targetVersion;
    return (
      <>
        <p>
          可更新版本{" "}
          {version ??
            (update.release !== null && !update.release.manualCheckRequired
              ? "无，已是最新版本"
              : update.lookup.isPending
                ? "正在检查"
                : "未确认")}
        </p>
        {update.state.status !== "idle" ? <ServerUpdateProgress state={update.state} /> : null}
        {update.denial ? <p>{update.denial}</p> : null}
        {update.lookup.error ? <p role="alert">{update.lookup.error}</p> : null}
      </>
    );
  }
  if (update.state.status !== "idle") return <ServerUpdateProgress state={update.state} />;
  if (update.denial) return <p>{update.denial}</p>;
  if (update.lookup.error) return <p role="alert">{update.lookup.error}</p>;
  if (update.target) return <p>{`可更新至 ${update.target.targetVersion}`}</p>;
  if (update.canCheck && update.release !== null && !update.release.manualCheckRequired) {
    return <p>已是最新版本</p>;
  }
  return null;
}

export function ServerVersionUpdateRow({
  environmentId,
  servesWeb = false,
  bundledDesktop,
}: {
  readonly environmentId: EnvironmentId;
  readonly servesWeb?: boolean;
  readonly bundledDesktop?: { readonly updateState: DesktopUpdateState | null };
}) {
  const environment = useEnvironment(environmentId);
  return environment ? (
    <ConnectedServerVersionUpdateRow
      environment={environment}
      servesWeb={servesWeb}
      bundledDesktop={bundledDesktop}
    />
  ) : null;
}

function ConnectedServerVersionUpdateRow({
  environment,
  servesWeb,
  bundledDesktop,
}: {
  readonly environment: EnvironmentPresentation;
  readonly servesWeb: boolean;
  readonly bundledDesktop: { readonly updateState: DesktopUpdateState | null } | undefined;
}) {
  const bundled =
    bundledDesktop !== undefined &&
    (environment.serverConfig === null ||
      resolveServerSelfUpdateCapability(environment.serverConfig) === "desktop-managed");
  const update = useServerVersionUpdate(environment, !bundled);
  const deviceName = update.deviceName ?? environment.label;
  const lastVersion = update.serverVersion;
  const connectionLabel =
    environment.connection.phase !== "connected"
      ? "连接后可检查和更新服务端。"
      : !bundled && !update.canCheck && !update.denial
        ? "当前连接没有维护权限。"
        : null;
  return (
    <SettingsRow
      title={deviceName === environment.label ? deviceName : `${deviceName} · ${environment.label}`}
      description={[
        update.runningVersion
          ? `运行版本 ${update.runningVersion}`
          : `运行版本未确认${lastVersion ? `（上次连接 ${lastVersion}）` : ""}`,
        bundled ? "随本机 PC 客户端更新。" : null,
        servesWeb ? "更新此服务端及其提供的网页。" : null,
        update.state.status !== "running" ? connectionLabel : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      status={
        bundled ? (
          <p>可更新版本 {desktopUpdateAvailability(bundledDesktop.updateState)}</p>
        ) : (
          <ServerVersionUpdateStatus update={update} showAvailability />
        )
      }
      control={
        bundled ? null : (
          <ServerVersionUpdateControl
            update={update}
            label={servesWeb ? "更新此服务端" : "更新服务端"}
          />
        )
      }
    />
  );
}

export function desktopUpdateAvailability(state: DesktopUpdateState | null) {
  return (
    state?.downloadedVersion ??
    state?.availableVersion ??
    (state?.status === "up-to-date"
      ? "无，已是最新版本"
      : state?.status === "checking"
        ? "正在检查"
        : "未确认")
  );
}
