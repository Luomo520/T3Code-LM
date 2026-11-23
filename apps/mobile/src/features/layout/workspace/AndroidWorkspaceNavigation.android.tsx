import { themeColorWithContrast } from "../../../lib/mobileTheme";
import { androidHomeTheme } from "../../home/androidHomeTheme";
import { FloatingWorkspaceDock } from "./FloatingWorkspaceDock";
import { type DockGlassScope } from "../../../components/ui/DockGlass";
import { selectedNavigationTab, visibleNavigationTabs } from "./navigation-tab-order";
import { requireNativeView, requireOptionalNativeModule } from "expo";
import {
  CommonActions,
  useFocusEffect,
  useIsFocused,
  useNavigation,
} from "@react-navigation/native";
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
import { useAndroidDockInputPriority } from "../../devices/useAndroidDockInputPriority";

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
    event: NativeSyntheticEvent<{
      readonly tab: AndroidWorkspaceNavigationTab;
      readonly physicalTouch?: boolean;
    }>,
  ) => void;
  readonly onNewThread: () => void;
  readonly onOverlayChange: (event: NativeSyntheticEvent<{ readonly overlay: boolean }>) => void;
}

const NativeNavigation = requireNativeView<NativeNavigationProps>("T3WorkspaceNavigation");
const physicalTouch = requireOptionalNativeModule<{
  matchesPhysicalTouch?: (timestamp: number) => boolean;
}>("T3WorkspaceNavigation");

function nativeColor(value: string) {
  const color = processColor(value);
  return typeof color === "number" ? color : 0;
}

export function AndroidWorkspaceNavigation(props: {
  readonly onNewThread: () => void;
  readonly rail?: boolean;
  readonly floating?: boolean;
  readonly glassScope?: DockGlassScope;
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
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const toolbar = useToolbarLayout();
  const connectionState = useWorkspaceConnectionState();
  const claimInput = useAndroidDockInputPriority();
  const keyboardVisible = useSoftKeyboardShowing();
  useFocusEffect(refreshSoftKeyboardShowing);
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeId, themeAppearance, themeVariables: colors } = useAppearancePreferences();
  const { scale, fabSize } = useAndroidControlSizing();
  const window = useWindowDimensions();
  const rail = Boolean(props.rail);
  const floating = !rail && Boolean(props.floating);
  const tabs: AndroidWorkspaceNavigationTab[] = [
    ...visibleNavigationTabs(order, hidden, rail ? 5 : 4),
    "settings",
  ];
  const baseColors = androidWorkspaceNavigationColors(colors, rail, floating);
  const homeTheme = floating ? androidHomeTheme(themeId, themeAppearance) : undefined;
  const { containerColor, indicatorColor, selectedColor, unselectedColor } = homeTheme
    ? {
        containerColor: homeTheme["--color-grouped-card"],
        indicatorColor: homeTheme["--color-thread-selected"],
        selectedColor: themeColorWithContrast(homeTheme["--color-primary"], [
          homeTheme["--color-thread-selected"],
          homeTheme["--color-grouped-card"],
        ]),
        unselectedColor: homeTheme["--color-foreground"],
      }
    : baseColors;
  const selectedTab = selectedNavigationTab(
    order,
    workspace.state.selectedTab,
    root?.settingsOpen ?? false,
    hidden,
    rail ? 5 : 4,
  );
  const showCompose = selectedTab === "threads" && connectionState.hasConnections;
  const horizontalInset = Math.max(insets.left, insets.right, FLOATING_TABS.edge);
  const barWidth = (props.paneWidth ?? window.width) - 2 * horizontalInset;
  const metrics = floatingDockMetrics(tabs.length, fabSize, barWidth);
  if (!rail && keyboardVisible) return null;
  const selectTab = (tab: AndroidWorkspaceNavigationTab, touched: boolean) => {
    if (touched) claimInput();
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
        onSelect={(tab, timestamp) =>
          selectTab(
            tab,
            Number.isFinite(timestamp) && physicalTouch?.matchesPhysicalTouch?.(timestamp) === true,
          )
        }
        width={metrics.width}
        height={metrics.height}
        diameter={metrics.diameter}
        composeSize={fabSize}
        scale={scale}
        selectedColor={selectedColor}
        unselectedColor={unselectedColor}
        indicatorColor={indicatorColor}
        glassScope={props.glassScope ?? "workspace"}
        sampleGlass={focused}
        containerColor={containerColor}
        onNewThread={
          showCompose
            ? () => {
                Keyboard.dismiss();
                props.onNewThread();
              }
            : undefined
        }
        primaryColor={(homeTheme ?? colors)["--color-primary"]}
        primaryForeground={(homeTheme ?? colors)["--color-primary-foreground"]}
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
        onTabSelected={(event) =>
          selectTab(event.nativeEvent.tab, event.nativeEvent.physicalTouch === true)
        }
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
  readonly onNewThread: () => void;
  readonly paneWidth?: number;
  readonly onSelect?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const keyboardVisible = useSoftKeyboardShowing();
  useFocusEffect(refreshSoftKeyboardShowing);
  if (keyboardVisible) return null;
  const horizontalInset = Math.max(insets.left, insets.right, FLOATING_TABS.edge);
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        paddingTop: FLOATING_TABS.edge,
        paddingHorizontal: horizontalInset,
        paddingBottom: insets.bottom + FLOATING_TABS.bottom,
        alignItems: "center",
      }}
    >
      <AndroidWorkspaceNavigation {...props} floating />
    </View>
  );
}
