import type { HeaderUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { headerUsageMetrics } from "./headerUsageMetrics";

export function headerUsageFixture(): HeaderUsageSummary {
  const counters = {
    tokens: 12345,
    todayTokens: 2000,
    cacheRate: 0.994,
    recentRate: 0.89,
    lastRate: 0.925,
    recentSpeed: 12.5,
    lastSpeed: null,
    speedSamples: 3,
    recentSamples: 5,
    partial: false,
  };
  return {
    providerInstanceId: "codex",
    providerLabel: "Test Codex",
    readAt: "1970-01-01T00:00:00.000Z",
    localReadAt: "1970-01-01T00:00:00.000Z",
    localRefreshing: false,
    account: {
      balance: 12.5,
      balanceKind: "balance",
      currency: "USD",
      totalTokens: 1234567,
      todayCost: 0.5,
      readAt: "1970-01-01T00:00:00.000Z",
      stale: false,
      message: "测试数据",
      refreshSeconds: 60,
    },
    conversation: counters,
    allConversations: { ...counters, todayTokens: 50000, cacheRate: 0.905 },
  };
}

describe("desktop header metrics", () => {
  it("renders the eight requested thread metrics in the required order with per-field warnings", () => {
    const metrics = headerUsageMetrics(headerUsageFixture(), false, 0);
    expect(metrics.map((item) => item.label)).toEqual([
      "余额",
      "用量",
      "Day",
      "总缓存",
      "缓存5",
      "缓存",
      "t/s5",
      "t/s",
    ]);
    expect(metrics.map((item) => item.value)).toEqual([
      "$12.50",
      "12.3K",
      "2.0K",
      "99.4%",
      "89.0%",
      "92.5%",
      "12.5",
      "—",
    ]);
    expect(metrics.filter((item) => item.lowCache).map((item) => item.label)).toEqual(["缓存5"]);
    expect(metrics.every((item) => !item.expired)).toBe(true);
  });
  it("uses account totals and global cache on the home page", () => {
    const metrics = headerUsageMetrics(headerUsageFixture(), true, 0);
    expect(metrics.map((item) => item.label)).toEqual(["余额", "用量", "Day", "总缓存"]);
    expect(metrics.map((item) => item.value)).toEqual(["$12.50", "1.2M", "50.0K", "90.5%"]);
  });
  it("ages local and account fields independently and never stars missing speed", () => {
    const data = headerUsageFixture();
    expect(
      headerUsageMetrics(data, false, 30000)
        .filter((item) => item.expired)
        .map((item) => item.label),
    ).toEqual(["用量", "Day", "总缓存", "缓存5", "缓存", "t/s5"]);
    expect(headerUsageMetrics(data, false, 60000)[0]?.expired).toBe(true);
    expect(
      headerUsageMetrics(null, false, 60000).every((item) => item.value === "—" && !item.expired),
    ).toBe(true);
  });
  it("keeps the server's balance type", () => {
    const data = headerUsageFixture();
    expect(
      headerUsageMetrics(
        { ...data, account: { ...data.account, balanceKind: "quota" } },
        false,
        0,
      )[0]?.label,
    ).toBe("余额");
  });
  it("retains server-measured values and stars an older sample even after a fresh query", () => {
    const data = headerUsageFixture();
    const conversation = {
      ...data.conversation,
      lastSpeed: 83.9,
      recentSpeed: 83.9,
      speedSampleAt: "1970-01-01T00:00:00.000Z",
      speedStale: true,
    };
    const summary = { ...data, localReadAt: "1970-01-01T00:00:10.000Z", conversation };
    const metrics = headerUsageMetrics(summary, false, 10000);
    expect(metrics.filter((item) => item.expired).map((item) => item.label)).toEqual([
      "t/s5",
      "t/s",
    ]);
    expect(
      metrics.filter((item) => item.label.startsWith("t/s")).map((item) => item.value),
    ).toEqual(["83.9", "83.9"]);
    const expiredByAge = {
      ...summary,
      localReadAt: "1970-01-01T00:05:00.000Z",
      conversation: { ...conversation, speedStale: false },
    };
    expect(
      headerUsageMetrics(expiredByAge, false, 300000).find((item) => item.label === "t/s")?.expired,
    ).toBe(true);
  });
});
