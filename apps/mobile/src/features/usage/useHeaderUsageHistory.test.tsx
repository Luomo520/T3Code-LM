import { act, createElement, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";
import { MobileDatabase } from "../../persistence/mobile-database";
import { runtime } from "../../lib/runtime";
import {
  createHeaderUsageHistoryStore,
  type HeaderUsageHistoryRequest,
} from "./headerUsageHistoryStore";
import type { HistoryUsageSummary } from "./headerUsageHistory";
import { useHeaderUsageHistory } from "./useHeaderUsageHistory";

const persistence = vi.hoisted(() => ({ rows: new Map<string, string>() }));
vi.mock("../../lib/runtime", async () => {
  const Effect = await import("effect/Effect");
  const Option = await import("effect/Option");
  const database = {
    loadCache: (environment: string, kind: string, key: string) =>
      Effect.sync(() =>
        Option.fromNullishOr(persistence.rows.get(JSON.stringify([environment, kind, key]))),
      ),
    saveCache: (
      environment: string,
      kind: string,
      key: string,
      _version: number,
      payload: string,
    ) =>
      Effect.sync(() => {
        persistence.rows.set(JSON.stringify([environment, kind, key]), payload);
      }),
  };
  return { runtime: { runPromise: async () => database } };
});

function sample(): HistoryUsageSummary {
  const at = "2026-10-31T10:00:00.000Z";
  const counters = {
    tokens: 123,
    cacheRate: 0.5,
    recentRate: 0.5,
    lastRate: 0.5,
    recentSpeed: 150,
    lastSpeed: 150,
    speedSampleAt: at,
    speedSamples: 1,
    recentSamples: 1,
    partial: false,
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
      sourceId: "cc:A",
    },
    conversation: counters,
    allConversations: { ...counters, tokens: 888 },
  };
}

async function setup() {
  persistence.rows = new Map();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const storage = createHeaderUsageHistoryStore(await runtime.runPromise(MobileDatabase));
  const root = createRoot(document.createElement("div"));
  let latest: ReturnType<typeof useHeaderUsageHistory>;
  function Probe(props: {
    request: HeaderUsageHistoryRequest | null;
    incoming: HistoryUsageSummary | null;
    success: boolean;
    error: string | null;
  }) {
    const result = useHeaderUsageHistory(
      props.request,
      props.incoming,
      props.success,
      props.error,
      "Codex",
    );
    useLayoutEffect(() => {
      latest = result;
    });
    return null;
  }
  onTestFinished(async () => {
    await act(async () => root.unmount());
  });
  const request = {
    environmentId: "offline-environment" as EnvironmentId,
    providerInstanceId: "codex",
    threadId: "thread1",
    home: false,
  };
  return {
    storage,
    request,
    result: () => latest!,
    render: async (
      request: HeaderUsageHistoryRequest | null,
      incoming: HistoryUsageSummary | null = null,
      success = false,
      error: string | null = null,
    ) => {
      await act(async () => {
        root.render(createElement(Probe, { request, incoming, success, error }));
      });
    },
  };
}

describe("offline header history lifecycle", () => {
  it("opens explicit sessions offline without any server configuration and isolates subsequent routes", async () => {
    const app = await setup();
    await app.storage.save(app.request, sample());
    await app.render(app.request);
    expect(app.result().data?.conversation.tokens).toBe(123);
    expect(app.result().historicalFields.tokens).toBe(sample().localReadAt);
    await app.render({ ...app.request, threadId: "thread2" });
    expect(app.result().data?.account.balance).toBe(10);
    expect(app.result().data?.conversation.tokens).toBeNull();
    expect(app.result().data?.conversation.recentSpeed).toBeUndefined();
    await app.render({ ...app.request, environmentId: "unknown" as EnvironmentId });
    expect(app.result().data).toBeNull();
    await app.render({ ...app.request, providerInstanceId: "claude" });
    expect(app.result().data).toBeNull();
  });

  it("restores homepage auto from its persisted mapping without guessing another environment", async () => {
    const app = await setup();
    await app.storage.save({ ...app.request, home: true }, sample(), true);
    const home = { environmentId: app.request.environmentId, home: true };
    await app.render(home);
    expect(app.result().data?.providerInstanceId).toBe("codex");
    expect(app.result().data?.allConversations.tokens).toBe(888);
    expect(app.result().historicalFields.totalTokens).toBe(sample().account.readAt);
    await app.render({ ...home, environmentId: "unknown" as EnvironmentId });
    expect(app.result().data).toBeNull();
    await app.render(null);
    expect(app.result().data).toBeNull();
  });

  it("keeps initial cached responses historical until sync and returns to history on failure", async () => {
    const app = await setup();
    const initial = sample();
    await app.storage.save(app.request, initial);
    await app.render(app.request, initial, true);
    expect(app.result().historicalFields.tokens).toBe(initial.localReadAt);
    const synchronized = { ...initial, readAt: "2026-10-31T10:01:00.000Z" };
    await app.render(app.request, synchronized, true);
    expect(app.result().historicalFields).toEqual({});
    await app.render(app.request, synchronized, false, "offline");
    expect(app.result().historicalFields.tokens).toBe(initial.localReadAt);
    expect(app.result().data?.conversation.speedSampleAt).toBe(initial.conversation.speedSampleAt);
  });

  it("drops a previous account immediately on source changes and never revives it after null/failure", async () => {
    const app = await setup();
    const first = sample();
    await app.storage.save(app.request, first);
    await app.render(app.request);
    const switched = {
      ...first,
      readAt: "2026-10-31T10:01:00.000Z",
      account: {
        ...first.account,
        sourceId: "cc:B",
        balance: null,
        totalTokens: null,
        todayCost: null,
        readAt: null,
      },
    };
    await app.render(app.request, switched, true);
    expect(app.result().data?.account.balance).toBeNull();
    expect(app.result().data?.account.sourceId).toBe("cc:B");
    expect(app.result().data?.conversation.tokens).toBe(123);
    await app.render(app.request, null, false, "offline");
    expect(app.result().data?.account.balance).toBeNull();
    expect(app.result().data?.account.totalTokens).toBeNull();
    expect(app.result().data?.account.todayCost).toBeNull();
    expect(app.result().data?.account.sourceId).toBe("cc:B");
  });

  it("accepts the first successful network response after an initially empty mount", async () => {
    const app = await setup();
    await app.render(app.request);
    expect(app.result().data).toBeNull();
    await app.render(app.request, sample(), true);
    expect(app.result().data?.conversation.recentSpeed).toBe(150);
    expect(app.result().historicalFields).toEqual({});
  });
});
