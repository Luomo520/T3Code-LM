import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { reasoningSliderIndex, reasoningLevelLabel } from "./reasoning-slider-state";

/** Theme-aware neutral material; purple belongs only to the slider progress. */
export function useModelPopupColors() {
  const { themeAppearance, themeVariables } = useAppearancePreferences();
  const foreground = themeVariables["--color-foreground"];
  return {
    appearance: themeAppearance,
    panel: themeColorWithAlpha(themeVariables["--color-screen"], 0.6),
    rail: themeColorWithAlpha(foreground, 0.09),
    fill: "#cba6f7",
    text: foreground,
    muted: themeVariables["--color-foreground-muted"],
    border: themeColorWithAlpha(foreground, 0.12),
    title: foreground,
    selected: themeColorWithAlpha(foreground, 0.07),
    segment: themeColorWithAlpha(themeVariables["--color-screen"], 0.88),
    favorite: themeAppearance === "dark" ? "#ffbe55" : "#a56a00",
  };
}


type SliderChoice = { readonly id: string; readonly label: string; readonly isDefault?: boolean };

export function ReasoningSlider(props: {
  readonly choices: ReadonlyArray<SliderChoice>;
  readonly value: string | null;
  readonly modelLabel: string;
  readonly disabled?: boolean;
  readonly onChange: (value: string) => void;
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const colors = useModelPopupColors();
  // Release the surrounding scroll view if a provider/model switch unmounts a drag.
  const onDraggingChange = props.onDraggingChange;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- releases the parent scroll lock when this native drag surface unmounts
  useEffect(() => () => onDraggingChange(false), [onDraggingChange]);
  const [width, setWidth] = useState(0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const originX = useRef(0);
  const lastIndex = useRef(-1);
  const currentIndex = props.choices.findIndex((choice) => choice.id === props.value);
  const index = dragIndex ?? currentIndex;
  const current = props.choices[index];
  const defaultChoice = props.choices.find((choice) => choice.isDefault);
  const disabled = props.disabled || props.choices.length < 2;
  const fraction = index < 0 ? 0 : index / Math.max(1, props.choices.length - 1);
  const left = Math.max(0, width - 42) * fraction;
  const selectIndex = (next: number) => {
    const choice = props.choices[next];
    if (!choice || props.disabled) return;
    setDragIndex(next);
    if (lastIndex.current !== next) {
      lastIndex.current = next;
      props.onChange(choice.id);
    }
  };
  const finish = () => {
    setDragIndex(null);
    props.onDraggingChange(false);
  };
  return (
    <View style={{ paddingHorizontal: 6, paddingBottom: 12 }}>
      <View style={{ paddingHorizontal: 42, paddingTop: 16, paddingBottom: 8, alignItems: "center" }}>
        <Text accessibilityRole="header" style={{ fontSize: 18, lineHeight: 24, fontWeight: "600", color: colors.title }}>
          {current ? reasoningLevelLabel(current) : props.value ?? "思考强度"}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 19, color: colors.muted }}>{props.modelLabel}</Text>
        {defaultChoice ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`恢复默认思考强度 ${reasoningLevelLabel(defaultChoice)}`}
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            onPress={() => { finish(); props.onChange(defaultChoice.id); }}
            style={{ position: "absolute", right: 0, top: 8, width: 44, height: 44, alignItems: "center", justifyContent: "center", opacity: props.disabled ? 0.5 : 1 }}
          >
            <SymbolView name="arrow.clockwise" size={20} tintColor={colors.muted} />
          </Pressable>
        ) : null}
      </View>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="思考强度"
        accessibilityHint={props.disabled ? "由提示词控制" : "左右拖动或上下滑动调整档位"}
        accessibilityState={{ disabled }}
        accessibilityValue={{ min: 0, max: Math.max(0, props.choices.length - 1), ...(index >= 0 ? { now: index } : {}), text: current ? reasoningLevelLabel(current) : props.value ?? "未选择" }}
        accessibilityActions={disabled ? [] : [{ name: "increment", label: "提高思考强度" }, { name: "decrement", label: "降低思考强度" }]}
        onAccessibilityAction={(event) => {
          if (disabled) return;
          const step = event.nativeEvent.actionName === "increment" ? 1 : event.nativeEvent.actionName === "decrement" ? -1 : 0;
          if (step) {
            const next = props.choices[Math.max(0, Math.min(props.choices.length - 1, Math.max(0, currentIndex) + step))];
            if (next && next.id !== props.value) props.onChange(next.id);
          }
        }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => !disabled}
        onMoveShouldSetResponder={() => !disabled}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(event) => {
          originX.current = event.nativeEvent.pageX - event.nativeEvent.locationX;
          lastIndex.current = currentIndex;
          props.onDraggingChange(true);
          selectIndex(reasoningSliderIndex(event.nativeEvent.locationX, width, props.choices.length));
        }}
        onResponderMove={(event) => selectIndex(reasoningSliderIndex(event.nativeEvent.pageX - originX.current, width, props.choices.length))}
        onResponderRelease={finish}
        onResponderTerminate={finish}
        style={{ height: 52, justifyContent: "center", opacity: props.disabled ? 0.5 : 1 }}
      >
        <View pointerEvents="none" style={{ height: 36, backgroundColor: colors.rail, borderRadius: 22, overflow: "hidden" }}>
          {index >= 0 ? <View style={{ width: left + 21, height: 36, backgroundColor: colors.fill }} /> : null}
        </View>
        <View pointerEvents="none" style={{ position: "absolute", top: 23, left: 18, right: 18, flexDirection: "row", justifyContent: "space-between" }}>
          {props.choices.map((choice, stop) => <View key={choice.id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: stop <= index ? "#e7cef9" : "#72758e" }} />)}
        </View>
        {index >= 0 ? <View pointerEvents="none" style={{ position: "absolute", top: 5, left, width: 42, height: 42, borderRadius: 21, backgroundColor: "#fff" }} /> : null}
      </View>
      {props.disabled ? <Text style={{ textAlign: "center", fontSize: 11, lineHeight: 16, color: colors.muted }}>由提示词控制</Text> : defaultChoice ? <Text style={{ textAlign: "center", fontSize: 11, lineHeight: 16, color: colors.muted }}>{`默认：${reasoningLevelLabel(defaultChoice)}`}</Text> : null}
    </View>
  );
}
