import { useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { AppText } from "../../components/ui/AppText";
import type { UsageDetails } from "./headerUsageDetails";

export function HeaderUsageDetailsDialog(props: {
  readonly details: UsageDetails;
  readonly onClose: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onEdit: () => void;
}) {
  const { height, width, fontScale } = useWindowDimensions();
  const dialogWidth = Math.min(width - 48, 360);
  const contentWidth = dialogWidth - 32;
  const longestToken = Math.max(10, ...props.details.rows.map((row) => row.tokens.length));
  const tableWidth = Math.max(contentWidth, (210 + longestToken * 8) * fontScale);
  const fixedColumnWidth = 70 * fontScale;
  const metricWidth = fontScale > 1.2 || contentWidth < 280 ? "50%" : "33.333333%";
  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshManually = async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setRefreshError(null);
    try {
      await props.onRefresh();
    } catch {
      setRefreshError("刷新失败，请重试。");
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  const actions = ["关闭", "刷新", "查询设置"] as const;
  return (
    <Modal transparent animationType="fade" onRequestClose={props.onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          padding: 16,
          backgroundColor: "rgba(0, 0, 0, 0.45)",
        }}
      >
        <View
          accessibilityViewIsModal
          className="bg-card"
          style={{
            alignSelf: "center",
            width: dialogWidth,
            maxHeight: height - 48,
            borderRadius: 16,
            overflow: "hidden",
          }}
        >
          <AppText
            accessibilityRole="header"
            className="font-t3-medium"
            style={{ fontSize: 18, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}
          >
            余额与用量
          </AppText>
          <ScrollView
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 6, gap: 12 }}
          >
            <AppText className="text-foreground-muted" style={{ fontSize: 12, lineHeight: 18 }}>
              {props.details.provider}
              {props.details.source ? ` · ${props.details.source}` : ""}
            </AppText>
            <View style={{ flexDirection: "row", flexWrap: "wrap", rowGap: 12 }}>
              {props.details.metrics.map((item) => (
                <View key={item.label} style={{ width: metricWidth, paddingRight: 8, gap: 2 }}>
                  <AppText
                    className="text-foreground-muted"
                    style={{ fontSize: 11, lineHeight: 16 }}
                  >
                    {item.label}
                    {item.expired ? " *" : ""}
                  </AppText>
                  <AppText
                    selectable
                    className={item.lowCache ? "text-danger-foreground" : "text-foreground"}
                    style={{ fontSize: 14, lineHeight: 20, fontVariant: ["tabular-nums"] }}
                  >
                    {item.value}
                  </AppText>
                </View>
              ))}
            </View>
            <View style={{ gap: 8 }}>
              <AppText
                accessibilityRole="header"
                className="font-t3-medium"
                style={{ fontSize: 12, lineHeight: 18 }}
              >
                最近5次请求
              </AppText>
              {props.details.rows.length ? (
                <ScrollView horizontal showsHorizontalScrollIndicator>
                  <View style={{ width: tableWidth }}>
                    <View style={{ flexDirection: "row", paddingBottom: 8 }}>
                      {["时间", "Token", "缓存率", "速度 t/s"].map((label, index) => (
                        <AppText
                          key={label}
                          className="text-foreground-muted"
                          style={{
                            ...(index === 1 ? { flex: 1 } : { width: fixedColumnWidth }),
                            minWidth: 0,
                            fontSize: 11,
                            lineHeight: 16,
                            textAlign: index === 0 ? "left" : "right",
                          }}
                        >
                          {label}
                        </AppText>
                      ))}
                    </View>
                    {props.details.rows.map((sample, index) => (
                      <View
                        // oxlint-disable-next-line react/no-array-index-key -- Samples have no ID and timestamps may repeat.
                        key={`${sample.timestamp}-${index}`}
                        className="border-t border-border"
                        style={{ flexDirection: "row", alignItems: "center", paddingVertical: 7 }}
                      >
                        <AppText
                          className="text-foreground-muted"
                          accessibilityLabel={new Date(sample.timestamp).toLocaleString()}
                          style={{
                            width: fixedColumnWidth,
                            fontSize: 12,
                            lineHeight: 20,
                            fontVariant: ["tabular-nums"],
                          }}
                        >
                          {new Date(sample.timestamp).toLocaleTimeString([], { hour12: false })}
                        </AppText>
                        {(["tokens", "cache", "speed"] as const).map((column) => (
                          <AppText
                            key={column}
                            selectable
                            numberOfLines={1}
                            style={{
                              ...(column === "tokens" ? { flex: 1 } : { width: fixedColumnWidth }),
                              minWidth: 0,
                              fontSize: 13,
                              lineHeight: 20,
                              textAlign: "right",
                              fontVariant: ["tabular-nums"],
                            }}
                          >
                            {sample[column]}
                          </AppText>
                        ))}
                      </View>
                    ))}
                  </View>
                </ScrollView>
              ) : (
                <AppText className="text-foreground-muted" style={{ fontSize: 12, lineHeight: 18 }}>
                  {props.details.emptyText}
                </AppText>
              )}
            </View>
            {props.details.rows.some((row) => row.speed.startsWith("≈")) ? (
              <AppText className="text-foreground-muted" style={{ fontSize: 11, lineHeight: 16 }}>
                ≈响应速度，含思考与首字等待
              </AppText>
            ) : null}
            {refreshError || props.details.notice ? (
              <AppText style={{ fontSize: 12, lineHeight: 18 }}>
                {refreshError ?? props.details.notice}
              </AppText>
            ) : null}
          </ScrollView>
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: 8,
              paddingHorizontal: 10,
              paddingTop: 4,
              paddingBottom: 8,
            }}
          >
            {actions.map((label) => (
              <Pressable
                key={label}
                accessibilityRole="button"
                onPress={() => {
                  if (label === "关闭") props.onClose();
                  else if (label === "查询设置") props.onEdit();
                  else void refreshManually();
                }}
                disabled={label === "刷新" && refreshing}
                accessibilityState={
                  label === "刷新" ? { disabled: refreshing, busy: refreshing } : undefined
                }
                className="active:opacity-70"
                style={{
                  minHeight: 48,
                  minWidth: 88,
                  flexGrow: 1,
                  paddingHorizontal: 8,
                  paddingVertical: 8,
                  justifyContent: "center",
                }}
              >
                <AppText
                  className="text-primary-text font-t3-medium"
                  style={{ fontSize: 13, lineHeight: 20, textAlign: "center" }}
                >
                  {label}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}
