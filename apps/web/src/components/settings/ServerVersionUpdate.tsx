import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  managedUpdatesDenial,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import { resolveForkUpdateTarget } from "@t3tools/shared/forkRelease";

import { useEnvironment, type EnvironmentPresentation } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { resolveServerSelfUpdateCapability, supportsDesktopAppUpdate } from "~/versionSkew";
import { ServerUpdateAction, ServerUpdateProgress } from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function useServerVersionUpdate(environment: EnvironmentPresentation) {
  const { environmentId, serverConfig, connection, entry } = environment;
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const denial = managedUpdatesDenial(serverConfig?.managedPolicy);
  const selfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const desktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const canInstall = selfUpdate !== null && (selfUpdate !== "desktop-managed" || desktopAppUpdate);
  const connected = entry.enabled && connection.phase === "connected";
  const canCheck = connected && canMaintain && denial === undefined;
  const supportsLookup = serverConfig?.environment.capabilities.npmReleaseLookup === true;
  const lookup = useEnvironmentQuery(
    canCheck && supportsLookup
      ? serverEnvironment.npmRelease({ environmentId, input: { spec: "latest" } })
      : null,
  );
  const serverVersion = serverConfig?.environment.serverVersion;
  const release =
    lookup.isSuccess && serverVersion
      ? resolveForkUpdateTarget(serverVersion, lookup.data?.version ?? null)
      : null;
  const targetVersion = release?.targetVersion ?? null;
  return {
    state,
    serverVersion,
    lookup,
    target:
      targetVersion === null
        ? null
        : {
            environmentId,
            serverLabel: environment.label,
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
      (!supportsLookup || release?.manualCheckRequired || (!canInstall && targetVersion !== null)),
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
}: {
  readonly update: ReturnType<typeof useServerVersionUpdate>;
}) {
  if (update.state.status !== "idle") return <ServerUpdateProgress state={update.state} />;
  if (update.denial) return <p>{update.denial}</p>;
  if (update.lookup.error) return <p role="alert">{update.lookup.error}</p>;
  if (update.target) return <p>{`可更新至 ${update.target.targetVersion}`}</p>;
  if (update.canCheck && update.lookup.isSuccess && !update.manual) return <p>已是最新版本</p>;
  return null;
}

export function ServerVersionUpdateRow({
  environmentId,
  servesWeb = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly servesWeb?: boolean;
}) {
  const environment = useEnvironment(environmentId);
  return environment ? (
    <ConnectedServerVersionUpdateRow environment={environment} servesWeb={servesWeb} />
  ) : null;
}

function ConnectedServerVersionUpdateRow({
  environment,
  servesWeb,
}: {
  readonly environment: EnvironmentPresentation;
  readonly servesWeb: boolean;
}) {
  const update = useServerVersionUpdate(environment);
  const connectionLabel =
    environment.connection.phase !== "connected"
      ? "连接后可检查和更新服务端。"
      : !update.canCheck && !update.denial
        ? "当前连接没有维护权限。"
        : null;
  return (
    <SettingsRow
      title={environment.label}
      description={[
        update.serverVersion ? `版本 ${update.serverVersion}` : null,
        servesWeb ? "更新此服务端及其提供的网页。" : null,
        update.state.status !== "running" ? connectionLabel : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      status={<ServerVersionUpdateStatus update={update} />}
      control={
        <ServerVersionUpdateControl
          update={update}
          label={servesWeb ? "更新此服务端" : "更新服务端"}
        />
      }
    />
  );
}
