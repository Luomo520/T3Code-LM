// @effect-diagnostics nodeBuiltinImport:off - transcript fixture files are isolated temporary files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { HeaderUsageCounters } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import {
  aggregateHeaderRequests,
  HeaderTranscriptCache,
  headerCodexFormat,
  type HeaderRequest,
  type HeaderTurnRef,
} from "./headerUsageScan.ts";

const refs: HeaderTurnRef[] = [
  { threadId: "thread", providerInstanceId: "supplier", sessionId: "native", turnId: "turn" },
];
function request(index: number, input: number, cached: number): HeaderRequest {
  return {
    provider: "codex",
    model: "test",
    sessionId: "native",
    timestampMs: index,
    speed: "standard",
    dedupeKey: null,
    reportedCostUsd: null,
    headerTurnId: "turn",
    headerCacheKnown: true,
    totals: {
      uncachedInputTokens: input - cached,
      cachedInputTokens: cached,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 5,
    },
  };
}

describe("header request counters", () => {
  it("preserves sample details through the wire schema and accepts legacy counters", () => {
    const result = aggregateHeaderRequests(
      [request(1, 100, 50)],
      refs,
      undefined,
      false,
      undefined,
      () => ({ tokens: 40, seconds: 2 }),
    );
    const decode = Schema.decodeSync(HeaderUsageCounters);
    expect(decode(result)).toEqual(result);
    expect(
      decode({ tokens: 100, cacheRate: 0.5, recentRate: 0.5, recentSamples: 1, partial: false }),
    ).not.toHaveProperty("recentCacheSamples");
    expect(decode(result).recentSpeedSamples?.[0]?.tokensPerSecond).toBe(20);
  });

  it("exposes the exact independent cache and speed windows, newest first", () => {
    const records = Array.from({ length: 8 }, (_, i) => request(i + 1, (i + 1) * 100, i * 50));
    const result = aggregateHeaderRequests(
      records.toReversed(),
      refs,
      "thread",
      false,
      "supplier",
      (r) => (r.timestampMs % 2 === 0 ? { tokens: r.timestampMs * 10, seconds: 2 } : null),
    );
    expect(result.recentCacheSamples?.map((sample) => sample.timestamp)).toEqual(
      [8, 7, 6, 5, 4].map((i) => DateTime.formatIso(DateTime.makeUnsafe(i))),
    );
    expect(result.recentCacheSamples?.[0]).toEqual({
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(8)),
      inputTokens: 800,
      cachedInputTokens: 350,
      cacheRate: 350 / 800,
    });
    expect(result.recentSpeedSamples).toEqual(
      [8, 6, 4, 2].map((i) => ({
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(i)),
        outputTokens: i * 10,
        seconds: 2,
        tokensPerSecond: i * 5,
      })),
    );
    expect(result.recentRequestSamples).toEqual(
      [8, 7, 6, 5, 4].map((i) => ({
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(i)),
        totalTokens: i * 100 + 10,
        cacheRate: ((i - 1) * 50) / (i * 100),
        tokensPerSecond: i % 2 === 0 ? i * 5 : null,
      })),
    );
    const cache = result.recentCacheSamples!;
    const speed = result.recentSpeedSamples!;
    expect(
      cache.reduce((sum, sample) => sum + sample.cachedInputTokens!, 0) /
        cache.reduce((sum, sample) => sum + sample.inputTokens, 0),
    ).toBe(result.recentRate);
    expect(
      speed.reduce((sum, sample) => sum + sample.outputTokens, 0) /
        speed.reduce((sum, sample) => sum + sample.seconds, 0),
    ).toBe(result.recentSpeed);
    expect(records[0]?.timestampMs).toBe(1);
  });

  it("keeps unknown cache hits unknown and returns empty arrays without inventing samples", () => {
    const result = aggregateHeaderRequests(
      [{ ...request(1, 100, 0), headerCacheKnown: false }, request(2, 0, 0)],
      refs,
      undefined,
      false,
      undefined,
      () => null,
    );
    expect(result.recentCacheSamples).toEqual([
      {
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(2)),
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheRate: null,
      },
      {
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(1)),
        inputTokens: 100,
        cachedInputTokens: null,
        cacheRate: null,
      },
    ]);
    expect(result.recentSpeedSamples).toEqual([]);
    expect(result.recentRequestSamples).toEqual([
      {
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(2)),
        totalTokens: 10,
        cacheRate: null,
        tokensPerSecond: null,
      },
      {
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(1)),
        totalTokens: 110,
        cacheRate: null,
        tokensPerSecond: null,
      },
    ]);
    expect(aggregateHeaderRequests([], refs)).toMatchObject({
      recentCacheSamples: [],
      recentSpeedSamples: [],
      recentRequestSamples: [],
    });
  });

  it("keeps the latest valid speed independently of the latest cache request", () => {
    const records = [request(1, 100, 20), request(2, 100, 96), request(3, 100, 90)];
    const result = aggregateHeaderRequests(records, refs, "thread", false, "supplier", (r) =>
      r.timestampMs === 1
        ? { tokens: 30, seconds: 1 }
        : r.timestampMs === 2
          ? { tokens: 10, seconds: 3 }
          : null,
    );
    expect(result).toMatchObject({
      lastRate: 0.9,
      recentSpeed: 10,
      lastSpeed: 10 / 3,
      speedSamples: 2,
      speedSampleAt: "1970-01-01T00:00:00.002Z",
      speedStale: true,
    });
    const single = aggregateHeaderRequests(
      records.slice(0, 1),
      refs,
      "thread",
      false,
      "supplier",
      () => ({ tokens: 30, seconds: 1 }),
    );
    expect(single).toMatchObject({
      lastRate: 0.2,
      recentRate: 0.2,
      recentSpeed: 30,
      lastSpeed: 30,
      speedSamples: 1,
      speedSampleAt: "1970-01-01T00:00:00.001Z",
      speedStale: false,
    });
    expect(aggregateHeaderRequests([], refs)).toMatchObject({
      lastRate: null,
      recentSpeed: null,
      lastSpeed: null,
      speedSamples: 0,
      speedSampleAt: null,
      speedStale: false,
    });
  });
  it("retains five valid measurements through tool requests without changing the cache window", () => {
    const records = Array.from({ length: 13 }, (_, index) => request(index + 1, 100, index));
    const result = aggregateHeaderRequests(
      records.toReversed(),
      refs,
      "thread",
      false,
      "supplier",
      (r) =>
        r.timestampMs <= 6
          ? { tokens: r.timestampMs === 1 ? 10000 : r.timestampMs * 10, seconds: r.timestampMs }
          : null,
    );
    expect(result).toMatchObject({
      recentSpeed: 10,
      lastSpeed: 10,
      speedSamples: 5,
      speedSampleAt: "1970-01-01T00:00:00.006Z",
      speedStale: true,
      recentSamples: 5,
      recentRate: 0.1,
      lastRate: 0.12,
    });
    expect(result.recentCacheSamples?.map((sample) => sample.timestamp)).toEqual(
      [13, 12, 11, 10, 9].map((i) => DateTime.formatIso(DateTime.makeUnsafe(i))),
    );
    expect(result.recentSpeedSamples?.map((sample) => sample.timestamp)).toEqual(
      [6, 5, 4, 3, 2].map((i) => DateTime.formatIso(DateTime.makeUnsafe(i))),
    );
    expect(result.recentRequestSamples).toEqual(
      [13, 12, 11, 10, 9].map((i) => ({
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(i)),
        totalTokens: 110,
        cacheRate: (i - 1) / 100,
        tokensPerSecond: null,
      })),
    );
    expect(records[0]?.timestampMs).toBe(1);
  });
  it("weights valid samples by time and never mixes another supplier or thread", () => {
    const owners = [
      ...refs,
      {
        ...refs[0]!,
        threadId: "other-thread",
        providerInstanceId: "other",
        sessionId: "other-session",
      },
    ];
    const records = [
      request(1, 100, 90),
      request(2, 100, 90),
      {
        ...request(3, 100, 90),
        sessionId: "other-session",
      },
    ];
    expect(
      aggregateHeaderRequests(records, owners, "thread", false, "supplier", (r) =>
        r.timestampMs === 1 ? { tokens: 100, seconds: 1 } : { tokens: 100, seconds: 9 },
      ),
    ).toMatchObject({
      recentSpeed: 20,
      lastSpeed: 100 / 9,
      speedSamples: 2,
      speedSampleAt: "1970-01-01T00:00:00.002Z",
      speedStale: false,
    });
  });
  it("weights cache by input tokens, counts requests within one turn and excludes reasoning double counting", () => {
    const result = aggregateHeaderRequests(
      [request(1, 100, 0), request(2, 900, 900)],
      refs,
      "thread",
    );
    expect(result).toMatchObject({
      tokens: 1020,
      cacheRate: 0.9,
      recentRate: 0.9,
      recentSamples: 2,
      partial: false,
    });
  });
  it("uses the latest five requests rather than five turns", () => {
    const records = [
      request(1, 1000, 1000),
      ...Array.from({ length: 5 }, (_, i) => request(i + 2, 10, 0)),
    ];
    expect(aggregateHeaderRequests(records, refs)).toMatchObject({
      recentRate: 0,
      recentSamples: 5,
    });
  });
  it("does not invent missing cache hits, but keeps verifiable samples when history is partial", () => {
    expect(
      aggregateHeaderRequests([{ ...request(1, 100, 0), headerCacheKnown: false }], refs),
    ).toMatchObject({ cacheRate: null, recentRate: null, partial: true });
    expect(aggregateHeaderRequests([request(1, 100, 50)], refs, undefined, true)).toMatchObject({
      recentRate: 0.5,
      recentSamples: 1,
      partial: true,
    });
  });
  it("does not let unrelated unmapped history hide the current thread's recent samples", () => {
    const unknown = { ...request(1, 100, 0), sessionId: "unrelated-history" };
    expect(
      aggregateHeaderRequests([unknown, request(2, 100, 95)], refs, "thread", false, "supplier"),
    ).toMatchObject({ recentRate: 0.95, recentSamples: 1, partial: true });
  });
  it("shows a recent rate once an old unknown cache sample leaves the five-request window", () => {
    const records = [
      { ...request(1, 100, 0), headerCacheKnown: false },
      ...Array.from({ length: 5 }, (_, i) => request(i + 2, 100, 96)),
    ];
    expect(aggregateHeaderRequests(records, refs, "thread", true)).toMatchObject({
      cacheRate: null,
      recentRate: 0.96,
      recentSamples: 5,
      partial: true,
    });
    records.push({ ...request(7, 100, 0), headerCacheKnown: false });
    expect(aggregateHeaderRequests(records, refs, "thread", true).recentRate).toBeNull();
  });
  it("rejects ambiguous cross-thread and cross-supplier ownership", () => {
    const shared = [...refs, { ...refs[0]!, providerInstanceId: "other" }];
    expect(
      aggregateHeaderRequests([request(1, 100, 50)], shared, "thread", false, "supplier"),
    ).toMatchObject({ tokens: null, partial: true });
    expect(aggregateHeaderRequests([request(1, 100, 50)], refs, "other").tokens).toBeNull();
  });
});

function event(index: number, total: number) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: `2026-10-28T12:00:0${index}Z`,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
        total_token_usage: {
          input_tokens: total * 100,
          cached_input_tokens: total * 80,
          output_tokens: total * 10,
        },
      },
    },
  });
}

it("reads committed events once across append, duplicate snapshots, archives and large projected records", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-header-test-"));
  try {
    const archive = NodePath.join(root, "archive");
    await NodeFSP.mkdir(archive);
    const file = NodePath.join(root, "rollout-native.jsonl");
    const meta = JSON.stringify({ type: "session_meta", payload: { id: "native" } });
    const context = JSON.stringify({
      type: "turn_context",
      payload: { turn_id: "turn", model: "test", extra: "x".repeat(9 * 1024 * 1024) },
    });
    const prefix = meta + "\n" + context + "\n" + event(1, 1) + "\n";
    await NodeFSP.writeFile(file, prefix + event(2, 2));
    const scanner = new HeaderTranscriptCache();
    const first = await scanner.scan([root], new Set(["native"]));
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ headerTurnId: "turn", headerCacheKnown: true });
    await NodeFSP.appendFile(file, "\n" + event(2, 2) + "\n");
    expect((await scanner.scan([root], new Set(["native"]))).records).toHaveLength(2);
    await NodeFSP.writeFile(NodePath.join(archive, "rollout-native-copy.jsonl"), prefix);
    expect((await scanner.scan([root], new Set(["native"]))).records).toHaveLength(2);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("preserves ledger cache knowledge, pending turn ownership and response identity across appends", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-header-ledger-"));
  try {
    const file = NodePath.join(root, "rollout-native.jsonl");
    const line = (type: string, timestamp: string, payload: unknown) =>
      JSON.stringify({ type, timestamp, payload }) + "\n";
    const context = (turn: string) =>
      line("turn_context", "2026-11-14T00:00:00Z", { turn_id: turn, model: "test" });
    await NodeFSP.writeFile(
      file,
      line("session_meta", "2026-11-14T00:00:00Z", { id: "native", model_provider: "custom" }) +
        context("turn-one") +
        line("token_usage_record", "2026-11-14T00:01:00Z", {
          usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 20 },
        }),
    );
    const scanner = new HeaderTranscriptCache();
    expect((await scanner.scan([root], new Set(["native"]))).records).toHaveLength(0);
    const response = (timestamp: string) =>
      line("token_usage_record", timestamp, {
        response_id: "response-two",
        usage: { input_tokens: 50, output_tokens: 10 },
      });
    await NodeFSP.appendFile(file, context("turn-two") + response("2026-11-14T00:02:00Z"));
    const result = await scanner.scan([root], new Set(["native"]));
    expect(result.records).toMatchObject([
      { headerTurnId: "turn-one", headerCacheKnown: true },
      { headerTurnId: "turn-two", headerCacheKnown: false },
    ]);
    const owners: HeaderTurnRef[] = [
      { threadId: "one", providerInstanceId: "supplier", sessionId: "native", turnId: "turn-one" },
      { threadId: "two", providerInstanceId: "supplier", sessionId: "native", turnId: "turn-two" },
    ];
    expect(aggregateHeaderRequests(result.records, owners, "one")).toMatchObject({
      tokens: 120,
      cacheRate: 0.8,
      partial: false,
    });
    expect(aggregateHeaderRequests(result.records, owners, "two")).toMatchObject({
      tokens: 60,
      cacheRate: null,
      partial: true,
    });
    await NodeFSP.appendFile(file, response("2026-11-14T00:03:00Z"));
    expect((await scanner.scan([root], new Set(["native"]))).records).toHaveLength(2);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("keeps each pending request's metadata when a snapshot reconciles several interrupted turns", () => {
  const state = headerCodexFormat.state!.initial();
  const usage = (input: number, output: number, cached?: number) => ({
    input_tokens: input,
    output_tokens: output,
    ...(cached === undefined ? {} : { cached_input_tokens: cached }),
  });
  const snapshot = (last: unknown, total: unknown) => ({
    type: "token_count",
    info: { last_token_usage: last, total_token_usage: total },
  });
  const entries = [
    ["session_meta", { id: "native" }],
    ["turn_context", { turn_id: "one", model: "test" }],
    ["event_msg", snapshot(usage(100, 10, 80), usage(100, 10, 80))],
    ["token_usage_record", { usage: usage(150, 15, 100) }],
    ["token_usage_record", { usage: usage(50, 5) }],
    ["turn_context", { turn_id: "two", model: "test" }],
    ["token_usage_record", { usage: usage(50, 5, 30) }],
    ["event_msg", snapshot(usage(30, 3, 20), usage(350, 35, 210))],
  ];
  const records = entries.flatMap(([type, payload], index) =>
    headerCodexFormat.parseProjected(
      { type, payload, timestamp: `2026-11-14T00:00:0${index}Z` },
      state,
    ),
  );
  expect(records.slice(1)).toMatchObject([
    { headerTurnId: "one", headerCacheKnown: true, totals: { outputTokens: 15 } },
    { headerTurnId: "one", headerCacheKnown: false, totals: { outputTokens: 5 } },
    { headerTurnId: "two", headerCacheKnown: true, totals: { outputTokens: 2 } },
    { headerTurnId: "two", headerCacheKnown: true, totals: { outputTokens: 3 } },
  ]);
});
