import { useEffect, useId, useRef, useState } from "react";
import { Animated, Easing, Platform, Pressable, useAnimatedValue, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { useReduceMotionEnabled } from "../../lib/appState";
import {
  REASONING_THUMB_DIAMETER,
  reasoningLevelLabel,
  reasoningRailHighlightMode,
  REASONING_FLOW_PERIOD,
  REASONING_FLOW_DURATION,
  reasoningFlowTileCount,
  reasoningSliderFillWidth,
  reasoningSliderIndex,
} from "./reasoning-slider-state";

const RAIL_HEIGHT = Platform.OS === "android" ? 36 : 48;
const TOUCH_HEIGHT = 52;

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

const FLOW_STOPS = [
  "#cba6f7",
  "#cba8f7",
  "#cbb0f8",
  "#cbbbf9",
  "#cdc8fb",
  "#cfd4fc",
  "#d2defe",
  "#d4e4ff",
  "#d5e6ff",
  "#d4e4ff",
  "#d2defe",
  "#cfd4fc",
  "#cdc8fb",
  "#cbbbf9",
  "#cbb0f8",
  "#cba8f7",
  "#cba6f7",
].map((color, index, colors) => ({ color, offset: index / (colors.length - 1) }));

function ReasoningFillHighlight({
  railWidth,
  moving,
}: {
  readonly railWidth: number;
  readonly moving: boolean;
}) {
  const gradientId = `reasoning-flow-${useId().replaceAll(":", "")}`;
  const translateX = useAnimatedValue(0, { useNativeDriver: true });
  const tileCount = reasoningFlowTileCount(railWidth);
  const width = tileCount * REASONING_FLOW_PERIOD;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 只在允许动画时运行，切档仅改变外层裁切宽度。
  useEffect(() => {
    translateX.setValue(0);
    if (!moving) return;
    const loop = Animated.loop(
      Animated.timing(translateX, {
        toValue: -REASONING_FLOW_PERIOD,
        duration: REASONING_FLOW_DURATION,
        easing: Easing.linear,
        useNativeDriver: true,
        isInteraction: false,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [moving, translateX]);

  return (
    <Animated.View
      pointerEvents="none"
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width,
        height: RAIL_HEIGHT,
        transform: [{ translateX }],
      }}
    >
      <Svg width={width} height={RAIL_HEIGHT} accessible={false}>
        <Defs>
          <LinearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="0%">
            {FLOW_STOPS.map(({ color, offset }) => (
              <Stop key={offset} offset={offset} stopColor={color} />
            ))}
          </LinearGradient>
        </Defs>
        {Array.from({ length: tileCount }, (_, index) => (
          <Rect
            key={index}
            x={index * REASONING_FLOW_PERIOD}
            width={REASONING_FLOW_PERIOD}
            height={RAIL_HEIGHT}
            fill={`url(#${gradientId})`}
          />
        ))}
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
  readonly highlightMoving: boolean;
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
    Platform.OS === "android" && width > REASONING_THUMB_DIAMETER && !props.disabled,
    reducedMotion || !props.highlightMoving,
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
      <View
        style={{ paddingHorizontal: 42, paddingTop: 16, paddingBottom: 8, alignItems: "center" }}
      >
        <Text
          accessibilityRole="header"
          style={{ fontSize: 18, lineHeight: 24, fontWeight: "600", color: colors.title }}
        >
          {current ? reasoningLevelLabel(current) : (props.value ?? "思考强度")}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 12, lineHeight: 19, color: colors.muted }}>
          {props.modelLabel}
        </Text>
        {defaultChoice ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`恢复默认思考强度 ${reasoningLevelLabel(defaultChoice)}`}
            accessibilityState={{ disabled: props.disabled === true }}
            disabled={props.disabled}
            onPress={() => {
              finish();
              props.onChange(defaultChoice.id);
            }}
            style={{
              position: "absolute",
              right: 0,
              top: 8,
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: props.disabled ? 0.5 : 1,
            }}
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
        accessibilityValue={{
          min: 0,
          max: Math.max(0, props.choices.length - 1),
          ...(index >= 0 ? { now: index } : {}),
          text: current ? reasoningLevelLabel(current) : (props.value ?? "未选择"),
        }}
        accessibilityActions={
          disabled
            ? []
            : [
                { name: "increment", label: "提高思考强度" },
                { name: "decrement", label: "降低思考强度" },
              ]
        }
        onAccessibilityAction={(event) => {
          if (disabled) return;
          const step =
            event.nativeEvent.actionName === "increment"
              ? 1
              : event.nativeEvent.actionName === "decrement"
                ? -1
                : 0;
          if (step) {
            const next =
              props.choices[
                Math.max(0, Math.min(props.choices.length - 1, Math.max(0, currentIndex) + step))
              ];
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
          selectIndex(
            reasoningSliderIndex(event.nativeEvent.locationX, width, props.choices.length),
          );
        }}
        onResponderMove={(event) =>
          selectIndex(
            reasoningSliderIndex(
              event.nativeEvent.pageX - originX.current,
              width,
              props.choices.length,
            ),
          )
        }
        onResponderRelease={finish}
        onResponderTerminate={finish}
        style={{
          height: TOUCH_HEIGHT,
          justifyContent: "center",
          opacity: props.disabled ? 0.5 : 1,
        }}
      >
        <View
          pointerEvents="none"
          style={{
            height: RAIL_HEIGHT,
            backgroundColor: colors.rail,
            borderRadius: RAIL_HEIGHT / 2,
            overflow: "hidden",
          }}
        >
          {filledWidth > 0 ? (
            <View
              style={{
                width: filledWidth,
                height: RAIL_HEIGHT,
                backgroundColor: colors.fill,
                overflow: "hidden",
              }}
            >
              {highlight !== "off" ? (
                <ReasoningFillHighlight railWidth={width} moving={highlight === "sweep"} />
              ) : null}
            </View>
          ) : null}
        </View>
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: (TOUCH_HEIGHT - tickDiameter) / 2,
            left: tickInset,
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
              top: (TOUCH_HEIGHT - REASONING_THUMB_DIAMETER) / 2,
              left: filledWidth - thumbRadius,
              width: REASONING_THUMB_DIAMETER,
              height: REASONING_THUMB_DIAMETER,
              borderRadius: thumbRadius,
              backgroundColor: "#fff",
              ...(Platform.OS === "android" && {
                borderWidth: 1,
                borderColor: "#33294216",
                boxShadow: "0 1px 3px #33294221",
              }),
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
