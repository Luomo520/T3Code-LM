import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";

export function useHeaderUsagePolling(
  enabled: boolean,
  identity: string,
  refresh: () => void,
  refreshOnView: () => void,
) {
  const readCurrent = useEffectEvent(refresh);
  const refreshCurrentOnView = useEffectEvent(refreshOnView);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the active target's polling timer and AppState listener; response callbacks change without restarting this subscription
  useEffect(() => {
    if (!enabled || !identity) return;
    if (AppState.currentState === "active") refreshCurrentOnView();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") readCurrent();
    }, 2000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshCurrentOnView();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
    };
  }, [enabled, identity]);
}
