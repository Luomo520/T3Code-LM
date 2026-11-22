import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "monospace";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-3 py-2.5";
export const THREAD_LIST_V2_ROW_DIVIDERS = false;
export const THREAD_LIST_V2_SIDEBAR_ROW_STYLE = {
  borderRadius: 20,
  paddingHorizontal: 12,
  paddingVertical: 10,
} satisfies ViewStyle;
export const THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE = {
  borderRadius: 20,
  overflow: "hidden",
  marginHorizontal: 8,
  marginVertical: 2,
} satisfies ViewStyle;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(branch: string) {
  return `New thread on ${branch}`;
}

export function getThreadListV2RowAppearance(
  theme: Pick<
    MobileThemeVariables,
    "--color-thread-selected" | "--color-grouped-card" | "--color-drawer" | "--color-screen"
  >,
  sidebarPane: boolean,
  selected: boolean,
  homeGroup?: "only" | "first" | "middle" | "last",
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  const backgroundColor = theme["--color-grouped-card"];
  const first = homeGroup === undefined || homeGroup === "only" || homeGroup === "first";
  const last = homeGroup === undefined || homeGroup === "only" || homeGroup === "last";
  const groupCorners = homeGroup
    ? {
        borderTopLeftRadius: first ? 18 : 0,
        borderTopRightRadius: first ? 18 : 0,
        borderBottomLeftRadius: last ? 18 : 0,
        borderBottomRightRadius: last ? 18 : 0,
      }
    : {};
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : backgroundColor,
    borderRadius: THREAD_LIST_V2_SIDEBAR_ROW_STYLE.borderRadius,
    ...groupCorners,
  };
  const swipeContainerStyle = {
    ...THREAD_LIST_V2_SIDEBAR_ROW_CONTAINER_STYLE,
    ...groupCorners,
    marginTop: homeGroup && !first ? 0 : 2,
    marginBottom: homeGroup && !last ? 0 : 2,
  };

  return {
    className: undefined,
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: sidebarPane ? { ...THREAD_LIST_V2_SIDEBAR_ROW_STYLE, ...style } : style,
    swipeContainerStyle,
    swipeBackgroundColor: backgroundColor,
    providerIconSurfaceColor: selected ? selectedBackgroundColor : backgroundColor,
  };
}
