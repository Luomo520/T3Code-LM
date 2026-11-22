import { expect, it } from "vite-plus/test";

import { floatingDockBottomClearance, floatingDockMetrics } from "./floating-workspace-tabs";
import { resolveAndroidNavigationStyle } from "../../../lib/androidNavigationStyle";

it.each([
  [undefined, "Samsung", false, "one-ui"],
  [undefined, "samsung", false, "one-ui"],
  [undefined, "Google", false, "material"],
  [undefined, null, false, "material"],
  [undefined, "Google", true, "one-ui"],
  ["material", "Samsung", false, "material"],
  ["one-ui", "Google", false, "one-ui"],
  ["material", "Google", true, "material"],
] as const)(
  "resolves navigation preference %s on %s with preview %s",
  (preference, manufacturer, preview, expected) => {
    expect(resolveAndroidNavigationStyle(preference, manufacturer, preview)).toBe(expected);
  },
);

it.each([280, 300, 320, 360, 390, 728])("fits four tabs inside a %sdp phone or pane", (width) => {
  for (const fabSize of [48, 56, 77]) {
    const available = width - 32;
    const dock = floatingDockMetrics(4, fabSize, available);
    expect(dock.width).toBeLessThanOrEqual(available);
    expect(dock.diameter).toBeGreaterThanOrEqual(48);
    expect(4 * dock.diameter + 12).toBeLessThanOrEqual(dock.width);
    expect(dock.diameter + 12).toBeLessThanOrEqual(dock.height);
    const bottom = floatingDockBottomClearance(24, fabSize, false);
    expect(floatingDockBottomClearance(24, fabSize, true) - bottom).toBe(fabSize + 12);
  }
});
