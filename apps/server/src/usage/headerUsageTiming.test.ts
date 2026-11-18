import { describe, expect, it } from "vite-plus/test";
import { HeaderUsageTiming } from "./headerUsageTiming.ts";

function setup() {
  const timing = new HeaderUsageTiming();
  const send = (method: string, params: object, now: number) =>
    timing.observe(
      {
        direction: "incoming",
        stage: "decoded",
        payload: { method, params: { threadId: "session", turnId: "turn", ...params } },
      },
      now,
    );
  const usage = (total: number) => ({
    tokenUsage: {
      last: {
        inputTokens: 100,
        cachedInputTokens: 90,
        outputTokens: 60,
        reasoningOutputTokens: 20,
      },
      total: { totalTokens: total },
    },
  });
  const key = {
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
  const stream = (id = "text", first = 1000, seconds = 2, parts = Array<string>(20).fill("x")) => {
    send("item/started", { item: { id, type: "agentMessage", text: "" } }, first - 100);
    parts.forEach((delta, index) =>
      send(
        "item/agentMessage/delta",
        { itemId: id, delta },
        first + (index * seconds * 1000) / (parts.length - 1),
      ),
    );
    send(
      "item/completed",
      { item: { id, type: "agentMessage", text: parts.join("") } },
      first + seconds * 1000 + 100,
    );
  };
  return { timing, send, usage, key, stream };
}

describe("header streaming timing", () => {
  it("rejects the real 374-token / 181ms buffered delivery path instead of publishing 2.1K", () => {
    const { timing, send, usage, key, stream } = setup();
    // Synthetic text; counters, duration and length come from the real v1 record.
    stream(
      "text",
      2,
      0.181277499999851,
      Array.from({ length: 10 }, (_, i) => "x".repeat(i === 9 ? 59 : 58)),
    );
    const counts = usage(181043);
    counts.tokenUsage.last.outputTokens = 729;
    counts.tokenUsage.last.reasoningOutputTokens = 355;
    send("thread/tokenUsage/updated", counts, 400);
    expect(
      timing.lookup({ ...key, totals: { ...key.totals, outputTokens: 729, reasoningTokens: 355 } }),
    ).toBeNull();
  });
  it("measures complete sustained text in seconds, excludes reasoning tokens and ignores duplicate usage", () => {
    const { timing, send, usage, key, stream } = setup();
    stream();
    const measured = send("thread/tokenUsage/updated", usage(160), 9000);
    expect(measured).toMatchObject({
      tokens: 40,
      seconds: 2,
      evidence: [{ chars: 20, chunks: 20 }],
    });
    expect(timing.lookup(key)).toEqual({ tokens: 40, seconds: 2 });
    send("thread/tokenUsage/updated", usage(160), 10000);
    expect(timing.lookup(key)).toEqual({ tokens: 40, seconds: 2 });
    expect(timing.lookup({ ...key, sessionId: "other" })).toBeNull();
  });
  it("does not cap high speeds when complete sustained delivery is observable", () => {
    const { timing, send, usage, key, stream } = setup();
    stream("text", 1000, 2, Array<string>(20).fill("x".repeat(5000)));
    const counts = usage(20100);
    counts.tokenUsage.last.outputTokens = 20000;
    counts.tokenUsage.last.reasoningOutputTokens = 0;
    send("thread/tokenUsage/updated", counts, 9000);
    expect(
      timing.lookup({ ...key, totals: { ...key.totals, outputTokens: 20000, reasoningTokens: 0 } }),
    ).toEqual({ tokens: 20000, seconds: 2 });
  });
  it("sums separate complete streams without timing intervening reasoning or tool waits", () => {
    const { timing, send, usage, key, stream } = setup();
    send("item/started", { item: { type: "mcpToolCall" } }, 0);
    send("thread/tokenUsage/updated", usage(100), 500);
    send("item/completed", { item: { type: "mcpToolCall" } }, 600);
    stream("a", 1000);
    send("item/started", { item: { type: "reasoning" } }, 10000);
    send("item/completed", { item: { type: "reasoning" } }, 50000);
    stream("b", 51000);
    const counts = usage(260);
    counts.tokenUsage.last.inputTokens = 200;
    send("thread/tokenUsage/updated", counts, 60000);
    expect(timing.lookup({ ...key, totals: { ...key.totals, uncachedInputTokens: 110 } })).toEqual({
      tokens: 40,
      seconds: 4,
    });
  });
  it("does not treat user input as tool output", () => {
    const { timing, send, usage, key, stream } = setup();
    send("item/started", { item: { type: "userMessage" } }, 0);
    stream();
    send("thread/tokenUsage/updated", usage(160), 9000);
    expect(timing.lookup(key)).toEqual({ tokens: 40, seconds: 2 });
  });
  it("rejects missing or altered delta coverage, absent boundaries and prefilled snapshots", () => {
    for (const mode of [
      "missing",
      "altered",
      "unstarted",
      "uncompleted",
      "prefilled",
      "no-id",
      "reversed",
    ]) {
      const { timing, send, usage, key } = setup();
      if (mode !== "unstarted")
        send(
          "item/started",
          {
            item: {
              id: "text",
              type: "agentMessage",
              text: mode === "prefilled" ? "snapshot" : "",
            },
          },
          0,
        );
      for (let i = 0; i < 20; i++)
        send(
          "item/agentMessage/delta",
          { ...(mode === "no-id" ? {} : { itemId: "text" }), delta: "x" },
          1000 + i * 100,
        );
      if (mode !== "uncompleted")
        send(
          "item/completed",
          {
            item: {
              id: "text",
              type: "agentMessage",
              text: (mode === "altered" ? "y" : "x").repeat(mode === "missing" ? 200 : 20),
            },
          },
          mode === "reversed" ? 500 : 4000,
        );
      send("thread/tokenUsage/updated", usage(160), 9000);
      expect(timing.lookup(key), mode).toBeNull();
    }
  });
  it("rejects short, sparse and snapshot-dominated delivery without a speed threshold", () => {
    const cases = [
      { seconds: 0.5, parts: Array<string>(20).fill("x") },
      { seconds: 2, parts: ["x", "x"] },
      { seconds: 2, parts: ["x".repeat(100), ...Array<string>(19).fill("x")] },
      { seconds: 2, parts: ["x", "x", "x".repeat(100), ...Array<string>(17).fill("x")] },
    ];
    for (const { seconds, parts } of cases) {
      const { timing, send, usage, key, stream } = setup();
      stream("text", 1000, seconds, parts);
      send("thread/tokenUsage/updated", usage(160), 9000);
      expect(timing.lookup(key)).toBeNull();
    }
    const { timing, send, usage, key } = setup();
    send("item/started", { item: { id: "text", type: "agentMessage", text: "" } }, 0);
    for (let i = 0; i < 20; i++)
      send("item/agentMessage/delta", { itemId: "text", delta: "x" }, i < 10 ? 1000 : 3000);
    send(
      "item/completed",
      { item: { id: "text", type: "agentMessage", text: "x".repeat(20) } },
      4000,
    );
    send("thread/tokenUsage/updated", usage(160), 9000);
    expect(timing.lookup(key)).toBeNull();
  });
  it("does not combine short items into an apparently long measurement", () => {
    const { timing, send, usage, key, stream } = setup();
    stream("a", 1000, 0.6);
    stream("b", 3000, 0.6);
    send("thread/tokenUsage/updated", usage(160), 9000);
    expect(timing.lookup(key)).toBeNull();
  });
  it("rejects tools, explicit buffering, overlapping reasoning and errors", () => {
    for (const type of [
      "commandExecution",
      "mcpToolCall",
      "futureTool",
      "buffering",
      "reasoning",
      "error",
    ]) {
      const { timing, send, usage, key, stream } = setup();
      stream();
      if (type === "buffering")
        send("model/safetyBuffering/updated", { showBufferingUi: true }, 3500);
      else if (type === "error") send("error", {}, 3500);
      else if (type === "reasoning") {
        send("item/started", { item: { id: "open", type: "agentMessage", text: "" } }, 3500);
        send("item/started", { item: { type } }, 3600);
      } else send("item/started", { item: { type } }, 3500);
      send("thread/tokenUsage/updated", usage(160), 9000);
      expect(timing.lookup(key), type).toBeNull();
    }
  });
  it("invalidates failed turns and ambiguous repeated count signatures", () => {
    const { timing, send, usage, key, stream } = setup();
    stream();
    send("thread/tokenUsage/updated", usage(160), 9000);
    send("turn/completed", { turn: { id: "turn", status: "failed" } }, 10000);
    expect(timing.lookup(key)).toBeNull();
    stream("b", 11000);
    send("thread/tokenUsage/updated", usage(320), 15000);
    stream("c", 16000);
    send("thread/tokenUsage/updated", usage(480), 20000);
    expect(timing.lookup(key)).toBeNull();
  });
  it("hashes split surrogate pairs consistently without retaining text", () => {
    const { timing, send, usage, key, stream } = setup();
    stream("text", 1000, 2, ["x", "\ud83d", "\ude00", ...Array<string>(17).fill("x")]);
    send("thread/tokenUsage/updated", usage(160), 9000);
    expect(timing.lookup(key)).toEqual({ tokens: 40, seconds: 2 });
  });
  it("rejects fractional counts and invalid reasoning or cache totals", () => {
    for (const mode of ["fraction", "reasoning", "cache", "zero"]) {
      const { timing, send, usage, key, stream } = setup();
      stream();
      const counts = usage(160);
      if (mode === "fraction") counts.tokenUsage.last.outputTokens = 60.5;
      if (mode === "reasoning") counts.tokenUsage.last.reasoningOutputTokens = 61;
      if (mode === "cache") counts.tokenUsage.last.cachedInputTokens = 101;
      if (mode === "zero") counts.tokenUsage.last.reasoningOutputTokens = 60;
      send("thread/tokenUsage/updated", counts, 9000);
      expect(timing.lookup(key)).toBeNull();
    }
  });
});
