import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, type StaticScreenProps } from "@react-navigation/native";
import { AuthProvidersManageScope, type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { useEnvironmentQuery } from "../../state/query";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { HeaderUsageSettings } from "./HeaderUsageSettings";
import { resolveHeaderUsageProvider, resolveHeaderUsageTarget } from "./headerUsageTarget";
import { headerUsageTargetAtom, rememberHeaderUsageTarget } from "./headerUsageTargetState";

export function HeaderUsageSettingsRouteScreen({
  route,
}: StaticScreenProps<{
  environmentId: EnvironmentId | null;
  providerInstanceId: string | null;
  threadId: string | null;
}>) {
  return <UsageSettings key={JSON.stringify(route.params)} {...route.params} />;
}

function UsageSettings(props: {
  environmentId: EnvironmentId | null;
  providerInstanceId: string | null;
  threadId: string | null;
}) {
  const insets = useSafeAreaInsets();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const preferred = useAtomValue(headerUsageTargetAtom);
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const [selectedEnvironment, setSelectedEnvironment] = useState(props.environmentId);
  const [selectedProvider, setSelectedProvider] = useState(props.providerInstanceId);
  const environments = connectedEnvironments.filter((entry) => entry.isEnabled);
  const target = resolveHeaderUsageTarget({
    environmentIds: environments.map((entry) => entry.environmentId),
    configs,
    selectedEnvironmentId: selectedEnvironment,
    preferred,
  });
  const environment = environments.find((entry) => entry.environmentId === target?.environmentId);
  const config = target ? configs.get(target.environmentId) : undefined;
  const provider = resolveHeaderUsageProvider(
    config,
    selectedProvider ?? target?.providerInstanceId,
  );
  const providers =
    config?.providers.filter(
      (entry) => entry.driver === "codex" || entry.driver === "claudeAgent",
    ) ?? [];
  const supported = config?.environment.capabilities.headerUsage === true;
  return (
    <SettingsScreen title="余额查询设置">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        <View className="gap-2">
          <AppText className="text-sm text-foreground-muted">
            环境 · {environment?.environmentLabel ?? "尚未选择"}
          </AppText>
          {environments.length > 1 ? (
            <View className="flex-row flex-wrap gap-2">
              {environments.map((entry) => (
                <Pressable
                  key={entry.environmentId}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: target?.environmentId === entry.environmentId }}
                  className="min-h-11 justify-center rounded-lg border border-border-subtle px-3 py-2"
                  onPress={() => {
                    setSelectedEnvironment(entry.environmentId);
                    setSelectedProvider(null);
                  }}
                >
                  <AppText
                    className={
                      target?.environmentId === entry.environmentId
                        ? "text-foreground font-t3-bold"
                        : "text-foreground-muted"
                    }
                  >
                    {entry.environmentLabel}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
          <AppText className="text-sm text-foreground-muted">
            供应商 · {provider?.displayName ?? provider?.driver ?? "暂不可用"}
          </AppText>
          {providers.length > 1 ? (
            <View className="flex-row flex-wrap gap-2">
              {providers.map((entry) => (
                <Pressable
                  key={entry.instanceId}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: provider?.instanceId === entry.instanceId }}
                  className="min-h-11 justify-center rounded-lg border border-border-subtle px-3 py-2"
                  onPress={() => setSelectedProvider(entry.instanceId)}
                >
                  <AppText
                    className={
                      provider?.instanceId === entry.instanceId
                        ? "text-foreground font-t3-bold"
                        : "text-foreground-muted"
                    }
                  >
                    {entry.displayName ?? entry.driver}
                  </AppText>
                </Pressable>
              ))}
            </View>
          ) : null}
          <AppText className="text-sm text-foreground-muted">
            主页显示这里选定账户的统计；会话显示该会话供应商的统计。
          </AppText>
        </View>
        {!target ? (
          <AppText className="text-foreground-muted">
            请先连接一个环境，再设置查询网址与 Key。
          </AppText>
        ) : !supported ? (
          <AppText className="text-foreground-muted">
            当前环境尚未连接或后台不支持顶部统计，请连接或更新后台。
          </AppText>
        ) : !provider ? (
          <AppText className="text-foreground-muted">
            当前供应商不支持余额查询，可切换至 Codex 或 Claude。
          </AppText>
        ) : (
          <UsageSettingsEditor
            key={`${target.environmentId}/${provider.instanceId}`}
            environmentId={target.environmentId}
            provider={provider}
            connected={environment?.connectionState === "connected"}
            threadId={
              target.environmentId === props.environmentId &&
              provider.instanceId === props.providerInstanceId
                ? props.threadId
                : null
            }
          />
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function UsageSettingsEditor(props: {
  environmentId: EnvironmentId;
  provider: NonNullable<ReturnType<typeof resolveHeaderUsageProvider>>;
  connected: boolean;
  threadId: string | null;
}) {
  const allowed = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const focused = useIsFocused();
  const query = useEnvironmentQuery(
    serverEnvironment.headerUsage({
      environmentId: props.environmentId,
      input: {
        providerInstanceId: props.provider.instanceId,
        ...(props.threadId ? { threadId: props.threadId } : {}),
      },
    }),
  );
  const { refresh } = query;
  useEffect(() => {
    if (!focused) return;
    rememberHeaderUsageTarget({
      environmentId: props.environmentId,
      providerInstanceId: props.provider.instanceId,
    });
    const timer = setInterval(() => {
      if (AppState.currentState === "active") refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [focused, props.environmentId, props.provider.instanceId, refresh]);
  return (
    <>
      {!props.connected || !allowed ? (
        <AppText className="text-sm text-foreground-muted">
          {!props.connected ? "环境未连接，暂时无法保存。" : "当前连接没有修改供应商配置的权限。"}
        </AppText>
      ) : null}
      <SettingsSection>
        <HeaderUsageSettings
          environmentId={props.environmentId}
          instanceId={props.provider.instanceId}
          driver={props.provider.driver}
          disabled={!props.connected || !allowed}
          initiallyOpen
          onSaved={refresh}
        />
      </SettingsSection>
      <View className="gap-2">
        <AppText className="text-sm text-foreground-muted" selectable>
          {query.error
            ? "统计读取失败，请检查环境连接。"
            : (query.data?.account.message ?? "正在读取查询状态…")}
        </AppText>
        <AppText className="text-sm text-foreground-muted">
          账单更新：
          {query.data?.account.readAt
            ? new Date(query.data.account.readAt).toLocaleString()
            : "尚未成功获取"}
        </AppText>
        <AppText className="text-sm text-foreground-muted">
          配置保存成功与余额查询成功分别显示。切页主动刷新共享 30 秒冷却，失败时保留上次数据并退避。
        </AppText>
      </View>
    </>
  );
}
