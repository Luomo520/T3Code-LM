import type { ConversationUsage } from "@t3tools/contracts";
import {
  SESSION_COST_COLORS,
  SESSION_COST_LABELS,
  sessionUsageDisplay,
} from "@t3tools/shared/sessionUsageDisplay";
import { useState } from "react";
import { Keyboard, Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

interface ComposerSessionUsageProps {
  readonly usage?: ConversationUsage | null;
  readonly contextWindow?: {
    readonly usedTokens: number;
    readonly maxTokens: number | null;
  } | null;
}

const CONTEXT_COLOR = { light: "#23794e", dark: "#65ce96" };

export function ComposerSessionUsage({ usage, contextWindow }: ComposerSessionUsageProps) {
  const [expanded, setExpanded] = useState(false);
  const { themeAppearance } = useAppearancePreferences();
  const display = sessionUsageDisplay(usage, contextWindow);
  const knownCostNote = "仅含已知费用";
  const { height } = useWindowDimensions();
  const close = () => setExpanded(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[
          `会话累计费用 ${display.costLabel}`,
          display.costPartial ? knownCostNote : null,
          display.contextLabel,
        ]
          .filter(Boolean)
          .join("，")}
        accessibilityHint="查看会话用量详情"
        accessibilityState={{ expanded }}
        className="min-h-12 min-w-12 max-w-[110px] shrink-0 justify-center gap-0.5 rounded-lg px-1.5 active:bg-subtle"
        onPress={() => {
          Keyboard.dismiss();
          setExpanded(true);
        }}
      >
        <Text
          className="text-right text-xs font-t3-medium tabular-nums"
          numberOfLines={1}
          maxFontSizeMultiplier={1.3}
        >
          {display.costLabel}
        </Text>
        <View
          importantForAccessibility="no-hide-descendants"
          className="h-[3px] flex-row overflow-hidden rounded-full bg-subtle-strong"
        >
          {display.categorySegments.map((segment) => (
            <View
              key={segment.category}
              style={{
                flex: segment.share,
                backgroundColor: SESSION_COST_COLORS[segment.category][themeAppearance],
              }}
            />
          ))}
        </View>
        {display.contextPercentage === null ? (
          <Text
            className="text-right text-2xs text-foreground-muted"
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
          >
            {display.contextLabel}
          </Text>
        ) : (
          <View
            importantForAccessibility="no-hide-descendants"
            className="h-[3px] overflow-hidden rounded-full bg-subtle-strong"
          >
            <View
              className="h-full"
              style={{
                width: `${display.contextPercentage}%`,
                backgroundColor: CONTEXT_COLOR[themeAppearance],
              }}
            />
          </View>
        )}
      </Pressable>
      {expanded ? (
        <Modal transparent animationType="fade" onRequestClose={close}>
          <View className="flex-1 items-center justify-center bg-black/45 p-4">
            <Pressable accessible={false} className="absolute inset-0" onPress={close} />
            <View
              accessibilityViewIsModal
              className="w-full max-w-[360px] overflow-hidden rounded-2xl bg-card"
              style={{ maxHeight: height - 32 }}
            >
              <ScrollView className="shrink" contentContainerClassName="gap-3 p-4 pb-2">
                <Text accessibilityRole="header" className="text-lg font-t3-medium">
                  会话用量
                </Text>
                <UsageDetailRow label="会话累计费用" value={display.costLabel} />
                {display.categorySegments.length > 0 ? (
                  <View className="gap-1 rounded-xl bg-subtle p-3">
                    {display.categorySegments.map((segment) => (
                      <UsageDetailRow
                        key={segment.category}
                        label={SESSION_COST_LABELS[segment.category]}
                        value={segment.label}
                        color={SESSION_COST_COLORS[segment.category][themeAppearance]}
                      />
                    ))}
                  </View>
                ) : null}
                <UsageDetailRow label="最近一轮费用" value={display.recentCostLabel} />
                <UsageDetailRow label="最近一轮缓存命中率" value={display.cacheRateLabel} />
                <Text className="text-sm">{display.contextLabel}</Text>
                {display.costPartial || display.recentCostPartial ? (
                  <Text className="text-xs text-foreground-muted">* {knownCostNote}</Text>
                ) : null}
              </ScrollView>
              <Pressable
                accessibilityRole="button"
                className="min-h-12 items-center justify-center px-4 py-2 active:bg-subtle"
                onPress={close}
              >
                <Text className="text-sm font-t3-medium text-primary-text">关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

function UsageDetailRow(props: {
  readonly label: string;
  readonly value: string;
  readonly color?: string;
}) {
  return (
    <View className="flex-row flex-wrap items-center justify-between gap-x-2">
      <View className="min-w-0 shrink flex-row items-center gap-2">
        {props.color ? (
          <View className="size-2 shrink-0 rounded-full" style={{ backgroundColor: props.color }} />
        ) : null}
        <Text className="shrink text-sm text-foreground-muted">{props.label}</Text>
      </View>
      <Text className="text-sm tabular-nums">{props.value}</Text>
    </View>
  );
}
