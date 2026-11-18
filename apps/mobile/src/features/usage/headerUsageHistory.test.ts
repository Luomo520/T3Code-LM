import type {
  HeaderUsageSummary,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  createHeaderUsageHistoryStore,
  type HeaderUsageHistoryTarget,
} from "./headerUsageHistoryStore";
import {
  emptyHeaderUsageHistory,
  mergeHeaderUsageHistory,
  presentHeaderUsageHistory,
  resolveHeaderUsageHistoryProvider,
} from "./headerUsageHistory";

const at = "2026-10-31T10:00:00.000Z";
const later = "2026-10-31T10:01:00.000Z";

export function historySummary(overrides: Partial<HeaderUsageSummary> = {}): HeaderUsageSummary {
  const counters = {
    tokens: 123456,
    cacheRate: 0.8,
    recentRate: 0.75,
    lastRate: 0.5,
    recentSpeed: 150,
    lastSpeed: 100,
    speedSamples: 1,
    speedSampleAt: at,
    recentSamples: 1,
    partial: false,
    recentCacheSamples: [
      { timestamp: at, inputTokens: 100, cachedInputTokens: 75, cacheRate: 0.75 },
    ],
    recentSpeedSamples: [{ timestamp: at, outputTokens: 150, seconds: 1, tokensPerSecond: 150 }],
    recentRequestSamples: [
      { timestamp: at, totalTokens: 250, cacheRate: 0.75, tokensPerSecond: 150 },
    ],
  };
  return {
    providerInstanceId: "codex",
    providerLabel: "Codex",
    readAt: at,
    localReadAt: at,
    localRefreshing: false,
    account: {
      balance: 10,
      balanceKind: "balance",
      currency: "USD",
      totalTokens: 999,
      todayCost: 1,
      readAt: at,
      stale: false,
      message: "",
      refreshSeconds: 60,
    },
    conversation: { ...counters },
    allConversations: { ...counters, tokens: 500000 },
    ...overrides,
  };
}

describe("mobile durable header usage history", () => {
  it("persists row estimates and exposes the newest live request window without caching it", () => {
    const sample = historySummary();
    const requestSpeed = { recent: 20, last: 25, sampleAt: later, stale: false };
    const incoming = {
      ...sample,
      localReadAt: later,
      conversation: {
        ...sample.conversation,
        requestSpeed,
        recentRequestSamples: [
          {
            timestamp: later,
            totalTokens: 500,
            cacheRate: 0.9,
            tokensPerSecond: null,
            estimatedTokensPerSecond: 25,
          },
        ],
      },
    };
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), incoming, false);
    expect(history.local?.values.recentRequestSamples?.[0]?.estimatedTokensPerSecond).toBe(25);
    expect(history.local?.values.requestSpeed).toBeUndefined();
    const live = presentHeaderUsageHistory(history, incoming, "codex", "Codex", false);
    expect(live.data?.conversation.requestSpeed).toEqual(requestSpeed);
    const offline = presentHeaderUsageHistory(history, null, "codex", "Codex", false, "offline");
    expect(offline.data?.conversation.requestSpeed).toBeUndefined();
    expect(offline.data?.conversation.recentRequestSamples?.[0]?.estimatedTokensPerSecond).toBe(25);
    expect(offline.historicalFields.recentRequestSamples).toBe(later);
    const old = presentHeaderUsageHistory(
      history,
      { ...incoming, localReadAt: at },
      "codex",
      "Codex",
      false,
    );
    expect(old.data?.conversation.requestSpeed).toBeUndefined();
  });

  it("restores every historical metric with its original time until a successful group arrives", () => {
    const sample = historySummary();
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), sample, false);
    const restored = presentHeaderUsageHistory(history, null, "codex", "Codex", false);
    expect(restored.data?.conversation).toEqual(sample.conversation);
    expect(Object.keys(restored.historicalFields)).toHaveLength(12);
    expect(Object.values(restored.historicalFields)).toEqual(Array(12).fill(at));
    const synchronized = presentHeaderUsageHistory(history, sample, "codex", "Codex", false);
    expect(synchronized.historicalFields).toEqual({});
  });

  it("preserves the server day count, including a zero after midnight and older offline samples", () => {
    const sample = historySummary();
    const incoming = { ...sample, conversation: { ...sample.conversation, todayTokens: 800 } };
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), incoming, false);
    const offline = presentHeaderUsageHistory(history, null, "codex", "Codex", false);
    expect(offline.data?.conversation.todayTokens).toBe(800);
    expect(offline.historicalFields.todayTokens).toBe(at);
    const nextDay = "2026-11-01T00:00:00.000Z";
    const reset = {
      ...incoming,
      localReadAt: nextDay,
      conversation: { ...incoming.conversation, todayTokens: 0 },
    };
    const updated = mergeHeaderUsageHistory(history, reset, false);
    expect(updated.local?.values.todayTokens).toBe(0);
    const older = presentHeaderUsageHistory(updated, incoming, "codex", "Codex", false);
    expect(older.data?.conversation.todayTokens).toBe(0);
    expect(older.historicalFields.todayTokens).toBe(nextDay);
  });

  it("keeps legacy responses separate from a previously confirmed CC account", () => {
    const sample = historySummary();
    const confirmed = { ...sample, account: { ...sample.account, sourceId: "cc:A" } };
    let history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), confirmed, false);
    expect(
      presentHeaderUsageHistory(history, null, "codex", "Codex", false).data?.account.balance,
    ).toBe(10);
    const legacy = {
      ...sample,
      readAt: later,
      account: { ...sample.account, balance: 0, totalTokens: null, todayCost: null, readAt: later },
    };
    history = mergeHeaderUsageHistory(history, legacy, false);
    const view = presentHeaderUsageHistory(history, legacy, "codex", "Codex", false);
    expect(history.account.currentSourceId).toBeNull();
    expect(history.account.entries.find((entry) => entry.sourceId === "cc:A")?.values.balance).toBe(
      10,
    );
    expect(view.data?.account.sourceId).toBeUndefined();
    expect(view.data?.account.balance).toBe(0);
    expect(view.data?.account.totalTokens).toBeNull();
    expect(view.data?.account.todayCost).toBeNull();
    expect(
      presentHeaderUsageHistory(history, null, "codex", "Codex", false).data?.account.totalTokens,
    ).toBeNull();
  });

  it("does not let a delayed response reactivate an older account source", () => {
    const sample = historySummary();
    const first = { ...sample, account: { ...sample.account, sourceId: "cc:A" } };
    let history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), first, false);
    const changed = {
      ...sample,
      readAt: later,
      account: {
        ...sample.account,
        sourceId: "cc:B",
        balance: null,
        totalTokens: null,
        todayCost: null,
        readAt: null,
      },
    };
    history = mergeHeaderUsageHistory(history, changed, false);
    const view = presentHeaderUsageHistory(history, first, "codex", "Codex", false);
    expect(view.data?.account.sourceId).toBe("cc:B");
    expect(view.data?.account.balance).toBeNull();
  });

  it("advances the source watermark on same-account confirmations without rolling it back", () => {
    const sample = historySummary();
    const newest = "2026-10-31T10:02:00.000Z";
    const reply = (sourceId: string, readAt: string, balance: number) => ({
      ...sample,
      readAt,
      account: { ...sample.account, sourceId, balance, readAt },
    });
    let history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), reply("cc:A", at, 10), false);
    history = mergeHeaderUsageHistory(history, reply("cc:A", newest, 30), false);
    expect(history.account.sourceReadAt).toBe(newest);
    history = mergeHeaderUsageHistory(history, reply("cc:A", later, 20), false);
    expect(history.account.sourceReadAt).toBe(newest);
    history = mergeHeaderUsageHistory(history, reply("cc:B", later, 20), false);
    const view = presentHeaderUsageHistory(
      history,
      reply("cc:B", later, 20),
      "codex",
      "Codex",
      false,
    );
    expect(history.account.currentSourceId).toBe("cc:A");
    expect(view.data?.account.sourceId).toBe("cc:A");
    expect(view.data?.account.balance).toBe(30);
  });

  it("preserves supported empty sample lists and independently caches samples with unknown cache hits", () => {
    const sample = historySummary();
    const empty = {
      ...sample,
      conversation: {
        ...sample.conversation,
        recentCacheSamples: [],
        recentSpeedSamples: [],
        recentRequestSamples: [],
      },
    };
    const view = presentHeaderUsageHistory(
      emptyHeaderUsageHistory(),
      empty,
      "codex",
      "Codex",
      false,
    );
    expect(view.data?.conversation.recentCacheSamples).toEqual([]);
    expect(view.data?.conversation.recentSpeedSamples).toEqual([]);
    expect(view.data?.conversation.recentRequestSamples).toEqual([]);
    const unknown = {
      ...sample,
      conversation: {
        ...sample.conversation,
        recentRate: null,
        recentRequestSamples: [
          { timestamp: at, totalTokens: 222, cacheRate: null, tokensPerSecond: null },
        ],
        recentCacheSamples: [
          { timestamp: at, inputTokens: 123, cachedInputTokens: null, cacheRate: null },
        ],
      },
    };
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), unknown, false);
    expect(
      presentHeaderUsageHistory(history, null, "codex", "", false).data?.conversation
        .recentCacheSamples,
    ).toEqual(unknown.conversation.recentCacheSamples);
    expect(
      presentHeaderUsageHistory(history, null, "codex", "", false).data?.conversation
        .recentRequestSamples,
    ).toEqual(unknown.conversation.recentRequestSamples);
    expect(
      presentHeaderUsageHistory(history, null, "codex", "", false).historicalFields
        .recentRequestSamples,
    ).toBe(at);
    expect(presentHeaderUsageHistory(history, null, "codex", "", false).data?.providerLabel).toBe(
      "codex",
    );
  });

  it("does not replace successful groups with backend placeholders or advance their sample times", () => {
    const sample = historySummary();
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), sample, false);
    const placeholder = historySummary({
      readAt: later,
      account: {
        ...sample.account,
        balance: null,
        totalTokens: null,
        todayCost: null,
        readAt: null,
      },
      localReadAt: null,
      conversation: {
        tokens: null,
        cacheRate: null,
        recentRate: null,
        recentSamples: 0,
        partial: true,
      },
    });
    const merged = mergeHeaderUsageHistory(history, placeholder, false);
    expect(merged).toEqual({
      ...history,
      account: { ...history.account, sourceReadAt: later },
    });
    const view = presentHeaderUsageHistory(history, placeholder, "codex", "Codex", false);
    expect(view.data?.account.balance).toBe(10);
    expect(view.data?.conversation.recentSpeedSamples).toEqual(
      sample.conversation.recentSpeedSamples,
    );
    expect(view.data?.localReadAt).toBe(at);
    expect(Object.keys(view.historicalFields)).toHaveLength(12);
  });

  it("merges each successful field independently, retaining real zero and older missing fields", () => {
    const sample = historySummary();
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), sample, false);
    const partial = historySummary({
      localReadAt: later,
      account: { ...sample.account, balance: 0, totalTokens: null, todayCost: 0, readAt: later },
      conversation: {
        ...sample.conversation,
        tokens: 0,
        cacheRate: 0,
        recentRate: null,
        lastRate: null,
        recentSpeed: null,
        lastSpeed: null,
        recentCacheSamples: [],
        recentSpeedSamples: [],
      },
    });
    const merged = mergeHeaderUsageHistory(history, partial, false);
    const view = presentHeaderUsageHistory(merged, partial, "codex", "Codex", false);
    expect(view.data?.account.balance).toBe(0);
    expect(view.data?.account.todayCost).toBe(0);
    expect(view.data?.account.totalTokens).toBe(999);
    expect(view.data?.conversation.tokens).toBe(0);
    expect(view.data?.conversation.cacheRate).toBe(0);
    expect(view.historicalFields.totalTokens).toBe(at);
    expect(view.historicalFields.recentRate).toBe(at);
    expect(view.historicalFields.recentSpeed).toBe(at);
    expect(view.historicalFields.balance).toBeUndefined();
    expect(view.data?.conversation.recentCacheSamples).toEqual(
      sample.conversation.recentCacheSamples,
    );
  });

  it("ignores older responses and marks retained data historical after a failed sync", () => {
    const sample = historySummary();
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), sample, false);
    const older = historySummary({
      account: { ...sample.account, balance: 2, readAt: "2026-10-30T10:00:00Z" },
    });
    const view = presentHeaderUsageHistory(history, older, "codex", "Codex", false, "offline");
    expect(view.data?.account.balance).toBe(10);
    expect(Object.keys(view.historicalFields)).toHaveLength(12);
    expect(
      presentHeaderUsageHistory(
        history,
        historySummary({ providerInstanceId: "claude" }),
        "codex",
        "Codex",
        false,
      ).historicalFields.balance,
    ).toBe(at);
  });

  it("uses a confirmed account source immediately, even when the new account is still empty", () => {
    const sample = historySummary();
    const first = {
      ...sample,
      account: { ...sample.account, sourceId: "cc:A", sourceLabel: "账户A" },
    };
    const history = mergeHeaderUsageHistory(emptyHeaderUsageHistory(), first, false);
    const changed = {
      ...sample,
      account: {
        ...sample.account,
        balance: null,
        totalTokens: null,
        todayCost: null,
        readAt: null,
        sourceId: "cc:B",
        sourceLabel: "账户B",
      },
    };
    const view = presentHeaderUsageHistory(history, changed, "codex", "Codex", false);
    expect(view.data?.account.balance).toBeNull();
    expect(view.data?.account.totalTokens).toBeNull();
    expect(view.data?.account.todayCost).toBeNull();
    expect(view.data?.conversation.tokens).toBe(123456);
    const switched = mergeHeaderUsageHistory(history, changed, false);
    expect(
      presentHeaderUsageHistory(switched, null, "codex", "Codex", false, "offline").data?.account
        .balance,
    ).toBeNull();
    expect(
      presentHeaderUsageHistory(switched, first, "codex", "Codex", false).data?.account.balance,
    ).toBe(10);
  });

  it("restores explicit identity without config and never guesses auto from configuration", () => {
    expect(resolveHeaderUsageHistoryProvider(undefined, undefined)).toBeUndefined();
    expect(resolveHeaderUsageHistoryProvider(undefined, "codex")).toBe("codex");
    const config = {
      environment: { capabilities: { headerUsage: true } },
      settings: { providerInstances: {} },
      providers: [
        {
          instanceId: "codex" as ProviderInstanceId,
          driver: "codex" as ProviderDriverKind,
          enabled: true,
          displayName: "Codex",
        },
      ],
    };
    expect(resolveHeaderUsageHistoryProvider(config, undefined)).toBeUndefined();
    expect(resolveHeaderUsageHistoryProvider(undefined, undefined, "codex")).toBe("codex");
    expect(resolveHeaderUsageHistoryProvider(config, "codex")).toBe("codex");
  });
});

function setupStore() {
  const rows = new Map<string, string>();
  const writes: string[] = [];
  const db = {
    loadCache: (environment: EnvironmentId, kind: string, key: string) =>
      Effect.sync(() => Option.fromNullishOr(rows.get(JSON.stringify([environment, kind, key])))),
    saveCache: (
      environment: EnvironmentId,
      kind: string,
      key: string,
      _version: number,
      payload: string,
    ) =>
      Effect.sync(() => {
        writes.push(payload);
        rows.set(JSON.stringify([environment, kind, key]), payload);
      }),
  };
  const target: HeaderUsageHistoryTarget = {
    environmentId: "env1" as EnvironmentId,
    providerInstanceId: "codex",
    threadId: "thread1",
    home: false,
  };
  return { rows, writes, db, target, store: createHeaderUsageHistoryStore(db) };
}

describe("header usage persisted identities", () => {
  it("shares only account history between threads and isolates provider, environment and homepage counters", async () => {
    const { store, target } = setupStore();
    await store.save(target, historySummary());
    const otherThread = await store.load({ ...target, threadId: "thread2" });
    expect(otherThread.local).toBeNull();
    expect(otherThread.account.entries[0]?.values.balance).toBe(10);
    expect((await store.load({ ...target, providerInstanceId: "claude" })).account.entries).toEqual(
      [],
    );
    expect(
      (await store.load({ ...target, environmentId: "env2" as EnvironmentId })).local,
    ).toBeNull();
    expect((await store.load({ ...target, home: true })).local).toBeNull();
    await store.save({ ...target, home: true }, historySummary());
    expect((await store.load(target)).local?.values.tokens).toBe(123456);
    expect((await store.load({ ...target, home: true })).local?.values.tokens).toBe(500000);
    expect((await store.load({ ...target, threadId: "thread2" })).local).toBeNull();
  });

  it("restores explicit routes without config, and restores auto only through a scoped confirmed mapping", async () => {
    const { store, target, db } = setupStore();
    expect(await store.resolveProvider(target)).toBe("codex");
    const automatic = { environmentId: target.environmentId, home: true };
    expect(await store.resolveProvider(automatic)).toBeNull();
    await store.save({ ...target, home: true }, historySummary(), true);
    const reopened = createHeaderUsageHistoryStore(db);
    expect(await reopened.resolveProvider(automatic)).toBe("codex");
    expect((await reopened.load({ ...target, home: true })).local?.values.recentSpeed).toBe(150);
    expect(
      await reopened.resolveProvider({ ...automatic, environmentId: "unknown" as EnvironmentId }),
    ).toBeNull();
    expect(
      await reopened.resolveProvider({ ...automatic, home: false, threadId: "thread2" }),
    ).toBeNull();
    await store.save(
      { ...target, home: true, providerInstanceId: "claude" },
      historySummary({ providerInstanceId: "claude" }),
      true,
    );
    expect(await reopened.resolveProvider(automatic)).toBe("claude");
    expect((await reopened.load({ ...target, home: true })).local?.values.tokens).toBe(500000);
  });

  it("never writes query keys, API keys, backend messages or unrecognized payload fields", async () => {
    const { store, target, writes } = setupStore();
    const sample = historySummary();
    const withSecrets = {
      ...sample,
      queryKey: "root-secret",
      account: {
        ...sample.account,
        message: "api-key-secret",
        billingKey: "billing-secret",
      },
      conversation: {
        ...sample.conversation,
        recentSpeedSamples: [
          {
            ...sample.conversation.recentSpeedSamples![0]!,
            apiKey: "sample-secret",
          },
        ],
        recentRequestSamples: [
          { ...sample.conversation.recentRequestSamples![0]!, apiKey: "request-secret" },
        ],
      },
    };
    await store.save(target, withSecrets);
    expect(writes.join("\n")).not.toMatch(/secret|queryKey|billingKey|apiKey/);
  });

  it("persists source confirmations without rewriting sample values or their times", async () => {
    const { store, target, writes } = setupStore();
    const sample = historySummary();
    await store.save(target, sample);
    const count = writes.length;
    await store.load(target);
    await store.save(target, sample);
    expect(writes).toHaveLength(count);
    await store.save(target, { ...sample, readAt: later });
    const confirmationWrites = writes.length;
    expect(confirmationWrites).toBe(count + 1);
    await store.save(
      target,
      historySummary({
        account: {
          ...sample.account,
          balance: null,
          totalTokens: null,
          todayCost: null,
          readAt: null,
        },
        localReadAt: null,
      }),
    );
    expect(writes).toHaveLength(confirmationWrites);
    const restored = await store.load(target);
    expect(restored.account.sourceReadAt).toBe(later);
    expect(restored.account.entries[0]?.values.readAt).toBe(at);
    expect(restored.local?.values.speedSampleAt).toBe(at);
  });

  it("keeps an empty new source selected after reopening and bounds retained account sources", async () => {
    const { store, target, db } = setupStore();
    const sample = historySummary();
    await store.save(target, { ...sample, account: { ...sample.account, sourceId: "A" } });
    const switched = {
      ...sample,
      readAt: later,
      account: {
        ...sample.account,
        sourceId: "B",
        balance: null,
        totalTokens: null,
        todayCost: null,
        readAt: null,
      },
    };
    await store.save(target, switched);
    const reopened = createHeaderUsageHistoryStore(db);
    const history = await reopened.load(target);
    const view = presentHeaderUsageHistory(history, null, "codex", "Codex", false, "offline");
    expect(view.data?.account.sourceId).toBe("B");
    expect(view.data?.account.balance).toBeNull();
    expect(view.data?.conversation.recentSpeed).toBe(150);
    for (let index = 0; index < 12; index++)
      await store.save(target, {
        ...sample,
        readAt: later,
        account: { ...sample.account, sourceId: String(index) },
      });
    expect((await reopened.load(target)).account.entries).toHaveLength(8);
  });

  it("ignores corrupt disk data and mismatched provider replies", async () => {
    const { store, target, rows } = setupStore();
    await store.save(target, historySummary());
    for (const key of rows.keys()) rows.set(key, "{broken-json");
    expect(await store.load(target)).toEqual(emptyHeaderUsageHistory());
    expect(await store.save(target, historySummary({ providerInstanceId: "claude" }))).toEqual(
      emptyHeaderUsageHistory(),
    );
  });
});
