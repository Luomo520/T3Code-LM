import IconMessages from "@tabler/icons-react-native/IconMessages";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconChartBar from "@tabler/icons-react-native/IconChartBar";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import { useLayoutEffect, useRef } from "react";
import { I18nManager, Pressable, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { DockGlassBackdrop, type DockGlassScope } from "../../../components/ui/DockGlass";
import { useReduceMotionEnabled } from "../../../lib/appState";
import { FLOATING_TABS } from "./floating-workspace-tabs";
import type { AndroidWorkspaceNavigationTab } from "./android-workspace-tabs";

const destinations = {
  threads: { label: "会话", Icon: IconMessages },
  pullRequests: { label: "拉取请求", Icon: IconGitPullRequest },
  usage: { label: "用量", Icon: IconChartBar },
  settings: { label: "设置", Icon: IconSettings },
};

// 减少动态效果由系统订阅统一处理，允许设置在应用运行期间切换。
const indicatorSpring = {
  mass: 0.82,
  damping: 27,
  stiffness: 380,
  reduceMotion: ReduceMotion.Never,
};
const releaseSpring = { mass: 0.48, damping: 16, stiffness: 380, reduceMotion: ReduceMotion.Never };
const pressTiming = { duration: 90, reduceMotion: ReduceMotion.Never };

export function FloatingWorkspaceDock(props: {
  readonly tabs: readonly AndroidWorkspaceNavigationTab[];
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly onSelect: (tab: AndroidWorkspaceNavigationTab, touchTimestamp: number) => void;
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
  const reducedMotion = useReduceMotionEnabled();
  const selectedIndex = props.tabs.indexOf(props.selectedTab);
  const position = useSharedValue(selectedIndex);
  const deformation = useSharedValue(0);
  const pressedTab = useRef<AndroidWorkspaceNavigationTab | null>(null);
  const slot =
    Math.max(0, props.width - 2 * FLOATING_TABS.innerPadding) / Math.max(1, props.tabs.length);
  const direction = I18nManager.isRTL ? -1 : 1;
  const diameter = props.diameter;
  const radius = diameter / 2;

  // 位置用标签序号表示，变宽或旋转后，正在移动的选中块仍和图标共用当前槽距。
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 同步原生动画目标与当前路由选中项
  useLayoutEffect(() => {
    if (reducedMotion) {
      position.set(selectedIndex);
      deformation.set(0);
    } else {
      position.set(withSpring(selectedIndex, indicatorSpring));
    }
  }, [deformation, position, reducedMotion, selectedIndex]);

  function pressIn(tab: AndroidWorkspaceNavigationTab) {
    pressedTab.current = tab;
    if (!reducedMotion) deformation.set(withTiming(1, pressTiming));
  }

  function pressOut(tab: AndroidWorkspaceNavigationTab) {
    // Pressable 可能延迟派发松手。前一个标签的事件不应结束新标签的按压反馈。
    if (pressedTab.current !== tab) return;
    pressedTab.current = null;
    if (!reducedMotion) deformation.set(withSpring(0, releaseSpring));
  }

  const indicatorStyle = useAnimatedStyle(() => {
    const press = reducedMotion ? 0 : deformation.get();
    const index = reducedMotion ? selectedIndex : position.get();
    return {
      transform: [
        { translateX: index * slot * direction },
        { scaleX: 1 - press * 0.1 },
        { scaleY: 1 + press * 0.04 },
      ],
    };
  });
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
        {selectedIndex >= 0 && diameter > 0 ? (
          <Animated.View
            pointerEvents="none"
            importantForAccessibility="no"
            style={[
              {
                position: "absolute",
                start: FLOATING_TABS.innerPadding + (slot - diameter) / 2,
                top: (props.height - diameter) / 2,
                width: diameter,
                height: diameter,
                borderRadius: radius,
                backgroundColor: props.indicatorColor,
              },
              indicatorStyle,
            ]}
          />
        ) : null}
        {props.tabs.map((tab) => {
          const { label, Icon } = destinations[tab];
          const selected = props.selectedTab === tab;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              onPress={(event) => props.onSelect(tab, event.nativeEvent.timestamp)}
              onPressIn={() => pressIn(tab)}
              onPressOut={() => pressOut(tab)}
              style={({ pressed }) => ({
                width: diameter,
                height: diameter,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius,
                overflow: "hidden",
                opacity: pressed ? 0.65 : 1,
              })}
            >
              <Icon
                size={iconSize}
                strokeWidth={2}
                color={selected ? props.selectedColor : props.unselectedColor}
              />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
