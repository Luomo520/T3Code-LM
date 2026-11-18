import type { HeaderUsageCounters, HeaderUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { usageDetails } from "./headerUsageDetails";

function summary(overrides: Partial<HeaderUsageSummary> = {}): HeaderUsageSummary {
  const counters = {
    tokens: 123456,
    cacheRate: 0.8,
    recentRate: 0.75,
    lastRate: 0.5,
    recentSpeed: 150,
    lastSpeed: 100,
    speedSamples: 2,
    recentSamples: 2,
    partial: false,
  };
  return {
    providerInstanceId: null,
    providerLabel: "Codex",
    readAt: "2026-10-31T10:00:00.000Z",
    localReadAt: "2026-10-31T10:00:00.000Z",
    localRefreshing: false,
    account: {
      balance: null,
      balanceKind: "unknown",
      currency: null,
      totalTokens: 999,
      todayCost: null,
      readAt: null,
      stale: false,
      message: "",
      refreshSeconds: 60,
    },
    conversation: { ...counters },
    allConversations: { ...counters },
    ...overrides,
  };
}

describe("mobile header usage details", () => {
  it("shows Token, cache and speed from the same authoritative request rows", () => {
    const conversation: HeaderUsageCounters = {
      ...summary().conversation,
      recentCacheSamples: [
        {
          timestamp: "2026-10-31T09:00:00Z",
          inputTokens: 9876,
          cachedInputTokens: 0,
          cacheRate: 0,
        },
      ],
      recentSpeedSamples: [
        { timestamp: "2026-10-31T08:00:00Z", outputTokens: 999, seconds: 1, tokensPerSecond: 999 },
      ],
      recentRequestSamples: [
        {
          timestamp: "2026-10-31T10:00:00.000Z",
          totalTokens: 2345,
          cacheRate: 0.4998,
          tokensPerSecond: 2063.135,
        },
        {
          timestamp: "2026-10-31T09:30:00.000Z",
          totalTokens: 0,
          cacheRate: 0,
          tokensPerSecond: null,
        },
      ],
    };
    expect(usageDetails(summary({ conversation }), false, null).rows).toEqual([
      { timestamp: "2026-10-31T10:00:00.000Z", tokens: "2,345", cache: "50.0%", speed: "2063.1" },
      { timestamp: "2026-10-31T09:30:00.000Z", tokens: "0", cache: "0.0%", speed: "—" },
    ]);
  });

  it("distinguishes unknown cache and speed from measured zero without using averages", () => {
    const conversation: HeaderUsageCounters = {
      ...summary().conversation,
      recentRequestSamples: [
        {
          timestamp: "2026-10-31T10:00:00.000Z",
          totalTokens: 100,
          cacheRate: null,
          tokensPerSecond: null,
        },
      ],
    };
    expect(usageDetails(summary({ conversation }), false, null).rows[0]).toMatchObject({
      tokens: "100",
      cache: "—",
      speed: "—",
    });
  });

  it("asks to update an older backend without pairing legacy windows or treating input as total Token", () => {
    const data = summary({
      conversation: {
        ...summary().conversation,
        recentCacheSamples: [
          {
            timestamp: "2026-10-31T10:00:00Z",
            inputTokens: 123,
            cachedInputTokens: 100,
            cacheRate: 0.8,
          },
        ],
        recentSpeedSamples: [
          {
            timestamp: "2026-10-31T10:00:00Z",
            outputTokens: 456,
            seconds: 1,
            tokensPerSecond: 456,
          },
        ],
      },
    });
    const details = usageDetails(data, false, null);
    expect(details.rows).toEqual([]);
    expect(details.emptyText).toBe("更新后台以查看逐次统计。");
  });

  it("preserves a supported empty request window without synthesizing rows", () => {
    const details = usageDetails(
      summary({ conversation: { ...summary().conversation, recentRequestSamples: [] } }),
      false,
      null,
    );
    expect(details.rows).toEqual([]);
    expect(details.emptyText).toBe("暂无请求记录。");
  });

  it("selects the home window and retains a short failure notice", () => {
    const allConversations: HeaderUsageCounters = {
      ...summary().allConversations,
      recentRequestSamples: [
        {
          timestamp: "2026-10-31T10:00:00.000Z",
          totalTokens: 1204,
          cacheRate: 0.75,
          tokensPerSecond: 201.7,
        },
      ],
    };
    const details = usageDetails(summary({ allConversations }), true, "offline");
    expect(details.rows).toEqual([
      { timestamp: "2026-10-31T10:00:00.000Z", tokens: "1,204", cache: "75.0%", speed: "201.7" },
    ]);
    expect(details.notice).toBe("暂未更新，保留上次记录。");
  });

  it("handles unavailable data without inventing samples", () => {
    const details = usageDetails(null, false, null);
    expect(details.provider).toBe("统计尚不可用");
    expect(details.rows).toEqual([]);
  });

  it("marks restored request rows and preserves null measurements and original timestamps", () => {
    const at = "2026-10-31T09:00:00.000Z";
    const data = summary({
      conversation: {
        ...summary().conversation,
        recentRequestSamples: [
          { timestamp: at, totalTokens: 150, cacheRate: 0, tokensPerSecond: 150 },
          { timestamp: at, totalTokens: 100, cacheRate: null, tokensPerSecond: null },
        ],
      },
    });
    expect(usageDetails(data, false, null, { recentRequestSamples: at }).rows).toEqual([
      { timestamp: at, tokens: "150*", cache: "0.0%*", speed: "150.0*" },
      { timestamp: at, tokens: "100*", cache: "—", speed: "—" },
    ]);
  });
  it("labels request estimates and keeps the label after historical restoration", () => {
    const at = "2026-10-31T10:00:00.000Z";
    const data = summary({
      conversation: {
        ...summary().conversation,
        recentRequestSamples: [
          {
            timestamp: at,
            totalTokens: 500,
            cacheRate: 0.9,
            tokensPerSecond: null,
            estimatedTokensPerSecond: 24.26,
          },
          {
            timestamp: at,
            totalTokens: 500,
            cacheRate: 0.9,
            tokensPerSecond: 60,
            estimatedTokensPerSecond: 24.26,
          },
        ],
      },
    });
    expect(usageDetails(data, false, null).rows.map((row) => row.speed)).toEqual(["≈24.3", "60.0"]);
    expect(
      usageDetails(data, false, null, { recentRequestSamples: at }).rows.map((row) => row.speed),
    ).toEqual(["≈24.3*", "60.0*"]);
  });
});
