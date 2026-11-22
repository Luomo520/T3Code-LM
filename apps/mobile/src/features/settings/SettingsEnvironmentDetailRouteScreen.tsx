import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthProvidersManageScope,
  PROVIDER_DISPLAY_NAMES,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatProviderMaintenanceMessage,
  isProviderUpdateActive,
} from "@t3tools/client-runtime/providerUpdates";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { Linking, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { providerUpdateResult } from "./updateCenter";
import { AppText as Text } from "../../components/ui/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { ConnectionEnvironmentRow } from "../connection/ConnectionEnvironmentRow";
import { EnvironmentRoutesSection } from "./EnvironmentRoutesSection";
import { OutdatedServerUpdateSection } from "./OutdatedServerUpdateSection";
import { EnvironmentServerUpdateRows } from "./components/EnvironmentServerUpdateRows";
import { HeaderUsageSettings } from "../usage/HeaderUsageSettings";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { canMaintainEnvironment, canUpdateEnvironmentProvider } from "./environment-maintenance";

export function SettingsEnvironmentDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
}>) {
  return (
    <EnvironmentDetail
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentDetail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const connections = useRemoteConnections();
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const outdated =
    useAtomValue(environmentPresentations.presentationAtom(environmentId))?.entry
      .serverUpdateRequired === true;
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders);
  const [connectionExpanded, setConnectionExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const allowed =
    !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, connected);
  const running = updateState.status === "running";
  const providerBusy = config?.providers.some(isProviderUpdateActive) ?? false;
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const busy = !connected || pending !== null || running || providerBusy;
  const managedPolicy = config?.managedPolicy;
  const supportUrl = managedPolicy?.supportUrl;

  async function run(label: string, action: () => Promise<void>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    const result = await settlePromise(action);
    pendingRef.current = false;
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        cause instanceof Error
          ? formatProviderMaintenanceMessage(cause.message)
          : "操作未完成，请重试。",
      );
    }
  }

  function requestProviderUpdate(provider: ServerProvider) {
    if (
      busy ||
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      !canUpdateEnvironmentProvider(provider)
    )
      return;
    const label =
      provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver;
    const targetVersion = provider.versionAdvisory?.latestVersion;
    Dialog.confirm({
      title: `更新 ${label}？`,
      message: `${environment?.environmentLabel ?? "此环境"} · ${provider.installedVersion ?? provider.version ?? "未知版本"} → ${targetVersion}。服务端会复核最新兼容版本，等相关任务结束后更新 CLI，期间服务端继续运行。`,
      confirmText: "更新此项",
      onConfirm: () => {
        const latest = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
        const selected = latest?.providers.find(
          (entry) => entry.instanceId === provider.instanceId,
        );
        if (
          !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
          !selected ||
          !selected.enabled ||
          selected.driver !== provider.driver ||
          selected.versionAdvisory?.latestVersion !== targetVersion ||
          !canUpdateEnvironmentProvider(selected) ||
          latest?.providers.some(isProviderUpdateActive) ||
          appAtomRegistry.get(serverEnvironment.updateStateAtom(environmentId)).status === "running"
        ) {
          setError("设备状态或可更新版本已变化，请刷新后重试。");
          return;
        }
        void run(selected.instanceId, async () => {
          const result = await updateProvider({
            environmentId,
            input: { provider: selected.driver, instanceId: selected.instanceId },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          const updated = result.value.providers.find(
            (entry) => entry.instanceId === selected.instanceId,
          );
          const version = updated?.installedVersion ?? updated?.version;
          setNotice(
            `${label} · ${providerUpdateResult(updated?.updateState) ?? "尚未确认更新结果。"}${version ? ` 当前版本 ${version}` : ""}`,
          );
        });
      },
    });
  }

  return (
    <SettingsScreen title={environment?.environmentLabel ?? "环境"}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-base text-foreground-muted">{"此设备已不再保存该环境。"}</Text>
        ) : (
          <>
            <SettingsSection title="连接">
              <ConnectionEnvironmentRow
                environment={environment}
                expanded={connectionExpanded}
                onToggle={() => setConnectionExpanded((value) => !value)}
                onReconnect={connections.onReconnectEnvironment}
                onRemove={connections.onRemoveEnvironmentPress}
                onSetEnabled={connections.onSetEnvironmentEnabled}
                onUpdate={connections.onUpdateEnvironment}
              />
            </SettingsSection>
            <EnvironmentRoutesSection
              environmentId={environmentId}
              connected={connected}
              onAddRoute={() =>
                navigation.navigate("SettingsEnvironmentNew", { routeFor: environmentId })
              }
            />
            {outdated ? (
              <OutdatedServerUpdateSection
                environmentId={environmentId}
                label={environment.environmentLabel}
              />
            ) : !connected ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {"请连接此环境以进行管理。"}
              </Text>
            ) : !allowed ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {AsyncResult.isFailure(sessionResult)
                  ? "暂时无法验证权限，正在自动重试。"
                  : session?.authenticated === false
                    ? "此环境未接受当前会话，请重新连接。"
                    : session === null
                      ? "正在检查权限…"
                      : "当前连接没有管理此环境的权限。"}
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {notice ? <Text className="px-2 text-sm text-foreground-muted">{notice}</Text> : null}
            {config && !outdated ? (
              <>
                <SettingsSection title="T3 Code">
                  <EnvironmentServerUpdateRows environment={environment} />
                  {supportUrl && managedPolicy ? (
                    <SettingsActionRow
                      icon="questionmark.bubble"
                      label={`联系 ${managedPolicy.organization} 获取帮助`}
                      onPress={() => void Linking.openURL(supportUrl).catch(() => undefined)}
                    />
                  ) : null}
                </SettingsSection>
                <SettingsSection title="服务提供方">
                  <SettingsActionRow
                    icon="arrow.clockwise"
                    label="刷新服务提供方"
                    disabled={busy || !canRead}
                    loading={pending === "refresh"}
                    onPress={() => {
                      if (busy || !canRead) return;
                      void run("refresh", async () => {
                        if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
                          return;
                        const result = await refreshProviders({
                          environmentId,
                          input: { reloadSecrets: true },
                        });
                        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                        setNotice("服务提供方状态已刷新。");
                      });
                    }}
                  />
                  {config.providers
                    .filter((provider) => provider.enabled)
                    .map((provider) => (
                      <View key={provider.instanceId}>
                        <View className="gap-1 p-4">
                          <View className="flex-row items-center gap-2">
                            <ProviderIcon
                              provider={provider.driver}
                              iconUrl={provider.iconUrl}
                              size={18}
                            />
                            <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                              {provider.displayName ?? provider.driver}
                            </Text>
                          </View>
                          <Text className="text-sm text-foreground-muted">
                            {provider.installed ? (provider.version ?? "版本未知") : "未安装"}
                            {provider.versionAdvisory?.latestVersion
                              ? ` · 最新版本 ${provider.versionAdvisory.latestVersion}`
                              : ""}
                          </Text>
                          {provider.updateState && provider.updateState.status !== "idle" ? (
                            <Text
                              selectable
                              className={
                                provider.updateState.status === "failed"
                                  ? "text-sm text-danger-foreground"
                                  : "text-sm text-foreground-muted"
                              }
                            >
                              {provider.updateState.message
                                ? formatProviderMaintenanceMessage(provider.updateState.message)
                                : providerUpdateResult(provider.updateState)}
                            </Text>
                          ) : null}
                          {provider.compatibilityAdvisory?.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.compatibilityAdvisory.message}
                            </Text>
                          ) : null}
                          {provider.unavailableReason || provider.message ? (
                            <Text selectable className="text-sm text-foreground-muted">
                              {provider.unavailableReason ?? provider.message}
                            </Text>
                          ) : null}
                          {provider.versionAdvisory?.status === "behind_latest" &&
                          !provider.versionAdvisory.canUpdate ? (
                            <Text className="text-sm text-foreground-muted">
                              {"请在此 CLI 所在的设备上手动更新。"}
                            </Text>
                          ) : null}
                        </View>
                        {canUpdateEnvironmentProvider(provider) ? (
                          <SettingsActionRow
                            icon="arrow.up.circle"
                            label={`更新 ${provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.driver}`}
                            disabled={busy || !canManageProviders}
                            loading={pending === provider.instanceId}
                            onPress={() => requestProviderUpdate(provider)}
                          />
                        ) : null}
                        {config.environment.capabilities.headerUsage &&
                        (provider.driver === "codex" || provider.driver === "claudeAgent") ? (
                          <HeaderUsageSettings
                            environmentId={environmentId}
                            instanceId={provider.instanceId}
                            driver={provider.driver}
                            disabled={busy || !canManageProviders}
                          />
                        ) : null}
                      </View>
                    ))}
                </SettingsSection>
              </>
            ) : null}
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
