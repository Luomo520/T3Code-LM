// @effect-diagnostics nodeBuiltinImport:off - isolated protocol log fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { HeaderUsageTimingHistory } from "./headerUsageTimingHistory.ts";
import { HeaderUsageTiming } from "./headerUsageTiming.ts";
import { aggregateHeaderRequests, type HeaderRequest } from "./headerUsageScan.ts";

const ref = {
  threadId: "thread",
  providerInstanceId: "supplier",
  sessionId: "session",
  turnId: "turn",
};
const request = {
  sessionId: "session",
  headerTurnId: "turn",
  totals: {
    uncachedInputTokens: 10,
    cachedInputTokens: 90,
    cacheCreationTokens: 0,
    outputTokens: 60,
    reasoningTokens: 20,
  },
};
function line(method: string, params: object, second: number, extra: object = {}) {
  return `[2026-10-30T12:00:${String(second).padStart(2, "0")}.000Z] NTIVE: ${JSON.stringify({
    provider: "codex",
    protocol: "codex.app-server",
    kind: "protocol",
    ...extra,
    event: {
      direction: "incoming",
      stage: "decoded",
      payload: { method, params: { threadId: "session", turnId: "turn", ...params } },
    },
  })}\n`;
}
const start = line("item/started", { item: { id: "text", type: "agentMessage" } }, 1);
const complete = line("item/completed", { item: { id: "text", type: "agentMessage" } }, 3);
const usage = (extra = {}) =>
  line(
    "thread/tokenUsage/updated",
    {
      tokenUsage: {
        last: {
          inputTokens: 100,
          cachedInputTokens: 90,
          outputTokens: 60,
          reasoningOutputTokens: 20,
        },
        total: { totalTokens: 160 },
      },
    },
    9,
    extra,
  );
const saved = (sample: unknown, version = 2) => ({
  headerUsageTiming: {
    version,
    basis: version === 2 ? "verified-text-deltas" : "text-deltas",
    sample,
  },
});

function measure() {
  const live = new HeaderUsageTiming();
  const observe = (record: string, now: number) =>
    live.observe(JSON.parse(record.slice(record.indexOf("{"))).event, now);
  observe(line("item/started", { item: { id: "text", type: "agentMessage", text: "" } }, 0), 0);
  for (let i = 0; i < 20; i++)
    observe(
      line("item/agentMessage/delta", { itemId: "text", delta: "x" }, 1),
      1000 + (i * 1000) / 19,
    );
  observe(
    line("item/completed", { item: { id: "text", type: "agentMessage", text: "x".repeat(20) } }, 3),
    3000,
  );
  return observe(usage(), 9000);
}

describe("header protocol timing recovery", () => {
  it("rejects the deployed v1 2.1K summary because it cannot prove stream coverage", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-timing-test-"));
    try {
      const high = line(
        "thread/tokenUsage/updated",
        {
          tokenUsage: {
            last: {
              inputTokens: 180314,
              cachedInputTokens: 178490,
              outputTokens: 729,
              reasoningOutputTokens: 355,
            },
            total: { totalTokens: 181043 },
          },
        },
        9,
        saved({ tokens: 374, seconds: 0.181277499999851 }, 1),
      );
      await NodeFSP.writeFile(NodePath.join(root, "events.thread.log"), start + complete + high);
      const history = new HeaderUsageTimingHistory(root);
      await history.scan([ref]);
      const record: HeaderRequest = {
        ...request,
        sessionId: "session",
        headerTurnId: "turn",
        provider: "codex",
        model: "test",
        timestampMs: 1,
        speed: "standard",
        dedupeKey: null,
        reportedCostUsd: null,
        headerCacheKnown: true,
        totals: {
          uncachedInputTokens: 1824,
          cachedInputTokens: 178490,
          cacheCreationTokens: 0,
          outputTokens: 729,
          reasoningTokens: 355,
        },
      };
      expect(history.lookup(record)).toBeNull();
      expect(
        aggregateHeaderRequests([record], [ref], "thread", false, "supplier", (r) =>
          history.lookup(r),
        ),
      ).toMatchObject({
        recentSpeed: null,
        lastSpeed: null,
        speedSamples: 0,
      });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("does not recover speed from item boundaries without a delta summary", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-timing-test-"));
    try {
      await NodeFSP.writeFile(NodePath.join(root, "events.thread.log"), start + complete + usage());
      const history = new HeaderUsageTimingHistory(root);
      await history.scan([ref]);
      expect(history.lookup(request)).toBeNull();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
  it("restores complete samples after restart, rotation and append; ignores an uncommitted tail", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-timing-test-"));
    try {
      const path = NodePath.join(root, "events.thread.log");
      const measured = measure();
      expect(measured).toMatchObject({
        tokens: 40,
        seconds: 1,
        evidence: [{ chars: 20, chunks: 20 }],
      });
      await NodeFSP.writeFile(path, start + complete + usage(saved(measured ?? null)).trimEnd());
      const history = new HeaderUsageTimingHistory(root);
      await history.scan([ref]);
      expect(history.lookup(request)).toBeNull();
      await NodeFSP.appendFile(path, "\n");
      await history.scan([ref]);
      expect(history.lookup(request)).toEqual({ tokens: 40, seconds: 1 });
      await NodeFSP.rename(path, path + ".1");
      await NodeFSP.writeFile(path, "");
      const restarted = new HeaderUsageTimingHistory(root);
      await restarted.scan([ref]);
      expect(restarted.lookup(request)).toEqual({ tokens: 40, seconds: 1 });
      const record: HeaderRequest = {
        ...request,
        provider: "codex",
        model: "test",
        timestampMs: 1,
        speed: "standard",
        dedupeKey: null,
        reportedCostUsd: null,
        headerCacheKnown: true,
      };
      expect(
        aggregateHeaderRequests([record], [ref], "thread", false, "supplier", (r) =>
          restarted.lookup(r),
        ),
      ).toMatchObject({
        recentSpeed: 40,
        lastSpeed: 40,
        speedSamples: 1,
      });
      // Collection happened without a client query. A new backend reader
      // retains the measurement despite later requests with no usable timing.
      const subsequent = Array.from({ length: 7 }, (_, index) => ({
        ...record,
        timestampMs: index + 2,
        totals: { ...record.totals, outputTokens: record.totals.outputTokens + index + 1 },
      }));
      expect(
        aggregateHeaderRequests([record, ...subsequent], [ref], "thread", false, "supplier", (r) =>
          restarted.lookup(r),
        ),
      ).toMatchObject({
        recentSpeed: 40,
        lastSpeed: 40,
        speedSamples: 1,
        speedSampleAt: "1970-01-01T00:00:00.001Z",
        speedStale: true,
      });
      await restarted.scan([{ ...ref, threadId: "other" }]);
      expect(restarted.lookup(request)).toBeNull();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("uses the persisted delta measurement instead of wider item boundaries", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-timing-test-"));
    try {
      const path = NodePath.join(root, "events.thread.log");
      await NodeFSP.writeFile(path, start + complete + usage(saved(measure())));
      const history = new HeaderUsageTimingHistory(root);
      await history.scan([ref]);
      expect(history.lookup(request)).toEqual({ tokens: 40, seconds: 1 });
      await NodeFSP.writeFile(path, start + complete + usage(saved(null)));
      await history.scan([ref]);
      expect(history.lookup(request)).toBeNull();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, inconsistent or unversioned evidence instead of trusting a plausible speed", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-timing-test-"));
    try {
      const measured = measure()!;
      for (const extra of [
        saved({ tokens: 40, seconds: 1 }),
        saved({ ...measured, seconds: 1000 }),
        saved({ ...measured, tokens: 41 }),
        saved({ ...measured, evidence: [{ ...measured.evidence[0], chunks: 2 }] }),
        saved({ tokens: 40, seconds: 2 }, 1),
        {},
      ]) {
        await NodeFSP.writeFile(NodePath.join(root, "events.thread.log"), usage(extra));
        const history = new HeaderUsageTimingHistory(root);
        await history.scan([ref]);
        expect(history.lookup(request)).toBeNull();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
