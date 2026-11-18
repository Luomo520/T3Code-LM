import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

// Android can repair IME insets with did-events alone; will-events still release layout early.
let keyboardShowing = KeyboardController.isVisible();
const listeners = new Set<() => void>();
let stopListening: (() => void) | undefined;

function setKeyboardShowing(value: boolean) {
  if (keyboardShowing === value) return;
  keyboardShowing = value;
  for (const listener of listeners) listener();
}

export function refreshSoftKeyboardShowing() {
  setKeyboardShowing(KeyboardController.isVisible());
}

function subscribeKeyboardShowing(onChange: () => void) {
  listeners.add(onChange);
  if (listeners.size === 1) {
    const subscriptions = [
      KeyboardEvents.addListener("keyboardWillShow", () => setKeyboardShowing(true)),
      KeyboardEvents.addListener("keyboardDidShow", () => setKeyboardShowing(true)),
      KeyboardEvents.addListener("keyboardWillHide", () => setKeyboardShowing(false)),
      KeyboardEvents.addListener("keyboardDidHide", () => setKeyboardShowing(false)),
      AppState.addEventListener("change", (state) => {
        if (state === "active") refreshSoftKeyboardShowing();
      }),
    ];
    stopListening = () => {
      for (const subscription of subscriptions) subscription.remove();
    };
  }
  refreshSoftKeyboardShowing();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      stopListening?.();
      stopListening = undefined;
    }
  };
}
const getKeyboardShowing = () => keyboardShowing;

export function useSoftKeyboardShowing() {
  return useSyncExternalStore(subscribeKeyboardShowing, getKeyboardShowing);
}
