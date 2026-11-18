import { describe, expect, it } from "vite-plus/test";
import { makeMobileAppStateWakeups } from "./app-state-wakeups";

describe("mobile foreground wakeups", () => {
  it("ignores duplicate active notifications and cold-start active", () => {
    const next = makeMobileAppStateWakeups("active", 0);
    expect(next("active", 100)).toBeNull();
    expect(next("background", 200)).toBeNull();
    expect(next("active", 500)).toBe("application-active-probe");
    expect(next("active", 600)).toBeNull();
  });
  it("immediately reconnects after long suspension through inactive", () => {
    const next = makeMobileAppStateWakeups("active", 0);
    next("background", 200);
    next("inactive", 20_000);
    expect(next("active", 20_001)).toBe("application-active-reconnect");
    expect(next("active", 20_002)).toBeNull();
  });
  it("tracks an app initialized in the background", () => {
    const next = makeMobileAppStateWakeups("background", 100);
    expect(next("active", 10_100)).toBe("application-active-reconnect");
  });
});
