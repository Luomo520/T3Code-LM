import { useEffect, useId, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, useAnimatedValue, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useReduceMotionEnabled } from "../../lib/appState";
import {
  REASONING_RAIL_LEFT_EXTENSION,
  REASONING_THUMB_DIAMETER,
  reasoningLevelLabel,
  reasoningRailHighlightMode,
  reasoningRailSweep,
  reasoningSliderFillWidth,
  reasoningSliderIndex,
} from "./reasoning-slider-state";

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

function ReasoningFillHighlight(props: {
  readonly filledWidth: number;
  readonly moving: boolean;
}) {
  const gradientId = `reasoning-highlight-${useId().replaceAll(":", "")}`;
  const progress = useAnimatedValue(0, { useNativeDriver: true });
  const sweep = reasoningRailSweep(props.filledWidth);
  const opacity = props.moving ? 0.86 : 0.56;
  const translateX = props.moving
    ? progress.interpolate({ inputRange: [0, 1], outputRange: [sweep.start, sweep.end] })
    : undefined;
  // Keep a native animation and its phase when dragging changes the fill width.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts and cancels the native highlight loop with the popup's visibility
  useEffect(() => {
    if (!props.moving) return;
    progress.setValue(0);
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: 3_600,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [progress, props.moving]);

  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        left: 0,
        width: props.moving ? sweep.width : props.filledWidth,
        transform: translateX ? [{ translateX }] : undefined,
      }}
    >
      <Svg width="100%" height="100%" accessible={false}>
        <Defs>
          <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="10%">
            <Stop offset="0%" stopColor="#c8a8f1" stopOpacity={0} />
            <Stop offset="26%" stopColor="#cdb7f8" stopOpacity={opacity * 0.5} />
            <Stop offset="46%" stopColor="#bbccf6" stopOpacity={opacity} />
            <Stop offset="62%" stopColor="#d7caf4" stopOpacity={opacity * 0.55} />
            <Stop offset="100%" stopColor="#c8a8f1" stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradientId})`} />
      </Svg>
    </Animated.View>
  );
}

type SliderChoice = { readonly id: string; readonly label: string; readonly isDefault?: boolean };

export function ReasoningSlider(props: {
  readonly choices: ReadonlyArray<SliderChoice>;
  readonly value: string | null;
  readonly modelLabel: string;
  readonly disabled?: boolean;
  readonly defaultValue?: string | null;
  readonly defaultEditorExpanded?: boolean;
  readonly defaultSaving?: boolean;
  readonly defaultEditUnavailable?: string | undefined;
  readonly highlightEnabled: boolean;
  readonly onEditDefault?: () => void;
  readonly onChange: (value: string) => void;
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const colors = useModelPopupColors();
  const reducedMotion = useReduceMotionEnabled();
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
  const defaultChoice =
    props.choices.find((choice) => choice.id === props.defaultValue) ??
    props.choices.find((choice) => choice.isDefault);
  const defaultLabel = defaultChoice ? reasoningLevelLabel(defaultChoice) : "Auto";
  const disabled = props.disabled || props.choices.length < 2;
  const filledWidth = reasoningSliderFillWidth(index, width, props.choices.length);
  const thumbRadius = REASONING_THUMB_DIAMETER / 2;
  const tickDiameter = 6;
  const tickInset = thumbRadius - tickDiameter / 2;
  const highlight = reasoningRailHighlightMode(
    index,
    props.choices.length,
    Platform.OS === "android" &&
      width > REASONING_THUMB_DIAMETER + REASONING_RAIL_LEFT_EXTENSION &&
      props.highlightEnabled &&
      !props.disabled,
    reducedMotion,
  );
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
        style={{
          height: 52,
          marginLeft: -REASONING_RAIL_LEFT_EXTENSION,
          justifyContent: "center",
          opacity: props.disabled ? 0.5 : 1,
        }}
      >
        <View
          pointerEvents="none"
          style={{ height: 36, backgroundColor: colors.rail, borderRadius: 22, overflow: "hidden" }}
        >
          {filledWidth > 0 ? (
            <View style={{ width: filledWidth, height: 36, backgroundColor: colors.fill, overflow: "hidden" }}>
              {highlight !== "off" ? (
                <ReasoningFillHighlight filledWidth={filledWidth} moving={highlight === "sweep"} />
              ) : null}
            </View>
          ) : null}
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 23,
            left: tickInset + REASONING_RAIL_LEFT_EXTENSION,
            right: tickInset,
            flexDirection: "row",
            justifyContent: "space-between",
          }}
        >
          {props.choices.map((choice, stop) => (
            <View
              key={choice.id}
              style={{
                width: tickDiameter,
                height: tickDiameter,
                borderRadius: tickDiameter / 2,
                backgroundColor: stop <= index ? "#e7cef9" : "#72758e",
              }}
            />
          ))}
        </View>
        {index >= 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 5,
              left: filledWidth - thumbRadius,
              width: REASONING_THUMB_DIAMETER,
              height: REASONING_THUMB_DIAMETER,
              borderRadius: thumbRadius,
              backgroundColor: "#fff",
            }}
          />
        ) : null}
      </View>
      {props.disabled ? (
        <Text style={{ textAlign: "center", fontSize: 11, lineHeight: 16, color: colors.muted }}>
          由提示词控制
        </Text>
      ) : null}
      {props.onEditDefault ? (
        <View className="min-h-12 items-center justify-center">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`默认思考强度 ${defaultLabel}`}
            accessibilityHint="打开默认思考强度选项"
            accessibilityState={{
              expanded: props.defaultEditorExpanded === true,
              disabled: props.defaultSaving === true,
              busy: props.defaultSaving === true,
            }}
            disabled={props.defaultSaving}
            onPress={props.onEditDefault}
            hitSlop={10}
            className="min-h-7 self-center items-center justify-center rounded-full px-2.5 active:opacity-60"
            style={{ backgroundColor: colors.rail, opacity: props.defaultSaving ? 0.6 : 1 }}
          >
            <Text style={{ fontSize: 12, color: colors.text }}>{`默认：${defaultLabel}`}</Text>
          </Pressable>
        </View>
      ) : defaultChoice || props.defaultEditUnavailable ? (
        <Text
          accessibilityHint={props.defaultEditUnavailable}
          style={{ textAlign: "center", fontSize: 12, lineHeight: 18, color: colors.muted }}
        >
          {`默认：${defaultLabel}`}
        </Text>
      ) : null}
    </View>
  );
}
