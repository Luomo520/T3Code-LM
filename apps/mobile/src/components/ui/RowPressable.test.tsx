import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const motion = vi.hoisted(() => ({
  reduced: false,
  shrink: vi.fn((value: number) => value),
  release: vi.fn((value: number) => value),
}));

vi.mock("react-native", () => ({
  StyleSheet: { absoluteFill: {} },
  View: ({ style }: { readonly style?: unknown }) => <div data-layer={JSON.stringify(style)} />,
  Pressable: ({
    children,
    onPress,
    onLongPress,
  }: {
    readonly children: (state: { readonly pressed: boolean }) => ReactNode;
    readonly onPress?: () => void;
    readonly onLongPress?: () => void;
  }) => {
    const [pressed, setPressed] = useState(false);
    return (
      <button
        onPointerDown={() => setPressed(true)}
        onPointerCancel={() => setPressed(false)}
        onPointerUp={() => setPressed(false)}
        onClick={onPress}
        onContextMenu={onLongPress}
      >
        {children({ pressed })}
      </button>
    );
  },
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { readonly children: ReactNode }) => children,
}));
vi.mock("../../lib/useHoverGesture", () => ({
  useHoverGesture: () => ({ hovered: false }),
}));
vi.mock("../../lib/appState", () => ({
  useReduceMotionEnabled: () => motion.reduced,
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children: ReactNode }) => <div>{children}</div> },
  ReduceMotion: { Never: "never" },
  useAnimatedStyle: () => ({}),
  useSharedValue: () => useState(() => ({ set: () => undefined }))[0],
  withTiming: motion.shrink,
  withSpring: motion.release,
}));

import { RowPressable } from "./RowPressable";

it.each([false, true])(
  "shows a tint on contact and clears it on cancel with reduced motion=%s",
  async (reduced) => {
    motion.reduced = reduced;
    motion.shrink.mockClear();
    motion.release.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    const color = "rgba(40, 103, 239, 0.18)";
    try {
      await act(async () =>
        root.render(
          <RowPressable touchFeedbackColor={color} onPress={onPress} onLongPress={onLongPress}>
            会话
          </RowPressable>,
        ),
      );
      const button = container.querySelector("button")!;
      const layer = () =>
        JSON.parse(
          button.querySelector('[data-layer*="backgroundColor"]')!.getAttribute("data-layer")!,
        ).at(-1);
      expect(layer()).toEqual({ backgroundColor: color, opacity: 0 });
      motion.release.mockClear();

      await act(async () => {
        button.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      });
      expect(layer()).toEqual({ backgroundColor: color, opacity: 1 });
      expect(motion.shrink).toHaveBeenCalledTimes(reduced ? 0 : 1);
      expect(onPress).not.toHaveBeenCalled();

      await act(async () => {
        button.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
        button.dispatchEvent(new Event("pointercancel", { bubbles: true }));
      });
      expect(layer().opacity).toBe(0);
      expect(motion.release).toHaveBeenCalledTimes(reduced ? 0 : 1);
      expect(onLongPress).toHaveBeenCalledOnce();
      expect(onPress).not.toHaveBeenCalled();

      await act(async () => button.click());
      expect(onPress).toHaveBeenCalledOnce();
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
