import IconMessages from "@tabler/icons-react-native/IconMessages";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconChartBar from "@tabler/icons-react-native/IconChartBar";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { DockGlassBackdrop, type DockGlassScope } from "../../../components/ui/DockGlass";
import { FLOATING_TABS } from "./floating-workspace-tabs";
import type { AndroidWorkspaceNavigationTab } from "./android-workspace-tabs";

const destinations = {
  threads: { label: "会话", Icon: IconMessages },
  pullRequests: { label: "拉取请求", Icon: IconGitPullRequest },
  usage: { label: "用量", Icon: IconChartBar },
  settings: { label: "设置", Icon: IconSettings },
};

function FloatingWorkspaceTab(props: {
  readonly tab: AndroidWorkspaceNavigationTab;
  readonly selected: boolean;
  readonly diameter: number;
  readonly iconSize: number;
  readonly selectedColor: string;
  readonly unselectedColor: string;
  readonly indicatorColor: string;
  readonly onSelect: (tab: AndroidWorkspaceNavigationTab) => void;
}) {
  const { label, Icon } = destinations[props.tab];
  const radius = props.diameter / 2;
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(0.35);
  const opacity = useSharedValue(0);
  const ripple = useAnimatedStyle(() => ({
    opacity: opacity.get(),
    transform: [{ scale: scale.get() }],
  }));
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={{ selected: props.selected }}
      onPress={() => props.onSelect(props.tab)}
      onPressIn={() => {
        scale.set(reducedMotion ? 1 : 0.35);
        opacity.set(0.18);
        if (!reducedMotion)
          scale.set(withTiming(1, { duration: 220, easing: Easing.out(Easing.cubic) }));
      }}
      onPressOut={() => {
        opacity.set(reducedMotion ? 0 : withTiming(0, { duration: 180 }));
      }}
      style={{
        width: props.diameter,
        height: props.diameter,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius,
        overflow: "hidden",
        backgroundColor: props.selected ? props.indicatorColor : "transparent",
      }}
    >
      {/* 高亮和选中底色共用圆形边界，避免 Android 原生涟漪的矩形遮罩。 */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { borderRadius: radius, backgroundColor: props.selectedColor },
          ripple,
        ]}
      />
      <Icon
        size={props.iconSize}
        strokeWidth={2}
        color={props.selected ? props.selectedColor : props.unselectedColor}
      />
    </Pressable>
  );
}

export function FloatingWorkspaceDock(props: {
  readonly tabs: readonly AndroidWorkspaceNavigationTab[];
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly onSelect: (tab: AndroidWorkspaceNavigationTab) => void;
  readonly width: number;
  readonly height: number;
  readonly diameter: number;
  readonly composeSize: number;
  readonly scale: number;
  readonly selectedColor: string;
  readonly unselectedColor: string;
  readonly indicatorColor: string;
  readonly glassScope: DockGlassScope;
  readonly sampleGlass: boolean;
  readonly containerColor: string;
  readonly onNewThread?: () => void;
  readonly primaryColor: string;
  readonly primaryForeground: string;
}) {
  const iconSize = Math.min(28, Math.max(24, 24 * props.scale));
  return (
    <View
      pointerEvents="box-none"
      style={{ width: "100%", alignItems: "center", gap: FLOATING_TABS.gap }}
    >
      {props.onNewThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新会话"
          onPress={props.onNewThread}
          android_ripple={{ color: props.primaryForeground, borderless: false }}
          style={({ pressed }) => ({
            width: props.composeSize,
            height: props.composeSize,
            borderRadius: props.composeSize / 2,
            overflow: "hidden",
            alignSelf: "flex-end",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: props.primaryColor,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <IconEdit size={iconSize} color={props.primaryForeground} strokeWidth={2} />
        </Pressable>
      ) : null}
      <View
        accessibilityRole="tablist"
        style={{
          width: props.width,
          height: props.height,
          borderRadius: props.height / 2,
          overflow: "hidden",
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-around",
          paddingHorizontal: FLOATING_TABS.innerPadding,
        }}
      >
        <DockGlassBackdrop
          scope={props.glassScope}
          material="navigation"
          surfaceColor={props.containerColor}
          sample={props.sampleGlass}
          contentRevision={props.selectedTab}
          borderRadius={props.height / 2}
        />
        {props.tabs.map((tab) => (
          <FloatingWorkspaceTab
            key={tab}
            tab={tab}
            selected={props.selectedTab === tab}
            diameter={props.diameter}
            iconSize={iconSize}
            selectedColor={props.selectedColor}
            unselectedColor={props.unselectedColor}
            indicatorColor={props.indicatorColor}
            onSelect={props.onSelect}
          />
        ))}
      </View>
    </View>
  );
}
