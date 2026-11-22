import { useRef, useState, type ComponentProps } from "react";
import {
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ScrollComposeButton } from "../../components/ScrollComposeButton.android";
import {
  androidHomeFabPosition,
  type AndroidHomeFabLayout as SharedAndroidHomeFabLayout,
} from "./AndroidHomeFab.shared";
import { useWorkspaceState } from "../../state/workspace";
import { FabScrollContext } from "./FabScrollContext";
import { updateFabScroll } from "./fab-scroll";
import { useAndroidControlSizing } from "../../components/ui/useAndroidControlSizing";
import { WorkspaceTabsContext, useWorkspaceTabs } from "../layout/workspace/WorkspaceTabsContext";
import { floatingDockBottomClearance } from "../layout/workspace/floating-workspace-tabs";
import {
  useAppearancePreferences,
  useAndroidFloatingTabs,
} from "../settings/appearance/AppearancePreferencesProvider";

export function AndroidHomeFabLayout(props: ComponentProps<typeof SharedAndroidHomeFabLayout>) {
  const floatingTabsEnabled = useAndroidFloatingTabs();
  const insets = useSafeAreaInsets();
  const { appearance } = useAppearancePreferences();
  const { fontScale } = useWindowDimensions();
  const [layoutWidth, setLayoutWidth] = useState<number | null>(null);
  const { state } = useWorkspaceState();
  const [expanded, setExpanded] = useState(true);
  const { fabSize } = useAndroidControlSizing();
  const workspace = useWorkspaceTabs();
  const bottomClearance = floatingDockBottomClearance(
    insets.bottom,
    fabSize,
    !props.disabled && state.hasConnections,
  );
  const context = floatingTabsEnabled && workspace ? { ...workspace, bottomClearance } : workspace;
  const scrollState = useRef({ anchor: 0, expanded: true });
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const next = updateFabScroll(
      scrollState.current,
      contentOffset.y,
      contentSize.height - layoutMeasurement.height,
    );
    if (next.expanded !== scrollState.current.expanded) setExpanded(next.expanded);
    scrollState.current = next;
  };

  // 字体或窗格变化时仅重建 Material 新会话按钮，清除缓存的展开宽度。
  return (
    <View className="flex-1" onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}>
      <WorkspaceTabsContext value={context}>
        <FabScrollContext value={onScroll}>{props.children}</FabScrollContext>
      </WorkspaceTabsContext>
      {!floatingTabsEnabled &&
      !props.disabled &&
      !props.sidebar &&
      state.hasConnections &&
      layoutWidth !== null ? (
        <ScrollComposeButton
          key={`${appearance.baseFontSize}:${fontScale}:${layoutWidth}`}
          size={fabSize}
          expanded={expanded}
          onPress={props.onStartNewTask}
          className="absolute"
          style={androidHomeFabPosition(insets.bottom, props.sidebar)}
        />
      ) : null}
    </View>
  );
}
