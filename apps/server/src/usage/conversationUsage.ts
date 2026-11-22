import {
  RunId,
  TurnTokenUsage,
  type ConversationUsage,
  type ConversationUsageTurn,
  type UsageCategoryCost,
} from "@t3tools/contracts";
import { totalTokens, type UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type { HeaderRequest, HeaderTurnRef } from "./headerUsageScan.ts";
import type { HeaderStreamSample } from "./headerUsageTiming.ts";
import { priceUsage, type RateTable } from "./usagePricing.ts";

export interface ConversationUsageRow {
  readonly run_id: string;
  readonly instance_id: string;
  readonly native_session: string | null;
  readonly native_turn: string | null;
  readonly turn_usage: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly model: string | null;
}

export const readConversationUsageRows = Effect.fn("ConversationUsage.readRows")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ConversationUsageRow>`SELECT r.run_id,
    p.provider_instance_id AS instance_id,
    COALESCE(json_extract(a.payload_json, '$.nativeThreadId'), json_extract(p.payload_json, '$.nativeThreadRef.nativeId')) AS native_session,
    json_extract(t.payload_json, '$.nativeTurnRef.nativeId') AS native_turn,
    json_extract(t.payload_json, '$.turnTokenUsage') AS turn_usage,
    t.started_at, t.completed_at,
    COALESCE(json_extract(t.payload_json, '$.model'), json_extract(r.payload_json, '$.modelSelection.model')) AS model
    FROM orchestration_v2_projection_provider_turns t
    JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id
    LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id AND a.thread_id = t.thread_id
    LEFT JOIN orchestration_v2_projection_nodes n ON a.run_id IS NULL AND n.node_id = t.node_id AND n.thread_id = t.thread_id
    JOIN orchestration_v2_projection_runs r ON r.run_id = COALESCE(a.run_id, n.run_id) AND r.thread_id = t.thread_id
    WHERE t.thread_id = ${threadId}
    ORDER BY r.ordinal, a.attempt_ordinal, t.ordinal`.pipe(NodeSqliteClient.readOnly);
});

const decodeUsage = Schema.decodeUnknownOption(Schema.fromJsonString(TurnTokenUsage));
const emptyCosts = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const emptySpeed = () => ({ tokens: 0, seconds: 0 });
const EMPTY_RATE_TABLE: RateTable = new Map();
const turnKey = (instance: string, session: string, turn: string) =>
  JSON.stringify([instance, session, turn]);

type RequestCost = Pick<
  UsageRecord,
  "model" | "totals" | "reportedCostUsd" | "speed" | "cacheCreation1hTokens" | "rateModel"
>;

function projectedRequest(
  usage: TurnTokenUsage | undefined,
  model: string | null,
): RequestCost | null {
  if (usage === undefined || usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return null;
  }
  const cachedInputTokens = usage.cachedInputTokens ?? 0;
  const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
  return {
    model: (usage.models?.length ?? 0) > 1 ? "" : (usage.models?.[0] ?? model ?? ""),
    totals: {
      uncachedInputTokens: Math.max(0, usage.inputTokens - cachedInputTokens - cacheCreationTokens),
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
    },
    reportedCostUsd: null,
    speed: "standard",
  };
}

interface RunUsage {
  tokens: number | null;
  cost: number | null;
  costPartial: boolean;
  cacheInput: number;
  cacheRead: number;
  cacheIncomplete: boolean;
  speed: ReturnType<typeof emptySpeed>;
  estimatedSpeed: ReturnType<typeof emptySpeed>;
}

function addSpeed(total: ReturnType<typeof emptySpeed>, sample: HeaderStreamSample | null) {
  if (sample !== null && sample.seconds > 0) {
    total.tokens += sample.tokens;
    total.seconds += sample.seconds;
  }
}

function addCategories(total: ReturnType<typeof emptyCosts>, cost: UsageCategoryCost) {
  total.input += cost.input;
  total.output += cost.output;
  total.cacheRead += cost.cacheRead;
  total.cacheWrite += cost.cacheWrite;
}

export function aggregateConversationUsage(input: {
  readonly threadId: string;
  readonly rows: readonly ConversationUsageRow[];
  readonly refs: readonly HeaderTurnRef[];
  readonly claudeSessions?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly recordsByInstance: ReadonlyMap<string, readonly HeaderRequest[]>;
  readonly rates: RateTable;
  readonly textTiming: (request: HeaderRequest) => HeaderStreamSample | null;
  readonly requestTiming: (request: HeaderRequest) => HeaderStreamSample | null;
}): ConversationUsage {
  const ownersByTurn = new Map<string, Set<string>>();
  for (const ref of input.refs) {
    const key = turnKey(ref.providerInstanceId, ref.sessionId, ref.turnId);
    const owners = ownersByTurn.get(key) ?? new Set<string>();
    owners.add(ref.threadId);
    ownersByTurn.set(key, owners);
  }
  const requests = new Map<string, HeaderRequest[]>();
  const claudeRequests = new Map<ConversationUsageRow, HeaderRequest[]>();
  const claudeIntervals = new Map<
    string,
    { row: ConversationUsageRow; start: number; end: number }[]
  >();
  for (const row of input.rows) {
    if (
      row.native_session === null ||
      !row.started_at ||
      !row.completed_at ||
      !input.claudeSessions?.get(row.instance_id)?.has(row.native_session)
    )
      continue;
    const key = row.native_session;
    const intervals = claudeIntervals.get(key) ?? [];
    intervals.push({
      row,
      start: Date.parse(row.started_at),
      end: Date.parse(row.completed_at),
    });
    claudeIntervals.set(key, intervals);
  }
  for (const [instanceId, records] of input.recordsByInstance) {
    for (const request of records) {
      if (request.provider === "claude") {
        const intervals = claudeIntervals.get(request.sessionId);
        if (intervals === undefined) continue;
        const owners = intervals.filter(
          ({ start, end }) => request.timestampMs >= start && request.timestampMs <= end,
        );
        if (owners.length !== 1) continue;
        const { row } = owners[0]!;
        if (row.instance_id !== instanceId) continue;
        const batch = claudeRequests.get(row) ?? [];
        batch.push(request);
        claudeRequests.set(row, batch);
        continue;
      }
      if (!request.headerTurnId) continue;
      const key = turnKey(instanceId, request.sessionId, request.headerTurnId);
      const owners = ownersByTurn.get(key);
      if (owners?.size !== 1 || !owners.has(input.threadId)) continue;
      const batch = requests.get(key) ?? [];
      batch.push(request);
      requests.set(key, batch);
    }
  }

  const runs = new Map<string, RunUsage>();
  const categories = emptyCosts();
  let hasCategories = false;
  const assignedTurns = new Set<string>();
  for (const row of input.rows) {
    const run = runs.get(row.run_id) ?? {
      tokens: null,
      cost: null,
      costPartial: false,
      cacheInput: 0,
      cacheRead: 0,
      cacheIncomplete: false,
      speed: emptySpeed(),
      estimatedSpeed: emptySpeed(),
    };
    runs.set(row.run_id, run);

    const key =
      row.native_session && row.native_turn
        ? turnKey(row.instance_id, row.native_session, row.native_turn)
        : null;
    if (key !== null && assignedTurns.has(key)) continue;
    if (key !== null) assignedTurns.add(key);

    const saved = row.turn_usage === null ? undefined : decodeUsage(row.turn_usage);
    const ledger = saved?._tag === "Some" ? saved.value : undefined;
    if (ledger?.localCommand === true) continue;

    const turnRequests = claudeRequests.get(row) ?? (key === null ? [] : (requests.get(key) ?? []));
    const projected = projectedRequest(ledger, row.model);
    const projectedTokens =
      projected !== null
        ? totalTokens(projected.totals) +
          (ledger?.otherUsage?.inputTokens ?? 0) +
          (ledger?.otherUsage?.outputTokens ?? 0)
        : null;
    const hasOtherUsage =
      (ledger?.otherUsage?.inputTokens ?? 0) + (ledger?.otherUsage?.outputTokens ?? 0) > 0;
    const requestTokens =
      turnRequests.length > 0
        ? turnRequests.reduce((sum, request) => sum + totalTokens(request.totals), 0)
        : null;
    // 请求明细和账本可能覆盖同一批调用，取两者较大值可避免重复计数。
    const knownTokens =
      requestTokens !== null || projectedTokens !== null
        ? Math.max(requestTokens ?? 0, projectedTokens ?? 0)
        : null;
    if (knownTokens !== null) run.tokens = (run.tokens ?? 0) + knownTokens;
    for (const request of turnRequests) {
      if (request.provider !== "codex") continue;
      addSpeed(run.speed, input.textTiming(request));
      addSpeed(run.estimatedSpeed, input.requestTiming(request));
    }

    const billable = turnRequests.length > 0 ? turnRequests : projected === null ? [] : [projected];
    if (
      (billable.length === 0 && knownTokens !== 0) ||
      (requestTokens !== null && projectedTokens !== null && requestTokens < projectedTokens) ||
      (turnRequests.length === 0 && (ledger?.usageStatus !== "complete" || hasOtherUsage))
    ) {
      run.costPartial = true;
    }
    if (
      (requestTokens !== null && projectedTokens !== null && requestTokens < projectedTokens) ||
      (turnRequests.length === 0 && ledger?.cachedInputTokens === undefined) ||
      turnRequests.some((request) => !request.headerCacheKnown)
    ) {
      run.cacheIncomplete = true;
    }

    for (const request of billable) {
      run.cacheInput +=
        request.totals.uncachedInputTokens +
        request.totals.cachedInputTokens +
        request.totals.cacheCreationTokens;
      run.cacheRead += request.totals.cachedInputTokens;
      if (totalTokens(request.totals) === 0 && request.reportedCostUsd === null) continue;
      const cacheKnown =
        "headerCacheKnown" in request
          ? request.headerCacheKnown === true
          : ledger?.cachedInputTokens !== undefined;
      const configuredRate = input.rates.get(request.model.trim());
      const splitUnknown =
        !cacheKnown &&
        request.totals.uncachedInputTokens > 0 &&
        configuredRate !== undefined &&
        configuredRate.inputCostPerToken !== configuredRate.cacheReadCostPerToken;
      const priced = priceUsage(EMPTY_RATE_TABLE, request, splitUnknown ? undefined : input.rates, {
        preferProviderReport: true,
      });
      if (priced.costSource === "unpriced") {
        run.costPartial = true;
        continue;
      }
      run.cost = (run.cost ?? 0) + priced.costUsd;
      if (priced.categoryCostUsd !== null) {
        addCategories(categories, priced.categoryCostUsd);
        hasCategories = true;
      }
    }
  }

  let tokens: number | null = null;
  let costUsd: number | null = null;
  let costPartial = false;
  const turns: ConversationUsageTurn[] = [];
  for (const [runId, run] of runs) {
    if (run.tokens !== null) tokens = (tokens ?? 0) + run.tokens;
    if (run.cost !== null) costUsd = (costUsd ?? 0) + run.cost;
    costPartial ||= run.costPartial;
    turns.push({
      runId: RunId.make(runId),
      // 此字段是截至这一轮的会话累计量；本轮缺少记录时保留 null，以免沿用上一轮的数字。
      cumulativeTokens: run.tokens === null ? null : tokens,
      tokensPerSecond: run.speed.seconds > 0 ? run.speed.tokens / run.speed.seconds : null,
      estimatedTokensPerSecond:
        run.estimatedSpeed.seconds > 0
          ? run.estimatedSpeed.tokens / run.estimatedSpeed.seconds
          : null,
      costUsd: run.cost,
      costPartial: run.costPartial,
      cacheRate: run.cacheIncomplete || run.cacheInput <= 0 ? null : run.cacheRead / run.cacheInput,
    });
  }

  return { costUsd, costPartial, categoryCostUsd: hasCategories ? categories : null, turns };
}
