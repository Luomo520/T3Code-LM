import type { Wakeups } from "@t3tools/client-runtime/connection";

const MOBILE_LONG_BACKGROUND_AFTER_MS = 10_000;

export function makeMobileAppStateWakeups(
  initialState: string | null | undefined,
  startedAtMs: number,
) {
  let previous = initialState;
  let backgroundedAtMs = initialState === "background" ? startedAtMs : null;
  return (state: string, nowMs: number): MobileApplicationActiveWakeup | null => {
    if (state === previous) return null;
    previous = state;
    if (state === "background") {
      backgroundedAtMs = nowMs;
      return null;
    }
    if (state !== "active") return null;
    const wakeup = mobileApplicationActiveWakeup(backgroundedAtMs, nowMs);
    backgroundedAtMs = null;
    return wakeup;
  };
}

export type MobileApplicationActiveWakeup = Extract<
  Wakeups.ConnectionWakeup,
  "application-active-probe" | "application-active-long"
>;

export function mobileApplicationActiveWakeup(
  backgroundedAtMs: number | null,
  activeAtMs: number,
): MobileApplicationActiveWakeup {
  return backgroundedAtMs !== null &&
    activeAtMs - backgroundedAtMs >= MOBILE_LONG_BACKGROUND_AFTER_MS
    ? "application-active-long"
    : "application-active-probe";
}
