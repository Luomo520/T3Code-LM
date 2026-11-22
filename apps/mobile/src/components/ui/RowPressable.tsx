import { useLayoutEffect, type ComponentProps, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { useReduceMotionEnabled } from "../../lib/appState";
import { cn } from "../../lib/cn";
import { useHoverGesture } from "../../lib/useHoverGesture";

export function RowPressable({
  children,
  className,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  touchFeedbackColor,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
  readonly touchFeedbackColor?: string | undefined;
}) {
  const { hovered, hoverGesture } = useHoverGesture(props.disabled ?? false);
  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable {...props} className={cn("relative overflow-hidden", className)}>
        {({ pressed }) => (
          <>
            <View
              pointerEvents="none"
              className={cn("absolute inset-0", interactionClassName)}
              style={{ opacity: props.disabled || !hovered ? 0 : interactionOpacity }}
            />
            {touchFeedbackColor === undefined ? (
              children
            ) : (
              <RowTouchFeedback pressed={!props.disabled && pressed} color={touchFeedbackColor}>
                {children}
              </RowTouchFeedback>
            )}
          </>
        )}
      </Pressable>
    </GestureDetector>
  );
}

function RowTouchFeedback({
  children,
  color,
  pressed,
}: {
  readonly children: ReactNode;
  readonly color: string;
  readonly pressed: boolean;
}) {
  const reduceMotion = useReduceMotionEnabled();
  const scale = useSharedValue(1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 将 Pressable 状态同步到原生缩放
  useLayoutEffect(() => {
    scale.set(
      reduceMotion
        ? 1
        : pressed
          ? withTiming(0.982, { duration: 75, reduceMotion: ReduceMotion.Never })
          : withSpring(1, {
              mass: 0.5,
              stiffness: 390,
              damping: 18,
              reduceMotion: ReduceMotion.Never,
            }),
    );
  }, [pressed, reduceMotion, scale]);
  const motionStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduceMotion ? 1 : scale.get() }],
  }));

  return (
    <>
      <View
        pointerEvents="none"
        importantForAccessibility="no"
        style={[StyleSheet.absoluteFill, { backgroundColor: color, opacity: pressed ? 1 : 0 }]}
      />
      {/* 缩放行内容，让列宽、触摸区域和手势竞争继续由原有 Pressable 决定。 */}
      <Animated.View pointerEvents="box-none" style={motionStyle}>
        {children}
      </Animated.View>
    </>
  );
}
