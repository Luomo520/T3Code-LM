import { describe, expect, it } from "vite-plus/test";
import {
  formatUsageMoney,
  formatUsageRate,
  formatUsageSpeed,
  formatUsageTokens,
  isLowCacheRate,
  isUsageDataExpired,
} from "./headerUsageFormat";

describe("desktop header usage formatting", () => {
  it("always shows one decimal for cache percentages, including threshold rounding", () => {
    expect(formatUsageRate(0.994)).toBe("99.4%");
    expect(formatUsageRate(0.9)).toBe("90.0%");
    expect(formatUsageRate(0.89999)).toBe("<90.0%");
    expect(isLowCacheRate(0.89999)).toBe(true);
    expect(isLowCacheRate(0.9)).toBe(false);
    expect(formatUsageRate(0)).toBe("0.0%");
    expect(formatUsageRate(1)).toBe("100.0%");
  });
  it.each([null, undefined, NaN, Infinity, -1, 1.01])(
    "keeps unknown or invalid cache missing: %s",
    (value) => {
      expect(formatUsageRate(value)).toBe("—");
      expect(isLowCacheRate(value)).toBe(false);
    },
  );
  it("preserves money, token and speed semantics without clipping positive speeds", () => {
    expect(formatUsageMoney(-12.5, "USD")).toBe("−$12.50");
    expect(formatUsageMoney(0, "CNY")).toBe("¥0.00");
    expect(formatUsageTokens(123456)).toBe("0.1M");
    expect(formatUsageTokens(null)).toBe("—");
    expect(formatUsageSpeed(0.1)).toBe("0.1");
    expect(formatUsageSpeed(999.99)).toBe("1000.0");
    expect(formatUsageSpeed(10000)).toBe("10000.0");
    expect(formatUsageSpeed(0)).toBe("—");
  });
  it("marks expired successful values and leaves unavailable fields without stars", () => {
    expect(isUsageDataExpired(null, 30000, true, 60000)).toBe(false);
    expect(isUsageDataExpired("1970-01-01T00:00:00.000Z", 30000, false, 29999)).toBe(false);
    expect(isUsageDataExpired("1970-01-01T00:00:00.000Z", 30000, false, 30000)).toBe(true);
    expect(isUsageDataExpired("invalid", 30000, false, 0)).toBe(true);
  });
});
