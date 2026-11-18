// @effect-diagnostics nodeBuiltinImport:off - retain hashes, never streamed text.
import * as NodeCrypto from "node:crypto";
import type { HeaderRequest } from "./headerUsageScan.ts";

export const HEADER_USAGE_TIMING_VERSION = 2;
export const HEADER_USAGE_TIMING_BASIS = "verified-text-deltas";
const MIN_STREAM_SECONDS = 1;
const MIN_CHUNKS = 5;
const MIN_SPACED_INTERVALS = 4;
const MIN_SPACING_MS = 20;
const MAX_FIRST_CHUNK_SHARE = 0.1;
const MAX_CHUNK_SHARE = 0.5;

interface TextEvidence {
  readonly chars: number;
  readonly hash: string;
  readonly chunks: number;
  readonly spacedIntervals: number;
  readonly firstChunkChars: number;
  readonly maxChunkChars: number;
  readonly seconds: number;
}

interface TextWindow {
  started?: number;
  completed?: number;
  first?: number;
  last?: number;
  chunks: number;
  chars: number;
  hash: NodeCrypto.Hash;
  spacedIntervals: number;
  firstChunkChars: number;
  maxChunkChars: number;
  covered: boolean;
}
interface Window {
  texts: Map<string, TextWindow>;
  tool: boolean;
  invalid: boolean;
}
export interface HeaderStreamSample {
  readonly tokens: number;
  readonly seconds: number;
}
interface HeaderStreamMeasurement extends HeaderStreamSample {
  readonly evidence: readonly TextEvidence[];
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const newText = (): TextWindow => ({
  chunks: 0,
  chars: 0,
  hash: NodeCrypto.createHash("sha256"),
  spacedIntervals: 0,
  firstChunkChars: 0,
  maxChunkChars: 0,
  covered: false,
});

// These are observation-quality gates, not a token-rate ceiling. A brief batch,
// an initial snapshot or two bursts cannot establish sustained streaming speed.
function validEvidence(value: unknown): value is TextEvidence {
  const e = object(value);
  return (
    validCount(e.chars) &&
    e.chars > 0 &&
    typeof e.hash === "string" &&
    /^[a-f0-9]{64}$/.test(e.hash) &&
    validCount(e.chunks) &&
    e.chunks >= MIN_CHUNKS &&
    e.chunks <= e.chars &&
    validCount(e.spacedIntervals) &&
    e.spacedIntervals >= MIN_SPACED_INTERVALS &&
    e.spacedIntervals < e.chunks &&
    validCount(e.firstChunkChars) &&
    e.firstChunkChars > 0 &&
    e.firstChunkChars <= e.chars * MAX_FIRST_CHUNK_SHARE &&
    validCount(e.maxChunkChars) &&
    e.maxChunkChars >= e.firstChunkChars &&
    e.maxChunkChars <= e.chars * MAX_CHUNK_SHARE &&
    typeof e.seconds === "number" &&
    Number.isFinite(e.seconds) &&
    e.seconds >= MIN_STREAM_SECONDS
  );
}

function verifiedMeasurement(value: unknown, tokens: number): HeaderStreamMeasurement | null {
  const sample = object(value);
  if (
    sample.tokens !== tokens ||
    !validCount(tokens) ||
    tokens <= 0 ||
    typeof sample.seconds !== "number" ||
    !Number.isFinite(sample.seconds) ||
    !Array.isArray(sample.evidence) ||
    !sample.evidence.length ||
    sample.evidence.length > 128 ||
    !sample.evidence.every(validEvidence)
  )
    return null;
  const seconds = sample.evidence.reduce((sum, e) => sum + e.seconds, 0);
  return Math.abs(seconds - sample.seconds) < 1e-9
    ? { tokens, seconds, evidence: sample.evidence }
    : null;
}
function boundedSet<T>(map: Map<string, T>, key: string, value: T, limit: number) {
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}

// In-memory metadata only: no prompts, deltas, API keys or extra remote requests.
// Match exact native turn + token counts; ambiguous identical requests stay unknown.
export class HeaderUsageTiming {
  private readonly windows = new Map<string, Window>();
  private readonly totals = new Map<string, string>();
  private readonly samples = new Map<string, HeaderStreamMeasurement | null>();

  observe(
    event: { direction: string; stage: string; payload: unknown },
    now: number,
    persisted?: unknown,
  ): HeaderStreamMeasurement | null | undefined {
    if (event.direction !== "incoming" || event.stage !== "decoded" || !Number.isFinite(now))
      return;
    const envelope = object(event.payload);
    const params = object(envelope.params);
    const turn = object(params.turn);
    const sessionId = params.threadId;
    const turnId = params.turnId ?? turn.id;
    if (typeof sessionId !== "string" || typeof turnId !== "string") return;
    const prefix = JSON.stringify([sessionId, turnId]) + ":";
    if (envelope.method === "turn/completed") {
      this.windows.delete(prefix);
      if (turn.status !== "completed") {
        for (const key of this.samples.keys()) if (key.startsWith(prefix)) this.samples.delete(key);
      }
      return;
    }
    if (
      ![
        "item/agentMessage/delta",
        "item/started",
        "item/completed",
        "thread/tokenUsage/updated",
        "model/safetyBuffering/updated",
        "error",
      ].includes(String(envelope.method))
    )
      return;
    const window = this.windows.get(prefix) ?? {
      texts: new Map<string, TextWindow>(),
      tool: false,
      invalid: false,
    };
    if (envelope.method === "item/agentMessage/delta") {
      if (typeof params.delta !== "string" || !params.delta.length) return;
      const id = typeof params.itemId === "string" ? params.itemId : "";
      const text = window.texts.get(id) ?? newText();
      if (!id || text.started === undefined || text.completed !== undefined) window.invalid = true;
      text.first ??= now;
      if (text.last !== undefined && now < text.last) window.invalid = true;
      if (text.last !== undefined && now - text.last >= MIN_SPACING_MS) text.spacedIntervals++;
      text.last = now;
      if (!text.chunks) text.firstChunkChars = params.delta.length;
      text.chunks++;
      text.chars += params.delta.length;
      text.maxChunkChars = Math.max(text.maxChunkChars, params.delta.length);
      // UTF-16 code units remain identical even when a surrogate pair is split
      // across notifications; no copy of the delta survives this callback.
      text.hash.update(params.delta, "utf16le");
      window.texts.set(id, text);
    } else if (envelope.method === "item/started" || envelope.method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage") {
        if (typeof item.id !== "string") window.invalid = true;
        else {
          const text = window.texts.get(item.id) ?? newText();
          if (envelope.method === "item/started") {
            if (text.started !== undefined || text.chunks || item.text !== "")
              window.invalid = true;
            if (
              [...window.texts.values()].some(
                (t) => t.started !== undefined && t.completed === undefined,
              )
            )
              window.invalid = true;
            text.started = now;
          } else {
            if (
              text.started === undefined ||
              text.completed !== undefined ||
              now < text.started ||
              (text.last !== undefined && now < text.last)
            )
              window.invalid = true;
            text.completed = now;
            text.covered =
              typeof item.text === "string" &&
              item.text.length === text.chars &&
              NodeCrypto.createHash("sha256").update(item.text, "utf16le").digest("hex") ===
                text.hash.copy().digest("hex");
          }
          window.texts.set(item.id, text);
        }
      } else if (item.type === "reasoning" && envelope.method === "item/started") {
        if (
          [...window.texts.values()].some(
            (t) => t.started !== undefined && t.completed === undefined,
          )
        )
          window.invalid = true;
      } else if (
        envelope.method === "item/started" &&
        item.type !== "reasoning" &&
        item.type !== "userMessage"
      )
        window.tool = true;
    } else if (envelope.method === "error") {
      window.tool = true;
    } else if (envelope.method === "model/safetyBuffering/updated") {
      if (params.showBufferingUi === true) window.invalid = true;
    } else {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const total = object(usage.total);
      const cumulative = JSON.stringify(total);
      if (Object.keys(total).length === 0 || this.totals.get(sessionId) === cumulative) return;
      boundedSet(this.totals, sessionId, cumulative, 512);
      const counts = [
        last.inputTokens,
        last.cachedInputTokens,
        last.outputTokens,
        last.reasoningOutputTokens,
      ];
      if (counts.every(validCount)) {
        const [input, cached, output, reasoning] = counts as number[];
        let valid = !window.invalid && window.texts.size > 0;
        const evidence: TextEvidence[] = [];
        for (const text of window.texts.values()) {
          // Only deltas supply duration. Item boundaries may arrive buffered.
          // Sum individual streams so intervening reasoning is never timed.
          const duration =
            text.chunks >= 2 && text.first !== undefined && text.last !== undefined
              ? text.last - text.first
              : 0;
          const item: TextEvidence = {
            chars: text.chars,
            hash: text.hash.copy().digest("hex"),
            chunks: text.chunks,
            spacedIntervals: text.spacedIntervals,
            firstChunkChars: text.firstChunkChars,
            maxChunkChars: text.maxChunkChars,
            seconds: duration / 1000,
          };
          if (
            !text.covered ||
            text.started === undefined ||
            text.completed === undefined ||
            !validEvidence(item)
          )
            valid = false;
          evidence.push(item);
        }
        const seconds = evidence.reduce((sum, item) => sum + item.seconds, 0);
        // The provider reports request-wide non-reasoning counts, not per-delta
        // tokens. This measures received throughput, not model generation time.
        // Tool JSON has no corresponding text stream and cannot be timed here.
        const measured =
          !window.tool &&
          valid &&
          cached! <= input! &&
          reasoning! <= output! &&
          output! - reasoning! > 0
            ? verifiedMeasurement(
                { tokens: output! - reasoning!, seconds, evidence },
                output! - reasoning!,
              )
            : null;
        const sample =
          persisted === undefined
            ? measured
            : cached! <= input! && reasoning! <= output! && !window.tool
              ? verifiedMeasurement(persisted, output! - reasoning!)
              : null;
        const key = prefix + JSON.stringify(counts);
        boundedSet(this.samples, key, this.samples.has(key) ? null : sample, 2048);
        this.windows.delete(prefix);
        return this.samples.get(key) ?? null;
      }
      this.windows.delete(prefix);
      return;
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

export const headerUsageTiming = new HeaderUsageTiming();
