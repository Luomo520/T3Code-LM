import { expect, it } from "vite-plus/test";

import { floatingTabsMetrics, floatingDockMetrics } from "./floating-workspace-tabs";
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

it.each([
  [475, 1, 56, 4, 56],
  [411, 1, 56, 4, 56],
  [475, 1.25, 70, 4, 70],
  [320, 11 / 16, 48, 4, 48],
  [320, 1, 56, 4, 55.2],
  [320, 22 / 16, 77, 4, 55.2],
  [300, 22 / 16, 77, 4, 51.2],
  [411, 22 / 16, 77, 4, 73.4],
  [320, 22 / 16, 77, 2, 77],
] as const)(
  "fills a %sdp row at scale %s beside a %sdp compose button",
  (width, scale, fabSize, count, height) => {
    const metrics = floatingTabsMetrics(count, scale, fabSize, width, true);
    expect(metrics.pill + 2 * 16 + 12 + metrics.height).toBeCloseTo(width);
    expect(metrics.height).toBeCloseTo(height);
    expect(metrics.pill / count).toBeGreaterThanOrEqual(metrics.height - 0.001);
  },
);

it.each([320, 360, 390, 728])(
  "fits the centered dock and action inside a %sdp phone/pane",
  (width) => {
    for (const fabSize of [48, 56, 77]) {
      const available = width - 32;
      const home = floatingDockMetrics(4, fabSize, available, true);
      const settings = floatingDockMetrics(4, fabSize, available, false);
      expect(home.row).toBeLessThanOrEqual(available);
      expect(settings.row).toBe(settings.pill);
      expect(home.row).toBe(home.pill + 12 + home.height);
      expect((home.pill - 8) / 4).toBeGreaterThanOrEqual(48);
      expect(home.height).toBeGreaterThanOrEqual(48);
      expect(home.height).toBeLessThanOrEqual(64);
    }
  },
);
it("does not reserve any action width for settings, usage or pull requests", () => {
  expect(floatingDockMetrics(4, 56, 358, false)).toEqual({ pill: 232, height: 56, row: 232 });
  expect(floatingDockMetrics(4, 56, 358, true)).toEqual({ pill: 232, height: 56, row: 300 });
});
