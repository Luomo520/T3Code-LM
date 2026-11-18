import type { HeaderUsageCounters } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatUsageMoney,
  formatUsageRate,
  formatUsageTokens,
  formatUsageSpeed,
  formatUsageRequestSpeed,
  selectUsageSpeed,
  isLowCacheRate,
} from "./headerUsageFormat";

describe("header number formatting", () => {
  it("formats measured speed without turning missing or invalid timing into zero", () => {
    expect(formatUsageSpeed(48.76)).toBe("48.8");
    expect(formatUsageSpeed(1200)).toBe("1200.0");
    for (const value of [null, undefined, 0, -1, NaN, Infinity])
      expect(formatUsageSpeed(value)).toBe("—");
  });
  it("keeps natural widths across the requested M/B range and rounding boundary", () => {
    for (const [value, text] of [
      [0, "0"],
      [100000, "0.1M"],
      [1000000, "1.0M"],
      [999900000, "999.9M"],
      [999950000, "1.0B"],
      [99900000000, "99.9B"],
    ] as const) {
      expect(formatUsageTokens(value)).toBe(text);
    }
    expect(formatUsageTokens(null)).toBe("—");
    expect(formatUsageTokens(-1)).toBe("—");
  });
  it("keeps missing data distinct from zero and uses the reported currency", () => {
    expect(formatUsageMoney(0, "USD")).toBe("$0.00");
    expect(formatUsageMoney(null, "USD")).toBe("—");
    expect(formatUsageMoney(12.5, "CNY")).toBe("¥12.50");
    expect(formatUsageRate(0)).toBe("0.0%");
    expect(formatUsageRate(1)).toBe("100.0%");
    expect(formatUsageRate(undefined)).toBe("—");
  });
  it("marks only known cache rates below 90 percent and preserves the visible threshold", () => {
    for (const rate of [0, 0.5, 0.89999]) expect(isLowCacheRate(rate)).toBe(true);
    for (const rate of [0.9, 1, null, undefined, NaN, -1]) expect(isLowCacheRate(rate)).toBe(false);
    expect(formatUsageRate(0.89999)).toBe("<90.0%");
    expect(formatUsageRate(0.9)).toBe("90.0%");
    expect(formatUsageRate(0.899)).toBe("89.9%");
    expect(formatUsageRate(0.994)).toBe("99.4%");
    expect(formatUsageRate(0.991)).toBe("99.1%");
    for (const rate of [NaN, Infinity, -0.1, 1.1]) expect(formatUsageRate(rate)).toBe("—");
  });
  it("uses only a newer request window when strict throughput is stale or missing", () => {
    const local: HeaderUsageCounters = {
      tokens: 100,
      cacheRate: 0.9,
      recentRate: 0.9,
      recentSamples: 1,
      partial: false,
      recentSpeed: 60,
      lastSpeed: 80,
      speedStale: true,
      speedSampleAt: "2026-11-15T00:00:00Z",
      requestSpeed: { recent: 20, last: 25, sampleAt: "2026-11-15T00:00:10Z", stale: false },
    };
    expect(selectUsageSpeed(local)).toMatchObject({
      estimated: true,
      recent: 20,
      last: 25,
      stale: false,
    });
    expect(selectUsageSpeed({ ...local, speedStale: false })).toMatchObject({
      estimated: false,
      recent: 60,
      last: 80,
    });
    expect(
      selectUsageSpeed({
        ...local,
        requestSpeed: { ...local.requestSpeed!, sampleAt: local.speedSampleAt! },
      }).estimated,
    ).toBe(false);
    expect(selectUsageSpeed({ ...local, lastSpeed: null, recentSpeed: null }).estimated).toBe(true);
    expect(
      selectUsageSpeed({ ...local, requestSpeed: { ...local.requestSpeed!, sampleAt: "invalid" } })
        .estimated,
    ).toBe(false);
    expect(formatUsageRequestSpeed(null, 25.25)).toBe("≈25.3");
    expect(formatUsageRequestSpeed(60, 25.25)).toBe("60.0");
    expect(formatUsageRequestSpeed(null, NaN)).toBe("—");
  });
});
