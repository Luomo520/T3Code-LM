import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { AppState, Platform, Pressable, View, useWindowDimensions } from "react-native";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import { AppText } from "../../components/ui/AppText";
import { HeaderUsageDetailsDialog } from "./HeaderUsageDetailsDialog";
import { useHeaderUsagePolling } from "./useHeaderUsagePolling";
import { usageDetails } from "./headerUsageDetails";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { headerUsageViewRefreshGate } from "./headerUsageRefresh";
import { resolveHeaderUsageProvider } from "./headerUsageTarget";
import { rememberHeaderUsageTarget } from "./headerUsageTargetState";
import type { HistoryUsageSummary } from "./headerUsageHistory";
import { useHeaderUsageHistory } from "./useHeaderUsageHistory";
import { headerUsageMetrics, detailMetricLabels } from "./headerUsageMetrics";

const noConfig = Atom.make(null);

export function HeaderUsageStats(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: string;
  readonly providerInstanceId?: string;
  readonly home?: boolean;
}) {
  const focused = useIsFocused();
  const [now, setNow] = useState(() => Date.now());
  const [detailsVisible, setDetailsVisible] = useState(false);
  const { width } = useWindowDimensions();
  const navigation = useNavigation();
  const config = useAtomValue(
    props.environmentId ? serverEnvironment.configValueAtom(props.environmentId) : noConfig,
  );
  const supported = config?.environment.capabilities.headerUsage === true;
  const query = useEnvironmentQuery(
    props.environmentId && supported && Platform.OS === "android"
      ? serverEnvironment.headerUsage({
          environmentId: props.environmentId,
          input: {
            ...(props.threadId ? { threadId: props.threadId } : {}),
            ...(props.providerInstanceId ? { providerInstanceId: props.providerInstanceId } : {}),
          },
        })
      : null,
  );
  const { refresh } = query;
  const requestRefresh = useAtomCommand(serverEnvironment.refreshHeaderUsage, {
    reportFailure: false,
    reportDefect: false,
  });
  const requestIdentity = JSON.stringify([
    props.environmentId,
    props.providerInstanceId ?? "auto",
    props.home ? "home" : "thread",
    props.home ? null : props.threadId,
  ]);
  const [refreshResponse, setRefreshResponse] = useState<{
    readonly identity: string;
    readonly data: HistoryUsageSummary;
  } | null>(null);
  const commanded = refreshResponse?.identity === requestIdentity ? refreshResponse.data : null;
  const incoming =
    commanded && (!query.data || Date.parse(commanded.readAt) >= Date.parse(query.data.readAt))
      ? commanded
      : query.data;
  const { data, historicalFields } = useHeaderUsageHistory(
    props.environmentId && Platform.OS === "android"
      ? {
          environmentId: props.environmentId,
          ...(props.providerInstanceId ? { providerInstanceId: props.providerInstanceId } : {}),
          home: Boolean(props.home),
          ...(props.threadId ? { threadId: props.threadId } : {}),
        }
      : null,
    incoming,
    incoming === commanded || (query.isSuccess && !query.isPending),
    query.error,
    props.providerInstanceId || incoming?.providerInstanceId
      ? (resolveHeaderUsageProvider(
          config ?? undefined,
          props.providerInstanceId ?? incoming?.providerInstanceId ?? undefined,
        )?.displayName ??
          props.providerInstanceId ??
          incoming?.providerInstanceId ??
          "")
      : "",
  );
  const resolvedInstanceId =
    props.providerInstanceId ??
    incoming?.providerInstanceId ??
    data?.providerInstanceId ??
    undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the visible thread provider in the external settings target registry
  useEffect(() => {
    if (!focused || props.home || !props.environmentId || !resolvedInstanceId) return;
    const provider = resolveHeaderUsageProvider(
      config ?? undefined,
      resolvedInstanceId ?? undefined,
    );
    rememberHeaderUsageTarget({
      environmentId: props.environmentId,
      providerInstanceId: provider?.instanceId ?? (resolvedInstanceId as ProviderInstanceId),
    });
  }, [focused, props.home, props.environmentId, resolvedInstanceId, config]);
  const refreshOnView = useCallback(async () => {
    if (
      !props.environmentId ||
      !supported ||
      Platform.OS !== "android" ||
      AppState.currentState !== "active"
    )
      return;
    setNow(Date.now());
    // Cached data remains on screen while the shared backend updates the account.
    refresh();
    const identity = JSON.stringify([props.environmentId, props.providerInstanceId ?? "auto"]);
    if (!headerUsageViewRefreshGate.take(identity, Date.now())) return;
    const result = await requestRefresh({
      environmentId: props.environmentId,
      input: {
        refresh: true,
        ...(props.threadId ? { threadId: props.threadId } : {}),
        ...(props.providerInstanceId ? { providerInstanceId: props.providerInstanceId } : {}),
      },
    });
    if (result._tag === "Success")
      setRefreshResponse({ identity: requestIdentity, data: result.value });
    refresh();
  }, [
    props.environmentId,
    props.threadId,
    props.providerInstanceId,
    supported,
    requestIdentity,
    refresh,
    requestRefresh,
  ]);
  useHeaderUsagePolling(
    focused && props.environmentId !== null && supported && Platform.OS === "android",
    requestIdentity,
    () => {
      setNow(Date.now());
      refresh();
    },
    () => {
      void refreshOnView();
    },
  );
  const local = props.home ? data?.allConversations : data?.conversation;
  const metrics = headerUsageMetrics(data, Boolean(props.home), now, historicalFields);
  const historical = Object.keys(historicalFields).length > 0;
  const incomplete =
    historical || metrics.some((item) => item.expired) || local?.partial || Boolean(query.error);
  const detail = () => setDetailsVisible(true);
  const edit = () =>
    navigation.navigate("SettingsHeaderUsage", {
      environmentId: props.environmentId,
      providerInstanceId: resolvedInstanceId ?? null,
      threadId: props.threadId ?? null,
    });
  return (
    <>
      <Pressable
        onPress={detail}
        onLongPress={edit}
        accessibilityRole="button"
        accessibilityLabel={
          metrics
            .map(
              ({ label, value, expired }) =>
                `${detailMetricLabels[label] ?? label} ${value}${expired ? "，历史或过期数据" : ""}`,
            )
            .join("，") +
          (historical ? "，正在显示上次成功历史数据" : "") +
          (incomplete ? "，部分数据可能不完整" : "")
        }
        accessibilityHint="点击查看统计详情与查询设置，长按直接修改网址和 Key"
        hitSlop={8}
        style={{
          flexShrink: 0,
          flexDirection: "row",
          alignItems: "center",
          gap: props.home ? 7 : width <= 360 ? 4 : 5,
          maxWidth: "100%",
          flexWrap: "wrap",
          justifyContent: "flex-end",
          paddingVertical: 2,
        }}
      >
        {metrics.map(({ label, value, lowCache, expired }) => (
          <View
            key={label}
            style={{
              alignItems: "center",
            }}
          >
            <View style={{ position: "relative", alignItems: "center" }}>
              <AppText
                className="text-foreground-muted"
                maxFontSizeMultiplier={1.3}
                style={{
                  fontSize: width <= 360 ? 7 : 7.5,
                  lineHeight: 9,
                  textAlign: "center",
                }}
              >
                {label}
              </AppText>
              {expired ? (
                <AppText
                  className="text-foreground-muted"
                  accessibilityLabel="历史或过期数据"
                  maxFontSizeMultiplier={1.3}
                  style={{
                    position: "absolute",
                    top: -2,
                    right: -4,
                    fontSize: 7,
                    lineHeight: 8,
                  }}
                >
                  *
                </AppText>
              ) : null}
            </View>
            <AppText
              className={lowCache ? "text-danger-foreground" : "text-header-foreground"}
              maxFontSizeMultiplier={1.3}
              style={{
                fontSize: width <= 360 ? 8 : 8.5,
                lineHeight: 11,
                textAlign: "center",
                fontVariant: ["tabular-nums"],
              }}
            >
              {value}
            </AppText>
          </View>
        ))}
      </Pressable>
      {detailsVisible ? (
        <HeaderUsageDetailsDialog
          details={usageDetails(data, Boolean(props.home), query.error, historicalFields, now)}
          onClose={() => setDetailsVisible(false)}
          onRefresh={refreshOnView}
          onEdit={() => {
            setDetailsVisible(false);
            edit();
          }}
        />
      ) : null}
    </>
  );
}
