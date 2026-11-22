import { createContext, use, useEffect, useId, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Platform,
  processColor,
  StyleSheet,
  View,
  type ViewProps,
} from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { AndroidDockSample } from "../../native/AndroidDockSample";

export type DockGlassScope = "workspace" | "sidebar" | "thread";
const DockGlassContext = createContext(true);
const DockGlassSamplingContext = createContext<string | null>(null);

export function DockGlassSamplingScope({ children }: { readonly children: ReactNode }) {
  const id = useId();
  return <DockGlassSamplingContext value={id}>{children}</DockGlassSamplingContext>;
}

function dockGlassNativeId(id: string | null, scope: DockGlassScope) {
  return id !== null && scope !== "thread" ? `dock-glass-${id}-${scope}` : undefined;
}

/** 等待系统辅助功能状态后再启用透明材质。 */
export function DockGlassProvider({ children }: { readonly children: ReactNode }) {
  const [reduceTransparency, setReduceTransparency] = useState(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 订阅系统辅助功能变化
  useEffect(() => {
    let live = true;
    let changed = false;
    const android = Platform.OS === "android";
    // Android 提供高对比度文本偏好，iOS 提供减少透明度偏好。
    const subscription = AccessibilityInfo.addEventListener(
      android ? "highTextContrastChanged" : "reduceTransparencyChanged",
      (value) => {
        changed = true;
        if (live) setReduceTransparency(value);
      },
    );
    const preference = android
      ? AccessibilityInfo.isHighTextContrastEnabled()
      : AccessibilityInfo.isReduceTransparencyEnabled();
    void preference
      .then((value) => {
        if (live && !changed) setReduceTransparency(value);
      })
      .catch(() => {
        // 系统读取失败时继续显示实色。
      });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return <DockGlassContext value={reduceTransparency}>{children}</DockGlassContext>;
}

export function DockGlassCapture({
  scope,
  ...props
}: ViewProps & {
  readonly scope: DockGlassScope;
}) {
  const id = use(DockGlassSamplingContext);
  const nativeID = AndroidDockSample ? dockGlassNativeId(id, scope) : undefined;
  return <View {...props} {...(nativeID ? { nativeID, collapsable: false } : {})} />;
}

export function DockGlassBackdrop({
  scope,
  material = "dock",
  borderRadius,
  surfaceColor,
  sample = false,
  contentRevision = "",
}: {
  readonly scope: DockGlassScope;
  readonly material?: "dock" | "popup" | "navigation";
  readonly borderRadius?: number;
  readonly surfaceColor?: string;
  readonly sample?: boolean;
  readonly contentRevision?: string;
}) {
  const reduceTransparency = use(DockGlassContext);
  const { dockGlassEnabled, isReady, themeAppearance, themeVariables } = useAppearancePreferences();
  const id = use(DockGlassSamplingContext);
  const dark = themeAppearance === "dark";
  const navigation = material === "navigation";
  const solid = reduceTransparency || (navigation && (!isReady || !dockGlassEnabled));
  const targetNativeId = navigation && sample && !solid ? dockGlassNativeId(id, scope) : undefined;
  const color = surfaceColor ?? themeVariables["--color-screen"];
  const fallbackColor = targetNativeId ? processColor(themeColorWithAlpha(color, 0.65)) : undefined;
  const showSample = AndroidDockSample && targetNativeId && typeof fallbackColor === "number";
  const alpha = solid
    ? 1
    : navigation
      ? showSample
        ? dark
          ? 0.58
          : 0.56
        : dark
          ? 0.86
          : 0.84
      : material === "popup"
        ? 0.96
        : dark
          ? 0.9
          : 0.88;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {showSample && AndroidDockSample ? (
        <AndroidDockSample
          targetNativeId={targetNativeId}
          fallbackColor={fallbackColor}
          contentRevision={contentRevision}
          importantForAccessibility="no"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: themeColorWithAlpha(color, alpha),
            borderRadius: borderRadius ?? (material === "popup" ? 22 : 999),
            borderWidth: 1,
            borderColor: showSample
              ? dark
                ? "rgba(255,255,255,0.30)"
                : "rgba(255,255,255,0.90)"
              : dark
                ? "rgba(255,255,255,0.13)"
                : "rgba(26,32,46,0.08)",
            ...(material === "popup"
              ? { borderTopColor: dark ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.95)" }
              : {}),
          },
        ]}
      />
    </View>
  );
}
