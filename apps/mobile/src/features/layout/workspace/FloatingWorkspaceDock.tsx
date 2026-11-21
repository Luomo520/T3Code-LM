import IconMessages from "@tabler/icons-react-native/IconMessages";
import IconGitPullRequest from "@tabler/icons-react-native/IconGitPullRequest";
import IconChartBar from "@tabler/icons-react-native/IconChartBar";
import IconEdit from "@tabler/icons-react-native/IconEdit";
import IconSettings from "@tabler/icons-react-native/IconSettings";
import { Pressable, View } from "react-native";

import { DockGlassBackdrop, type DockGlassScope } from "../../../components/ui/DockGlass";
import { FLOATING_TABS } from "./floating-workspace-tabs";
import type { AndroidWorkspaceNavigationTab } from "./android-workspace-tabs";

const destinations = {
  threads: { label: "会话", Icon: IconMessages },
  pullRequests: { label: "拉取请求", Icon: IconGitPullRequest },
  usage: { label: "用量", Icon: IconChartBar },
  settings: { label: "设置", Icon: IconSettings },
};

/** Floating navigation uses regular RN views, independent of the native Compose lifecycle. */
export function FloatingWorkspaceDock(props: {
  readonly tabs: readonly AndroidWorkspaceNavigationTab[];
  readonly selectedTab: AndroidWorkspaceNavigationTab;
  readonly onSelect: (tab: AndroidWorkspaceNavigationTab) => void;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly selectedColor: string;
  readonly unselectedColor: string;
  readonly indicatorColor: string;
  readonly glassScope: DockGlassScope;
  readonly onNewThread?: () => void;
  readonly primaryColor: string;
  readonly primaryForeground: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: FLOATING_TABS.gap }}>
      <View
        accessibilityRole="tablist"
        style={{
          width: props.width,
          height: props.height,
          borderRadius: props.height / 2,
          overflow: "hidden",
          flexDirection: "row",
          paddingHorizontal: 4,
        }}
      >
        <DockGlassBackdrop
          scope={props.glassScope}
          material="navigation"
          borderRadius={props.height / 2}
        />
        {props.tabs.map((tab) => {
          const { label, Icon } = destinations[tab];
          const selected = props.selectedTab === tab;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityLabel={label}
              accessibilityState={{ selected }}
              onPress={() => props.onSelect(tab)}
              android_ripple={{ color: props.indicatorColor, borderless: false }}
              style={({ pressed }) => ({
                flex: 1,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: props.height / 2,
                overflow: "hidden",
                opacity: pressed ? 0.65 : 1,
                transform: [{ scale: pressed ? 0.94 : 1 }],
              })}
            >
              <View
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 999,
                  overflow: "hidden",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: selected ? props.indicatorColor : "transparent",
                }}
              >
                <Icon
                  size={Math.min(26, 22 * props.scale)}
                  strokeWidth={2}
                  color={selected ? props.selectedColor : props.unselectedColor}
                />
              </View>
            </Pressable>
          );
        })}
      </View>
      {props.onNewThread ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="新建任务"
          onPress={props.onNewThread}
          android_ripple={{ color: props.primaryForeground, borderless: false }}
          style={({ pressed }) => ({
            width: props.height,
            height: props.height,
            borderRadius: props.height / 2,
            overflow: "hidden",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: props.primaryColor,
            opacity: pressed ? 0.7 : 1,
            transform: [{ scale: pressed ? 0.94 : 1 }],
          })}
        >
          <IconEdit
            size={Math.min(26, 22 * props.scale)}
            color={props.primaryForeground}
            strokeWidth={2}
          />
        </Pressable>
      ) : null}
    </View>
  );
}
