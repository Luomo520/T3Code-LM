import { expect, it } from "vite-plus/test";

import { aggregateConversationUsage, type ConversationUsageRow } from "./conversationUsage.ts";
import type { HeaderRequest, HeaderTurnRef } from "./headerUsageScan.ts";
import { createOverrideRateTable } from "./usagePricing.ts";

const rates = createOverrideRateTable({
  relay: {
    inputCostPerMillionTokens: 2,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.5,
    cacheWriteCostPerMillionTokens: 3,
  },
});

function row(runId: string, instance: string, session: string, turn: string): ConversationUsageRow {
  return {
    run_id: runId,
    instance_id: instance,
    native_session: session,
    native_turn: turn,
    turn_usage: null,
    model: "relay",
  };
}

function ref(row: ConversationUsageRow, threadId = "thread"): HeaderTurnRef {
  return {
    threadId,
    providerInstanceId: row.instance_id,
    sessionId: row.native_session!,
    turnId: row.native_turn!,
  };
}

function request(ref: HeaderTurnRef, override: Partial<HeaderRequest> = {}): HeaderRequest {
  return {
    provider: "codex",
    timestampMs: 1,
    model: "relay",
    sessionId: ref.sessionId,
    headerTurnId: ref.turnId,
    totals: {
      uncachedInputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      reasoningTokens: 8,
    },
    speed: "standard",
    reportedCostUsd: null,
    dedupeKey: null,
    headerCacheKnown: true,
    ...override,
  };
}

it("keeps each run's cumulative count and speed through a provider switch without including other threads", () => {
  const first = row("one", "provider-a", "session-a", "turn-a");
  const second = row("two", "provider-b", "session-b", "turn-b");
  const other = row("unrelated", "provider-b", "session-b", "other-turn");
  const usage = aggregateConversationUsage({
    threadId: "thread",
    rows: [first, first, second],
    refs: [ref(first), ref(second), ref(other, "other")],
    recordsByInstance: new Map([
      ["provider-a", [request(ref(first), { reportedCostUsd: 0.005 })]],
      ["provider-b", [request(ref(second)), request(ref(other))]],
    ]),
    rates,
    textTiming: (sample) =>
      sample.headerTurnId === "turn-a" ? { tokens: 10, seconds: 1 } : { tokens: 20, seconds: 1 },
    requestTiming: () => null,
  });
  expect(
    usage.turns.map((turn) => [turn.runId, turn.cumulativeTokens, turn.tokensPerSecond]),
  ).toEqual([
    ["one", 170, 10],
    ["two", 340, 20],
  ]);
  expect(usage.turns[0]?.costUsd).toBe(0.005);
  expect(usage.turns[1]?.costUsd).toBeCloseTo(0.00033, 10);
  expect(usage.turns[1]?.cacheRate).toBeCloseTo(40 / 150);
  expect(usage.costUsd).toBeCloseTo(0.00533, 10);
  expect(usage.costPartial).toBe(false);
  expect(usage.categoryCostUsd?.cacheWrite).toBeGreaterThan(0);
});

it("retains known provider fees and exposes missing prices and per-run timing independently", () => {
  const first = {
    ...row("one", "claude-agent", "one", "turn-one"),
    started_at: "1970-01-01T00:00:00.000Z",
    completed_at: "1970-01-01T00:00:01.000Z",
    turn_usage: JSON.stringify({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      models: ["claude-native"],
      inputTokens: 140,
      cachedInputTokens: 100,
      outputTokens: 20,
      otherUsage: { inputTokens: 90, outputTokens: 10 },
    }),
  };
  const second = row("two", "codex", "two", "turn-two");
  const usage = aggregateConversationUsage({
    threadId: "thread",
    rows: [first, second],
    refs: [ref(second)],
    claudeSessions: new Map([["claude-agent", new Set(["one"])]]),
    recordsByInstance: new Map([
      [
        "claude-agent",
        [
          request(ref(first), {
            provider: "claude",
            model: "claude-native",
            reportedCostUsd: 0.023,
            totals: {
              uncachedInputTokens: 100,
              cachedInputTokens: 100,
              cacheCreationTokens: 30,
              outputTokens: 30,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
      ["codex", [request(ref(second), { model: "unpriced-model", headerCacheKnown: false })]],
    ]),
    rates,
    textTiming: () => null,
    requestTiming: () => ({ tokens: 20, seconds: 2 }),
  });
  expect(usage.costUsd).toBe(0.023);
  expect(usage.categoryCostUsd).toBeNull();
  expect(usage.costPartial).toBe(true);
  expect(usage.turns).toMatchObject([
    { cumulativeTokens: 260, costUsd: 0.023, costPartial: false, estimatedTokensPerSecond: null },
    {
      cumulativeTokens: 430,
      costUsd: null,
      costPartial: true,
      estimatedTokensPerSecond: 10,
      cacheRate: null,
    },
  ]);
});
