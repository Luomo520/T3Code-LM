import { themeColorWithAlpha } from "../../../lib/mobileTheme";
import { FloatingWorkspaceDock } from "./FloatingWorkspaceDock";
import { type DockGlassScope } from "../../../components/ui/DockGlass";
import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView } from "expo";
import { CommonActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  Keyboard,
  processColor,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type ViewProps,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAndroidControlSizing } from "../../../components/ui/useAndroidControlSizing";
import { useToolbarLayout } from "../../../components/ui/useToolbarLayout";
import { rootNavigationRef } from "../../../lib/rootNavigation";
import { useWorkspaceConnectionState } from "../../../state/workspace";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import {
  androidWorkspaceTabNavigationState,
  type AndroidWorkspaceNavigationTab,
} from "./android-workspace-tabs";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";
import {
  refreshSoftKeyboardShowing,
  useSoftKeyboardShowing,
} from "../../keyboard/useSoftKeyboardShowing";
import { useAdaptiveWorkspaceLayout } from "../adaptive-workspace-context";
import { useAndroidWorkspaceRoot } from "./AndroidWorkspaceTabsProvider";
import { useNavigationTabOrder, useHiddenNavigationTabs } from "./navigation-tabs";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import { FLOATING_TABS, floatingDockMetrics } from "./floating-workspace-tabs";

// Matches RAIL_WIDTH in the native rail.
export const ANDROID_WORKSPACE_RAIL_WIDTH = 72;

interface NativeNavigationProps extends ViewProps {
  readonly rail: boolean;
  readonly floating: boolean;
  readonly tabs: readonly string[];
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly dark: boolean;
  readonly textScale: number;
  readonly newEnabled: boolean;
  readonly safeAreaTop: number;
  readonly safeAreaBottom: number;
  readonly headerHeight: number;
  readonly containerColor: number;
  readonly selectedColor: number;
  readonly indicatorColor: number;
  readonly unselectedColor: number;
  readonly actionColor: number;
  readonly actionContentColor: number;
  readonly onTabSelected: (
    event: NativeSyntheticEvent<{ readonly tab: AndroidWorkspaceNavigationTab }>,
  ) => void;
  readonly onNewThread: () => void;
  readonly onOverlayChange: (event: NativeSyntheticEvent<{ readonly overlay: boolean }>) => void;
}

const NativeNavigation = requireNativeView<NativeNavigationProps>("T3WorkspaceNavigation");

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

export function AndroidWorkspaceNavigation(props: {
  readonly onNewThread: () => void;
  readonly rail?: boolean;
  readonly floating?: boolean;
  readonly glassScope?: DockGlassScope;
  readonly fillWidth?: boolean;
  readonly paneWidth?: number;
  readonly onSelect?: () => void;
  /** The rail needs the whole workspace while it widens over the list. */
  readonly onOverlayChange?: (overlay: boolean) => void;
}) {
  const workspace = useWorkspaceTabs()!;
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  const root = useAndroidWorkspaceRoot();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const toolbar = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const keyboardVisible = useSoftKeyboardShowing();
  useFocusEffect(refreshSoftKeyboardShowing);
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  const rail = Boolean(props.rail);
  const floating = !rail && Boolean(props.floating);
  const tabs: AndroidWorkspaceNavigationTab[] = [
    ...visibleNavigationTabs(order, hidden, rail ? 5 : 4),
    "settings",
  ];
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, rail, floating);
  const selectedTab = selectedNavigationTab(
    order,
    workspace.state.selectedTab,
    root?.settingsOpen ?? false,
    hidden,
    rail ? 5 : 4,
  );
  const showCompose = selectedTab === "threads" && connectionState.hasConnections;
  const barWidth =
    (props.paneWidth ?? window.width) -
    Math.max(insets.left, FLOATING_TABS.edge) -
    Math.max(insets.right, FLOATING_TABS.edge);
  const metrics = floatingDockMetrics(tabs.length, fabSize, barWidth, showCompose);
  if (!rail && keyboardVisible) return null;
  const selectTab = (tab: AndroidWorkspaceNavigationTab) => {
    Keyboard.dismiss();
    if (tab !== "settings") workspace.dispatch({ type: "select", tab });
    const rootState = rootNavigationRef.getRootState();
    if (root && rootState) {
      navigation.dispatch({
        ...CommonActions.reset(
          androidWorkspaceTabNavigationState(rootState, tab, layout.usesSplitView),
        ),
        target: root.key,
      });
    }
    props.onSelect?.();
  };
  if (floating) {
    return (
      <FloatingWorkspaceDock
        tabs={tabs}
        selectedTab={selectedTab}
        onSelect={selectTab}
        width={metrics.pill}
        height={metrics.height}
        scale={scale}
        selectedColor={selectedColor}
        unselectedColor={unselectedColor}
        indicatorColor={indicatorColor}
        glassScope={props.glassScope ?? "workspace"}
        onNewThread={
          showCompose
            ? () => {
                Keyboard.dismiss();
                props.onNewThread();
              }
            : undefined
        }
        primaryColor={colors["--color-primary"]}
        primaryForeground={colors["--color-primary-foreground"]}
      />
    );
  }

  return (
    <View
      style={rail ? { flex: 1 } : { backgroundColor: containerColor, paddingBottom: insets.bottom }}
    >
      <NativeNavigation
        rail={rail}
        floating={false}
        tabs={tabs}
        selectedTab={selectedTab}
        dark={themeAppearance === "dark"}
        textScale={scale}
        newEnabled={connectionState.hasConnections}
        safeAreaTop={toolbar.paddingTop}
        safeAreaBottom={insets.bottom}
        headerHeight={toolbar.height}
        containerColor={nativeColor(containerColor)}
        selectedColor={nativeColor(selectedColor)}
        indicatorColor={nativeColor(indicatorColor)}
        unselectedColor={nativeColor(unselectedColor)}
        actionColor={nativeColor(colors["--color-primary"])}
        actionContentColor={nativeColor(colors["--color-primary-foreground"])}
        onTabSelected={(event) => selectTab(event.nativeEvent.tab)}
        onNewThread={() => {
          Keyboard.dismiss();
          props.onNewThread();
        }}
        onOverlayChange={(event) => props.onOverlayChange?.(event.nativeEvent.overlay)}
        style={rail ? { flex: 1 } : { height: 80 * Math.max(1, scale) }}
      />
    </View>
  );
}

export function FloatingWorkspaceTabs(props: {
  readonly glassScope?: DockGlassScope;
  readonly fillWidth?: boolean;
  readonly onNewThread: () => void;
  readonly paneWidth?: number;
  readonly onSelect?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { themeVariables: colors } = useAppearancePreferences();
  const keyboardVisible = useSoftKeyboardShowing();
  useFocusEffect(refreshSoftKeyboardShowing);
  if (keyboardVisible) return null;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: 20,
        paddingLeft: Math.max(insets.left, FLOATING_TABS.edge),
        paddingRight: Math.max(insets.right, FLOATING_TABS.edge),
        paddingBottom: insets.bottom + FLOATING_TABS.bottom,
        alignItems: "center",
      }}
    >
      <View
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          experimental_backgroundImage: `linear-gradient(to bottom, ${themeColorWithAlpha(colors["--color-screen"], 0)} 0%, ${colors["--color-screen"]} 34%, ${colors["--color-screen"]} 100%)`,
        }}
      />
      <AndroidWorkspaceNavigation {...props} floating />
    </View>
  );
}
