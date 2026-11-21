// @effect-diagnostics globalDate:off - the scanner receives a captured clock value and Intl needs Date objects for calendar-day bucketing.
import { headerUsageRequestTiming } from "./headerUsageRequestTiming.ts";
import type { HeaderUsageCounters } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import type { UsageRecord, TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import {
  codexUsageFormat,
  CodexScanState,
  initialCodexScanState,
} from "../provider/Drivers/codexUsage.ts";
import {
  listTranscriptFiles,
  readTranscriptRecords,
  type TranscriptParsePosition,
} from "./usageTranscriptReader.ts";
import { object } from "./sub2api.ts";
import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { mergeUsageCopies } from "./usageAggregation.ts";
import { headerUsageTiming, type HeaderStreamSample } from "./headerUsageTiming.ts";

export interface HeaderRequest extends UsageRecord {
  readonly headerTurnId: string;
  readonly headerCacheKnown: boolean;
}

const HeaderCodexScanState = Schema.Struct({
  ...CodexScanState.fields,
  headerPendingCacheKnown: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(Schema.Boolean))),
  ),
});
type HeaderCodexScanState = typeof HeaderCodexScanState.Type;

export const headerCodexFormat: TranscriptUsageFormat<HeaderCodexScanState> = {
  ...codexUsageFormat,
  state: { initial: initialCodexScanState, schema: HeaderCodexScanState },
  parseProjected(projected, state) {
    const payload = object(object(projected).payload);
    const isLedger = object(projected).type === "token_usage_record";
    const usage = isLedger ? object(payload.usage) : object(object(payload.info).last_token_usage);
    const cacheKnown = typeof usage.cached_input_tokens === "number";
    const pending = [...(state.unreportedRequests ?? [])];
    const pendingCacheKnown = state.headerPendingCacheKnown ?? [];
    const cacheByRequest = new Map(
      pending.map((request, index) => [request, pendingCacheKnown[index] ?? false]),
    );
    const records = codexUsageFormat.parseProjected(projected, state);
    // Pending usage can be emitted under a later turn; its metadata must survive incremental scans.
    const remaining = state.unreportedRequests;
    if (remaining === undefined) delete state.headerPendingCacheKnown;
    else
      state.headerPendingCacheKnown = remaining.map(
        (request) => cacheByRequest.get(request) ?? cacheKnown,
      );
    let pendingIndex = 0;
    return records.map((record, index) => {
      if (index === records.length - 1)
        return {
          ...record,
          headerTurnId: state.turnId,
          headerCacheKnown: cacheKnown,
        } satisfies HeaderRequest;
      while (pendingIndex < pending.length) {
        const attributionIndex = pendingIndex++;
        const attribution = pending[attributionIndex]!;
        if (
          attribution.usage.input_tokens + attribution.usage.output_tokens === 0 ||
          attribution.timestampMs !== record.timestampMs ||
          attribution.model !== record.model ||
          attribution.speed !== record.speed
        )
          continue;
        return {
          ...record,
          headerTurnId: attribution.turnId,
          headerCacheKnown:
            (pendingCacheKnown[attributionIndex] ?? false) &&
            (isLedger || attributionIndex < pending.length - 1 || cacheKnown),
        } satisfies HeaderRequest;
      }
      return { ...record, headerTurnId: "", headerCacheKnown: false } satisfies HeaderRequest;
    });
  },
  parseLine(line, state) {
    let projected: unknown;
    try {
      projected = JSON.parse(line);
    } catch {
      return [];
    }
    return headerCodexFormat.parseProjected(projected, state);
  },
};

const headerClaudeFormat: TranscriptUsageFormat<void> = {
  ...claudeUsageFormat,
  selectFields: { ...claudeUsageFormat.selectFields, isSidechain: true },
  parseLine(line, state) {
    let projected: unknown;
    try {
      projected = JSON.parse(line);
    } catch {
      return [];
    }
    return headerClaudeFormat.parseProjected(projected, state);
  },
  parseProjected(projected, state) {
    const record = object(projected);
    if (record.isSidechain === true) return [];
    const usage = object(object(record.message).usage);
    return claudeUsageFormat.parseProjected(projected, state).map(
      (request) =>
        ({
          ...request,
          headerTurnId: "",
          headerCacheKnown: typeof usage.cache_read_input_tokens === "number",
        }) satisfies HeaderRequest,
    );
  },
};

export interface HeaderTurnRef {
  readonly threadId: string;
  readonly providerInstanceId: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export function aggregateHeaderRequests(
  requests: readonly HeaderRequest[],
  refs: readonly HeaderTurnRef[],
  threadId?: string,
  partial = false,
  providerInstanceId?: string,
  lookupTiming: (request: HeaderRequest) => HeaderStreamSample | null = (request) =>
    headerUsageTiming.lookup(request),
  lookupRequestTiming: (request: HeaderRequest) => HeaderStreamSample | null = (request) =>
    headerUsageRequestTiming.lookup(request),
  nowMs = Date.now(),
  timeZone?: string,
): HeaderUsageCounters {
  const sessions = new Map<string, Map<string, HeaderTurnRef>>();
  const turns = new Map<string, Map<string, HeaderTurnRef>>();
  for (const ref of refs) {
    const identity = ref.providerInstanceId + "\0" + ref.threadId;
    const owners = sessions.get(ref.sessionId) ?? new Map<string, HeaderTurnRef>();
    owners.set(identity, ref);
    sessions.set(ref.sessionId, owners);
    const turnOwners =
      turns.get(ref.sessionId + "\0" + ref.turnId) ?? new Map<string, HeaderTurnRef>();
    turnOwners.set(identity, ref);
    turns.set(ref.sessionId + "\0" + ref.turnId, turnOwners);
  }
  const selected: HeaderRequest[] = [];
  for (const request of requests) {
    const owners = request.headerTurnId
      ? turns.get(request.sessionId + "\0" + request.headerTurnId)
      : sessions.get(request.sessionId);
    if (!owners || owners.size !== 1) {
      partial = true;
      continue;
    }
    const owner = owners.values().next().value!;
    if (
      (threadId && owner.threadId !== threadId) ||
      (providerInstanceId && owner.providerInstanceId !== providerInstanceId)
    )
      continue;
    if (!request.headerTurnId) partial = true;
    selected.push(request);
  }
  selected.sort((a, b) => a.timestampMs - b.timestampMs);
  // Use the server's local calendar day by default; an explicit zone keeps
  // tests and callers deterministic without changing the wire contract.
  let dayFormatter: Intl.DateTimeFormat;
  try {
    dayFormatter = new Intl.DateTimeFormat("en-CA", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    dayFormatter = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const today = dayFormatter.format(new Date(nowMs));
  const todayRecords = selected.filter(
    (request) => dayFormatter.format(new Date(request.timestampMs)) === today,
  );
  const rate = (records: readonly HeaderRequest[]) => {
    if (!records.length || records.some((record) => !record.headerCacheKnown)) return null;
    const input = records.reduce(
      (sum, record) =>
        sum +
        record.totals.uncachedInputTokens +
        record.totals.cachedInputTokens +
        record.totals.cacheCreationTokens,
      0,
    );
    return input > 0
      ? records.reduce((sum, record) => sum + record.totals.cachedInputTokens, 0) / input
      : null;
  };
  const recent = selected.slice(-5);
  // Tool-only or unmeasurable requests must not evict valid speed history.
  // Cache statistics retain their independent five-request window.
  const measured: { request: HeaderRequest; sample: HeaderStreamSample }[] = [];
  for (let index = selected.length - 1; index >= 0 && measured.length < 5; index--) {
    const request = selected[index]!;
    const sample = lookupTiming(request);
    if (sample) measured.push({ request, sample });
  }
  const latest = measured[0];
  const estimated: { request: HeaderRequest; sample: HeaderStreamSample }[] = [];
  for (let index = selected.length - 1; index >= 0 && estimated.length < 5; index--) {
    const request = selected[index]!;
    const sample = lookupRequestTiming(request);
    if (sample) estimated.push({ request, sample });
  }
  const latestEstimate = estimated[0];
  return {
    tokens: selected.length
      ? selected.reduce((sum, record) => sum + totalTokens(record.totals), 0)
      : null,
    todayTokens: selected.length
      ? todayRecords.reduce((sum, record) => sum + totalTokens(record.totals), 0)
      : null,
    cacheRate: rate(selected),
    // Report the latest verifiable mapped samples. Unrelated missing history
    // keeps the partial marker, but must not erase known recent cache values.
    recentRate: rate(recent),
    lastRate: rate(selected.slice(-1)),
    recentSpeed: measured.length
      ? measured.reduce((sum, { sample }) => sum + sample.tokens, 0) /
        measured.reduce((sum, { sample }) => sum + sample.seconds, 0)
      : null,
    lastSpeed: latest ? latest.sample.tokens / latest.sample.seconds : null,
    requestSpeed: {
      recent: estimated.length
        ? estimated.reduce((sum, { sample }) => sum + sample.tokens, 0) /
          estimated.reduce((sum, { sample }) => sum + sample.seconds, 0)
        : null,
      last: latestEstimate ? latestEstimate.sample.tokens / latestEstimate.sample.seconds : null,
      sampleAt: latestEstimate
        ? DateTime.formatIso(DateTime.makeUnsafe(latestEstimate.request.timestampMs))
        : null,
      stale: Boolean(latestEstimate && latestEstimate.request !== selected.at(-1)),
    },
    speedSamples: measured.length,
    speedSampleAt: latest
      ? DateTime.formatIso(DateTime.makeUnsafe(latest.request.timestampMs))
      : null,
    speedStale: Boolean(latest && latest.request !== selected.at(-1)),
    recentRequestSamples: recent.toReversed().map((request) => {
      const sample = lookupTiming(request);
      const estimate = lookupRequestTiming(request);
      return {
        timestamp: DateTime.formatIso(DateTime.makeUnsafe(request.timestampMs)),
        totalTokens: totalTokens(request.totals),
        cacheRate: rate([request]),
        tokensPerSecond: sample ? sample.tokens / sample.seconds : null,
        ...(estimate ? { estimatedTokensPerSecond: estimate.tokens / estimate.seconds } : {}),
      };
    }),
    recentCacheSamples: recent.toReversed().map((request) => ({
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(request.timestampMs)),
      inputTokens:
        request.totals.uncachedInputTokens +
        request.totals.cachedInputTokens +
        request.totals.cacheCreationTokens,
      cachedInputTokens: request.headerCacheKnown ? request.totals.cachedInputTokens : null,
      cacheRate: rate([request]),
    })),
    recentSpeedSamples: measured.map(({ request, sample }) => ({
      timestamp: DateTime.formatIso(DateTime.makeUnsafe(request.timestampMs)),
      outputTokens: sample.tokens,
      seconds: sample.seconds,
      tokensPerSecond: sample.tokens / sample.seconds,
    })),
    recentSamples: recent.length,
    partial: partial || selected.some((record) => !record.headerCacheKnown),
  };
}

export class HeaderTranscriptCache {
  private readonly files = new Map<
    string,
    {
      size: number;
      mtime: number;
      records: readonly HeaderRequest[];
      position: TranscriptParsePosition;
      malformed: number;
    }
  >();

  private readonly kind: "codex" | "claude";

  constructor(kind: "codex" | "claude" = "codex") {
    this.kind = kind;
  }

  async scan(directories: readonly string[], sessionIds: ReadonlySet<string>) {
    const candidates = await Promise.all(directories.map((dir) => listTranscriptFiles(dir, 0)));
    let partial = candidates.some((candidate, index) => index === 0 && candidate.failedPaths > 0);
    const found = new Set<string>();
    const records: HeaderRequest[] = [];
    // Cross-file copies preserve request order. Occurrence numbers keep equal legitimate requests.
    const seen = new Map<string, number>();
    for (const file of candidates.flatMap((candidate) => candidate.files)) {
      if (
        ![...sessionIds].some((id) =>
          this.kind === "claude"
            ? file.path.replaceAll("\\", "/").endsWith(`/${id}.jsonl`)
            : file.path.includes(id),
        )
      )
        continue;
      let cached = this.files.get(file.path);
      if (!cached || cached.size !== file.size || cached.mtime !== file.mtimeMs) {
        const position = cached && file.size > cached.size ? cached.position : undefined;
        const parsed =
          this.kind === "claude"
            ? await readTranscriptRecords(file.path, headerClaudeFormat, position)
            : await readTranscriptRecords(file.path, headerCodexFormat, position);
        if (!parsed) {
          partial = true;
          if (!cached) continue;
        } else
          cached = {
            size: file.size,
            mtime: file.mtimeMs,
            records: [
              ...(parsed.resumed ? (cached?.records ?? []) : []),
              ...parsed.records,
            ] as HeaderRequest[],
            position: parsed.position,
            malformed: parsed.malformedRecords,
          };
        // A partial last line is reread on the next scan and is not committed or billed yet.
        this.files.set(file.path, cached);
      }
      partial ||= cached.malformed > 0;
      const occurrences = new Map<string, number>();
      for (const record of cached.records) {
        if (!sessionIds.has(record.sessionId)) continue;
        found.add(record.sessionId);
        const key =
          record.dedupeKey ??
          JSON.stringify([
            record.sessionId,
            record.timestampMs,
            record.headerTurnId,
            record.model,
            record.totals,
          ]);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        const identity =
          record.dedupeKey === null
            ? key + ":" + occurrence
            : JSON.stringify([record.sessionId, record.dedupeKey]);
        const previous = seen.get(identity);
        if (previous === undefined) {
          seen.set(identity, records.length);
          records.push(record);
        } else if (record.dedupeKey !== null) {
          const held = records[previous]!;
          records[previous] = {
            ...held,
            ...mergeUsageCopies(held, record),
            headerCacheKnown: held.headerCacheKnown || record.headerCacheKnown,
          };
        }
      }
    }
    const paths = new Set(
      candidates.flatMap((candidate) => candidate.files.map((file) => file.path)),
    );
    for (const file of this.files.keys()) if (!paths.has(file)) this.files.delete(file);
    for (const sessionId of sessionIds) if (!found.has(sessionId)) partial = true;
    return { records, partial };
  }
}
