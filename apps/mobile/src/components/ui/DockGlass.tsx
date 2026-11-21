import { createContext, use, useEffect, useState, type ReactNode } from "react";
import { AccessibilityInfo, StyleSheet, View, type ViewProps } from "react-native";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";

export type DockGlassScope = "workspace" | "sidebar" | "thread";
const DockGlassContext = createContext(true);

/** Safe material: no native blur target or RenderNode is mounted during startup/navigation. */
export function DockGlassProvider({ children }: { readonly children: ReactNode }) {
  // Start opaque until the accessibility preference has resolved.
  const [reduceTransparency, setReduceTransparency] = useState(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the OS transparency setting while the app is mounted
  useEffect(() => {
    let live = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      (value) => {
        changed = true;
        if (live) setReduceTransparency(value);
      },
    );
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((value) => {
        if (live && !changed) setReduceTransparency(value);
      })
      .catch(() => {
        // Keep the readable opaque surface when the OS setting is unavailable.
      });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return <DockGlassContext value={reduceTransparency}>{children}</DockGlassContext>;
}

/** Keep the React Native screen hierarchy intact; this no longer captures descendants. */
export function DockGlassCapture({
  scope: _scope,
  ...props
}: ViewProps & {
  readonly scope: DockGlassScope;
}) {
  return <View {...props} />;
}

export function DockGlassBackdrop({
  scope: _scope,
  material = "dock",
  borderRadius,
}: {
  readonly scope: DockGlassScope;
  readonly material?: "dock" | "popup" | "navigation";
  readonly borderRadius?: number;
}) {
  const reduceTransparency = use(DockGlassContext);
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  // Without background blur, use a stronger tint so moving text cannot wash out controls.
  const alpha = reduceTransparency
    ? 1
    : material === "navigation"
      ? 0.98
      : material === "popup"
        ? 0.96
        : dark
          ? 0.9
          : 0.88;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: themeColorWithAlpha(themeVariables["--color-screen"], alpha),
            borderRadius: borderRadius ?? (material === "popup" ? 22 : 999),
            borderWidth: 1,
            borderColor: dark ? "rgba(255,255,255,0.13)" : "rgba(26,32,46,0.08)",
            ...(material === "popup"
              ? { borderTopColor: dark ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.95)" }
              : {}),
          },
        ]}
      />
    </View>
  );
}
