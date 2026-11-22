import {
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeVariables,
} from "../../lib/mobileTheme";

const LIGHT_HOME = {
  "--color-screen": "#f4f5f8",
  "--color-drawer": "#f4f5f8",
  "--color-header": "#f4f5f8",
  "--color-grouped-card": "#ffffff",
  "--color-foreground": "#171b23",
  "--color-foreground-muted": "#626978",
  "--color-foreground-tertiary": "#626978",
  "--color-drawer-foreground": "#171b23",
  "--color-drawer-foreground-muted": "#626978",
  "--color-border-subtle": "#e9eaf0",
  "--color-thread-hover": "#e7efff",
  "--color-row-hover": "#e7efff",
  "--color-thread-selected": "#e7efff",
  "--color-thread-selected-foreground": "#214caa",
  "--color-thread-selected-foreground-muted": "#3a5686",
  "--color-primary": "#2867ef",
  "--color-primary-foreground": "#ffffff",
} satisfies Partial<MobileThemeVariables>;

const DARK_HOME = {
  "--color-screen": "#17191e",
  "--color-drawer": "#17191e",
  "--color-header": "#17191e",
  "--color-grouped-card": "#24262d",
  "--color-foreground": "#f1f2f5",
  "--color-foreground-muted": "#adb2bf",
  "--color-foreground-tertiary": "#adb2bf",
  "--color-drawer-foreground": "#f1f2f5",
  "--color-drawer-foreground-muted": "#adb2bf",
  "--color-border-subtle": "#323640",
  "--color-thread-hover": "#293853",
  "--color-row-hover": "#293853",
  "--color-thread-selected": "#293853",
  "--color-thread-selected-foreground": "#a4c5ff",
  "--color-thread-selected-foreground-muted": "#b6c9eb",
  "--color-primary": "#8db5ff",
  "--color-primary-foreground": "#17191e",
} satisfies Partial<MobileThemeVariables>;

export function androidHomeTheme(themeId: MobileThemeId, appearance: MobileThemeAppearance) {
  return themeId === DEFAULT_MOBILE_THEME_ID
    ? appearance === "dark"
      ? DARK_HOME
      : LIGHT_HOME
    : undefined;
}
