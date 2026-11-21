import { use, useRef, useState, type ReactNode } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type ViewInstance,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { DockGlassBackdrop } from "../../components/ui/DockGlass";
import { useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import {
  deriveMenuHorizontalPlacement,
  deriveMenuVerticalPlacement,
} from "../../lib/menu-placement";
import { WindowHingeContext } from "../../native/window-hinge-context";
import { useModelPopupColors } from "./ReasoningSlider";

export function PopupChoice(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly isDefault?: boolean;
  readonly disabled?: boolean;
  readonly description?: string;
  readonly showDescription?: boolean;
  readonly onPress: () => void;
}) {
  const colors = useModelPopupColors();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={[props.label, props.isDefault ? "默认" : null, props.description]
        .filter(Boolean)
        .join("，")}
      accessibilityState={{ checked: props.selected, disabled: props.disabled === true }}
      disabled={props.disabled}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2 rounded-lg px-3 py-2 active:opacity-60",
        props.disabled && "opacity-50",
      )}
      style={{ minHeight: 48, backgroundColor: props.selected ? colors.selected : "transparent" }}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text
          className={cn("text-sm", props.selected && "font-t3-medium")}
          style={{ color: colors.text }}
        >
          {props.label}
        </Text>
        {props.description && props.showDescription ? (
          <Text className="text-xs" style={{ color: colors.muted }}>
            {props.description}
          </Text>
        ) : null}
      </View>
      {props.isDefault ? <Text style={{ fontSize: 12, color: colors.muted }}>默认</Text> : null}
      <View className="w-5 items-center">
        {props.selected ? <SymbolView name="checkmark" size={15} tintColor={colors.text} /> : null}
      </View>
    </Pressable>
  );
}

export type PopupFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export function PopupChoicesDialog(props: {
  readonly title: string;
  readonly anchor?: PopupFrame;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const colors = useModelPopupColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReduceMotionEnabled();
  const hinge = use(WindowHingeContext);
  const frameRef = useRef<ViewInstance>(null);
  const [frame, setFrame] = useState<PopupFrame | null>(null);
  const { width, height } = useWindowDimensions();
  const margin = 12;
  const placement =
    props.anchor && frame
      ? {
          position: "absolute" as const,
          ...deriveMenuHorizontalPlacement({
            anchorX: props.anchor.x - frame.x,
            anchorWidth: props.anchor.width,
            overlayWidth: frame.width,
            desiredWidth: 280,
            margin,
            hinge: hinge && { x: hinge.x - frame.x, width: hinge.width },
          }),
          ...deriveMenuVerticalPlacement({
            anchorY: props.anchor.y - frame.y,
            anchorHeight: props.anchor.height,
            overlayHeight: frame.height,
            keyboardInset: 0,
            gap: 6,
            margin,
            minHeight: 144,
          }),
        }
      : {
          width: Math.min(280, width - insets.left - insets.right - margin * 2),
          maxHeight: Math.min(424, height - insets.top - insets.bottom - margin * 2),
        };

  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType={reducedMotion || props.anchor ? "none" : "fade"}
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1"
        style={{
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <Pressable
          accessible={false}
          className={cn("absolute inset-0", !props.anchor && "bg-backdrop")}
          onPress={props.onClose}
        />
        <View
          ref={frameRef}
          collapsable={false}
          pointerEvents="box-none"
          className="flex-1 items-center justify-center"
          onLayout={() => {
            if (props.anchor) {
              frameRef.current?.measureInWindow((x, y, width, height) => {
                setFrame({ x, y, width, height });
              });
            }
          }}
        >
          {!props.anchor || frame ? (
            <View
              accessibilityViewIsModal
              className="overflow-hidden"
              style={{
                ...placement,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.panel,
              }}
            >
              <DockGlassBackdrop scope="thread" material="popup" />
              <Text
                accessibilityRole="header"
                className="px-4 pb-1.5 pt-3 text-sm font-t3-semibold"
                style={{ color: colors.text }}
              >
                {props.title}
              </Text>
              <ScrollView
                accessibilityRole="radiogroup"
                accessibilityLabel={props.title}
                className="shrink"
                contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 6 }}
                keyboardShouldPersistTaps="handled"
              >
                {props.error ? (
                  <Text
                    accessibilityLiveRegion="polite"
                    className="px-3 py-2 text-xs text-danger-foreground"
                  >
                    {props.error}
                  </Text>
                ) : null}
                {props.children}
              </ScrollView>
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}
