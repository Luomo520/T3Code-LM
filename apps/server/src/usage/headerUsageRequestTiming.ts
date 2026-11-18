import type { HeaderRequest } from "./headerUsageScan.ts";
import type { HeaderStreamSample } from "./headerUsageTiming.ts";

// An explicitly approximate request-output rate, NOT a text-delta generation
// rate. Includes all output tokens (including reasoning), first-token latency
// and local request overhead. Stops before the first observed tool execution.
export const HEADER_USAGE_REQUEST_TIMING_BASIS = "request-output-rate";
const MIN_SECONDS = 1;
const TOOL_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "fileChange",
  "webSearch",
  "imageView",
  "imageGeneration",
  "sleep",
  "subAgentActivity",
]);
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function boundedSet<T>(map: Map<string, T>, key: string, value: T, limit: number) {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
interface RequestWindow {
  started: number | undefined;
  lastSeen: number;
  ended?: number;
  frozen: boolean;
  invalid: boolean;
  generating: Set<string>;
}
const windowAt = (now: number, started?: number): RequestWindow => ({
  started,
  lastSeen: now,
  frozen: false,
  invalid: false,
  generating: new Set(),
});

// Retains only counters, timestamps and native ids; no text or tool arguments.
export class HeaderUsageRequestTiming {
  private readonly windows = new Map<string, RequestWindow>();
  private readonly totals = new Map<string, string>();
  private readonly samples = new Map<string, HeaderStreamSample | null>();

  // A missing/corrupt protocol boundary cannot be bridged by an estimate.
  // Completed samples remain usable; a later distinct usage starts fresh.
  invalidatePending(): void {
    this.windows.clear();
  }

  observe(
    event: { direction: string; stage: string; payload: unknown },
    now: number,
  ): HeaderStreamSample | null | undefined {
    if (event.direction !== "incoming" || event.stage !== "decoded" || !Number.isFinite(now))
      return;
    const envelope = object(event.payload);
    const params = object(envelope.params);
    const turn = object(params.turn);
    const sessionId = params.threadId;
    const turnId = params.turnId ?? turn.id;
    if (typeof sessionId !== "string" || typeof turnId !== "string") return;
    const prefix = JSON.stringify([sessionId, turnId]) + ":";
    const method = envelope.method;
    if (method === "turn/completed") {
      this.windows.delete(prefix);
      if (turn.status !== "completed") {
        for (const key of this.samples.keys()) if (key.startsWith(prefix)) this.samples.delete(key);
      }
      return;
    }
    if (method === "turn/started") {
      const existing = this.windows.get(prefix);
      if (existing) existing.invalid = true;
      else boundedSet(this.windows, prefix, windowAt(now, now), 128);
      return;
    }
    if (
      ![
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "model/safetyBuffering/updated",
        "error",
      ].includes(String(method))
    )
      return;
    const window = this.windows.get(prefix) ?? windowAt(now);
    if (now < window.lastSeen) window.invalid = true;
    window.lastSeen = now;
    if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const total = object(usage.total);
      const cumulative = JSON.stringify(total);
      // Repeated notifications are not a request boundary.
      if (!Object.keys(total).length || this.totals.get(sessionId) === cumulative) {
        boundedSet(this.windows, prefix, window, 128);
        return;
      }
      boundedSet(this.totals, sessionId, cumulative, 512);
      const counts = [
        last.inputTokens,
        last.cachedInputTokens,
        last.outputTokens,
        last.reasoningOutputTokens,
      ];
      let result: HeaderStreamSample | null = null;
      if (counts.every(validCount)) {
        const [input, cached, output, reasoning] = counts as number[];
        const seconds =
          window.started !== undefined && window.ended !== undefined
            ? (window.ended - window.started) / 1000
            : 0;
        const valid =
          !window.invalid &&
          !window.generating.size &&
          cached! <= input! &&
          reasoning! <= output! &&
          output! > 0 &&
          Number.isFinite(seconds) &&
          seconds >= MIN_SECONDS;
        const key = prefix + JSON.stringify(counts);
        result = valid && !this.samples.has(key) ? { tokens: output!, seconds } : null;
        boundedSet(this.samples, key, result, 2048);
      }
      // Even unmeasurable requests provide the next conservative start anchor.
      boundedSet(this.windows, prefix, windowAt(now, now), 128);
      return result;
    }
    if (method === "error") window.invalid = true;
    else if (method === "model/safetyBuffering/updated") {
      if (params.showBufferingUi === true) window.invalid = true;
    } else {
      const item = object(params.item);
      const type = item.type;
      if (type === "agentMessage" || type === "reasoning") {
        if (typeof item.id !== "string" || !item.id) window.invalid = true;
        else if (method === "item/started") {
          if (window.frozen || window.generating.has(item.id)) window.invalid = true;
          window.generating.add(item.id);
          if (window.generating.size > 128) {
            window.invalid = true;
            window.generating.clear();
          }
        } else {
          if (window.frozen || !window.generating.delete(item.id)) window.invalid = true;
          if (!window.frozen) window.ended = now;
        }
      } else if (type === "userMessage") {
        // User input is not generated output or a tool boundary.
      } else if (type === "commandExecution" && item.source === "userShell") {
        // Manually run terminal commands are not model-generated invocations.
      } else if (type === "subAgentActivity" && item.kind === "completed") {
        // Background-agent results can be announced as item/started; they are
        // not a new model-generated invocation and cannot stop this request.
      } else if (typeof type === "string" && TOOL_TYPES.has(type)) {
        if (method === "item/started" && !window.frozen) {
          if (window.generating.size) window.invalid = true;
          window.ended = now;
          window.frozen = true;
        }
        // Later exec subcommands and late/background tool completions must not
        // extend the generation window or contaminate the following request.
      } else {
        // In particular, contextCompaction has different request boundaries.
        window.invalid = true;
      }
    }
    boundedSet(this.windows, prefix, window, 128);
  }

  lookup(
    record: Pick<HeaderRequest, "sessionId" | "headerTurnId" | "totals">,
  ): HeaderStreamSample | null {
    const totals = record.totals;
    const key =
      JSON.stringify([record.sessionId, record.headerTurnId]) +
      ":" +
      JSON.stringify([
        totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens,
        totals.cachedInputTokens,
        totals.outputTokens,
        totals.reasoningTokens,
      ]);
    const sample = this.samples.get(key);
    return sample ? { tokens: sample.tokens, seconds: sample.seconds } : null;
  }
}

export const headerUsageRequestTiming = new HeaderUsageRequestTiming();
