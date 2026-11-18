import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  visible: false,
  keyboardListeners: new Map<string, Set<() => void>>(),
  appListeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native-keyboard-controller", () => ({
  KeyboardController: { isVisible: () => native.visible },
  KeyboardEvents: {
    addListener: (name: string, listener: () => void) => {
      const named = native.keyboardListeners.get(name) ?? new Set();
      named.add(listener);
      native.keyboardListeners.set(name, named);
      return { remove: () => named.delete(listener) };
    },
  },
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_name: string, listener: (state: string) => void) => {
      native.appListeners.add(listener);
      return { remove: () => native.appListeners.delete(listener) };
    },
  },
}));

import { useSoftKeyboardShowing } from "./useSoftKeyboardShowing";

function Status() {
  return <output>{String(useSoftKeyboardShowing())}</output>;
}

function renderStatus(consumers = 1) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.visible = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(Array.from({ length: consumers }, (_, index) => <Status key={index} />)));
  return {
    container,
    [Symbol.dispose]: () => {
      act(() => root.unmount());
      native.visible = false;
    },
  };
}

function emit(name: string, visible: boolean) {
  native.visible = visible;
  act(() => {
    for (const listener of native.keyboardListeners.get(name) ?? []) listener();
  });
}

it("follows did-only IME repairs when Android skips the will events", () => {
  using screen = renderStatus();
  emit("keyboardDidShow", true);
  expect(screen.container.textContent).toBe("true");
  emit("keyboardDidHide", false);
  expect(screen.container.textContent).toBe("false");
});

it("resynchronizes all mounted consumers when returning from the background", () => {
  using screen = renderStatus(2);
  emit("keyboardWillShow", true);
  expect(screen.container.textContent).toBe("truetrue");
  native.visible = false;
  act(() => {
    for (const listener of native.appListeners) listener("active");
  });
  expect(screen.container.textContent).toBe("falsefalse");
});

it("hides navigation at willShow and restores it at willHide without awaiting the animation", () => {
  using screen = renderStatus();
  emit("keyboardWillShow", true);
  expect(screen.container.textContent).toBe("true");
  emit("keyboardWillHide", false);
  expect(screen.container.textContent).toBe("false");
});

it("removes native event subscriptions after the last consumer leaves", () => {
  {
    using _screen = renderStatus(2);
    expect(native.appListeners.size).toBe(1);
    expect(native.keyboardListeners.get("keyboardDidHide")?.size).toBe(1);
  }
  expect(native.appListeners.size).toBe(0);
  for (const listeners of native.keyboardListeners.values()) expect(listeners.size).toBe(0);
});
