import { useAtomValue } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  managedUpdatesDenial,
} from "@t3tools/contracts";
import { serverUpdateDownloadPercent } from "@t3tools/client-runtime/state/server";
import { resolveForkUpdateTarget } from "@t3tools/shared/forkRelease";
import { AsyncResult } from "effect/reactivity";
import { Linking, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { Progress } from "../../../components/ui/Progress";
import { useEnvironmentQuery } from "../../../state/query";
import type { ConnectedEnvironmentSummary } from "../../../state/remote-runtime-types";
import { serverEnvironment } from "../../../state/server";
import {
  environmentSession,
  readEnvironmentScope,
  useEnvironmentScope,
} from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  ENVIRONMENT_RELEASES_PAGE_URL,
  supportsEnvironmentUpdate,
} from "../environment-maintenance";

export function EnvironmentServerUpdateRows({
  environment,
  compact = false,
}: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly compact?: boolean;
}) {
  const { environmentId, environmentLabel } = environment;
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const sessionConfig = useAtomValue(environmentSession.initialConfigValueAtom(environmentId));
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const canMaintain = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const update = useAtomCommand(serverEnvironment.updateServer, { reportFailure: false });
  const connected = environment.isEnabled && environment.connectionState === "connected";
  const denial = managedUpdatesDenial(config?.managedPolicy);
  const canCheck = connected && canMaintain && denial === undefined;
  const runningVersion = connected ? sessionConfig?.environment.serverVersion : undefined;
  const lastVersion = config?.environment.serverVersion;
  const deviceName =
    sessionConfig?.environment.label ?? config?.environment.label ?? environmentLabel;
  const capabilities = config?.environment.capabilities;
  const supportsLookup = capabilities?.npmReleaseLookup === true;
  const canInstall = capabilities !== undefined && supportsEnvironmentUpdate(capabilities);
  const releaseQuery = useEnvironmentQuery(
    connected && canRead && supportsLookup
      ? serverEnvironment.npmRelease({ environmentId, input: { spec: "latest" } })
      : null,
  );
  const release =
    releaseQuery.isSuccess && runningVersion
      ? resolveForkUpdateTarget(runningVersion, releaseQuery.data?.version ?? null)
      : null;
  const targetVersion = release?.targetVersion ?? null;
  const manual =
    canCheck &&
    (!supportsLookup ||
      !canRead ||
      release?.manualCheckRequired ||
      (!canInstall && targetVersion !== null));
  const running = state.status === "running";
  const providerBusy =
    config?.providers.some(
      (provider) =>
        provider.updateState?.status === "running" || provider.updateState?.status === "queued",
    ) ?? false;
  const percent = state.status === "running" ? serverUpdateDownloadPercent(state) : undefined;
  if (compact && state.status === "idle" && targetVersion === null) return null;

  function requestUpdate() {
    if (!canCheck || !canInstall || targetVersion === null || running || providerBusy) return;
    Dialog.confirm({
      title: `更新 ${deviceName}？`,
      message: `安装 T3 Code ${targetVersion}。${capabilities?.serverSelfUpdate === "desktop-managed" ? "桌面应用将关闭并重新启动。" : "服务端将重启并重新连接。"}正在运行的会话可能会中断。`,
      confirmText: "更新服务端",
      onConfirm: () => {
        if (!readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope)) return;
        void update({ environmentId, input: { targetVersion } }).then((result) => {
          if (AsyncResult.isSuccess(result)) {
            Dialog.alert("服务端已更新", `${deviceName} 已更新至 ${result.value.targetVersion}。`);
          }
        });
      },
    });
  }

  const description =
    denial ??
    (!connected ? "连接后可检查和更新服务端。" : !canMaintain ? "当前连接没有维护权限。" : null);
  const availableVersion =
    state.status === "running"
      ? state.targetVersion
      : (targetVersion ??
        (releaseQuery.isPending
          ? "正在检查"
          : release !== null && !release.manualCheckRequired
            ? "无，已是最新版本"
            : "未确认"));

  return (
    <>
      {!compact || state.status !== "idle" ? (
        <View className="gap-1 px-4 py-3">
          {!compact ? (
            <>
              <Text className="text-base text-foreground">
                {deviceName === environmentLabel
                  ? deviceName
                  : `${deviceName} · ${environmentLabel}`}
              </Text>
              <Text className="text-sm text-foreground-muted">
                {runningVersion
                  ? `运行版本 ${runningVersion}`
                  : `运行版本未确认${lastVersion ? `（上次连接 ${lastVersion}）` : ""}`}
              </Text>
              <Text className="text-sm text-foreground-muted">可更新版本 {availableVersion}</Text>
            </>
          ) : null}
          {state.status === "running" ? (
            <>
              <Text className="text-sm text-foreground-muted">
                {state.stage === "resuming"
                  ? "正在重启并重新连接…"
                  : state.stage === "installing"
                    ? "正在安装更新…"
                    : `正在下载服务端更新…${percent === undefined ? "" : ` ${Math.floor(percent)}%`}`}
              </Text>
              {state.stage === "downloading" ? (
                <Progress
                  className="mt-1"
                  label={`${deviceName} 服务端更新下载进度`}
                  {...(percent === undefined ? {} : { value: percent / 100 })}
                />
              ) : null}
            </>
          ) : state.status === "failed" || releaseQuery.error ? (
            <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
              {state.status === "failed" ? state.message : releaseQuery.error}
            </Text>
          ) : description ? (
            <Text className="text-sm text-foreground-muted">{description}</Text>
          ) : null}
        </View>
      ) : null}
      {!running && canCheck ? (
        targetVersion !== null && canInstall ? (
          <ListActionRow
            icon="arrow.up.circle"
            label={state.status === "failed" ? "重试更新服务端" : "更新服务端"}
            description={
              providerBusy
                ? "服务提供方正在更新，完成后可更新服务端。"
                : compact && runningVersion
                  ? `${runningVersion} → ${targetVersion}`
                  : undefined
            }
            disabled={providerBusy}
            onPress={requestUpdate}
          />
        ) : manual ? (
          <ListActionRow
            icon="arrow.up.right"
            label="查看发布包"
            onPress={() =>
              void Linking.openURL(ENVIRONMENT_RELEASES_PAGE_URL).catch(() =>
                Dialog.alert("无法打开发布页", "请检查网络后重试。"),
              )
            }
          />
        ) : !compact ? (
          <ListActionRow
            icon="arrow.clockwise"
            label={releaseQuery.isPending ? "正在检查…" : "检查服务端更新"}
            loading={releaseQuery.isPending}
            onPress={releaseQuery.refresh}
          />
        ) : null
      ) : null}
    </>
  );
}
