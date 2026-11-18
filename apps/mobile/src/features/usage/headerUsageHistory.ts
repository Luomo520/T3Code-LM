import { HeaderUsageCounters, HeaderUsageSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { HeaderUsageTargetConfig } from "./headerUsageTarget";

const accountFields = ["balance", "totalTokens", "todayCost"] as const;
const localFields = [
  "tokens",
  "todayTokens",
  "cacheRate",
  "recentRate",
  "lastRate",
  "recentSpeed",
  "lastSpeed",
] as const;
const sampleFields = ["recentCacheSamples", "recentSpeedSamples", "recentRequestSamples"] as const;
export type HistoricalUsageField =
  | (typeof accountFields)[number]
  | (typeof localFields)[number]
  | (typeof sampleFields)[number];
export type HistoricalUsageFields = Readonly<Partial<Record<HistoricalUsageField, string>>>;

// Optional on newer backends; no credential or query configuration enters this cache.
type UsageAccount = HeaderUsageSummary["account"] & {
  readonly sourceId?: string | null;
  readonly sourceLabel?: string | null;
};
export type HistoryUsageSummary = Omit<HeaderUsageSummary, "account"> & {
  readonly account: UsageAccount;
};

const Dates = Schema.Record(Schema.String, Schema.String);
export const AccountUsageHistory = Schema.Struct({
  currentSourceId: Schema.NullOr(Schema.String),
  sourceReadAt: Schema.NullOr(Schema.String),
  entries: Schema.Array(
    Schema.Struct({
      sourceId: Schema.NullOr(Schema.String),
      sourceLabel: Schema.NullOr(Schema.String),
      values: HeaderUsageSummary.fields.account,
      dates: Dates,
    }),
  ),
});
export const LocalUsageHistory = Schema.Struct({
  values: HeaderUsageCounters,
  readAt: Schema.NullOr(Schema.String),
  dates: Dates,
});

export interface HeaderUsageHistory {
  readonly account: typeof AccountUsageHistory.Type;
  readonly local: typeof LocalUsageHistory.Type | null;
}

export function emptyHeaderUsageHistory(): HeaderUsageHistory {
  return { account: { currentSourceId: null, sourceReadAt: null, entries: [] }, local: null };
}

export function resolveHeaderUsageHistoryProvider(
  _config: HeaderUsageTargetConfig | undefined,
  requested?: string,
  confirmed?: string | null,
): string | undefined {
  // Explicit route identity is safe offline. Auto is resolved only by a backend response/alias.
  return requested ?? confirmed ?? undefined;
}

function validTime(value: string | null | undefined): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function accepts(
  value: number | null | undefined,
  at: string | null | undefined,
  previous?: string,
) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    validTime(at) &&
    (!validTime(previous) || Date.parse(at) >= Date.parse(previous))
  );
}

function latest(dates: Readonly<Record<string, string>>): string | null {
  return Object.values(dates)
    .filter(validTime)
    .reduce<string | null>(
      (last, at) => (!last || Date.parse(at) > Date.parse(last) ? at : last),
      null,
    );
}

function emptyAccount(): HeaderUsageSummary["account"] {
  return {
    balance: null,
    balanceKind: "unknown",
    currency: null,
    totalTokens: null,
    todayCost: null,
    readAt: null,
    stale: false,
    message: "",
    refreshSeconds: 60,
  };
}

function emptyCounters(): HeaderUsageCounters {
  return { tokens: null, cacheRate: null, recentRate: null, recentSamples: 0, partial: false };
}

function mergeAccount(
  history: HeaderUsageHistory["account"],
  incoming: UsageAccount,
  responseAt: string,
) {
  if (
    validTime(history.sourceReadAt) &&
    (!validTime(responseAt) || Date.parse(responseAt) < Date.parse(history.sourceReadAt))
  )
    return history;
  // A live legacy response belongs to its own bucket, never the last CC account.
  const sourceId = incoming.sourceId ?? null;
  const previous = history.entries.find((entry) => entry.sourceId === sourceId);
  const values = { ...(previous?.values ?? emptyAccount()) };
  const dates = { ...previous?.dates };
  let accepted = false;
  for (const field of accountFields) {
    if (!accepts(incoming[field], incoming.readAt, dates[field])) continue;
    values[field] = incoming[field]!;
    dates[field] = incoming.readAt!;
    accepted = true;
  }
  if (accepted) {
    values.balanceKind =
      incoming.balanceKind === "unknown" ? values.balanceKind : incoming.balanceKind;
    values.currency = incoming.currency ?? values.currency;
    values.refreshSeconds = incoming.refreshSeconds;
    values.stale = incoming.stale;
    values.readAt = latest(dates);
  }
  const entry = {
    sourceId,
    sourceLabel: incoming.sourceLabel ?? previous?.sourceLabel ?? null,
    values,
    dates,
  };
  return {
    currentSourceId: sourceId,
    // Every accepted confirmation advances the source watermark, independently of
    // the account values' original sample times. Older confirmations return above.
    sourceReadAt: validTime(responseAt) ? responseAt : history.sourceReadAt,
    entries: [entry, ...history.entries.filter((item) => item.sourceId !== sourceId)].slice(0, 8),
  };
}

function localTime(
  local: HeaderUsageCounters,
  readAt: string | null,
  field: (typeof localFields)[number],
) {
  return field === "recentSpeed" || field === "lastSpeed"
    ? (local.speedSampleAt ?? readAt)
    : readAt;
}

function mergeLocal(
  previous: HeaderUsageHistory["local"],
  incoming: HeaderUsageCounters,
  readAt: string | null,
) {
  const values = { ...(previous?.values ?? emptyCounters()) };
  const dates = { ...previous?.dates };
  let accepted = false;
  for (const field of localFields) {
    const at = localTime(incoming, readAt, field);
    if (!validTime(readAt) || !accepts(incoming[field], at, dates[field])) continue;
    values[field] = incoming[field]!;
    dates[field] = at!;
    accepted = true;
    if (field === "recentRate") {
      values.recentSamples = incoming.recentSamples;
    }
    if (field === "recentSpeed") {
      if (incoming.speedSamples !== undefined) values.speedSamples = incoming.speedSamples;
      if (incoming.speedSampleAt !== undefined) values.speedSampleAt = incoming.speedSampleAt;
      if (incoming.speedStale !== undefined) values.speedStale = incoming.speedStale;
    }
  }
  if (validTime(readAt)) {
    if (
      incoming.recentRequestSamples?.length === 0 &&
      !previous?.values.recentRequestSamples?.length
    ) {
      values.recentRequestSamples = [];
      accepted = true;
    }
    if (
      accepts(
        incoming.recentRequestSamples?.length || undefined,
        readAt,
        dates.recentRequestSamples,
      )
    ) {
      values.recentRequestSamples = incoming.recentRequestSamples!.slice(0, 5).map((sample) => ({
        timestamp: sample.timestamp,
        totalTokens: sample.totalTokens,
        cacheRate: sample.cacheRate,
        tokensPerSecond: sample.tokensPerSecond,
        ...(sample.estimatedTokensPerSecond !== undefined
          ? { estimatedTokensPerSecond: sample.estimatedTokensPerSecond }
          : {}),
      }));
      dates.recentRequestSamples = readAt;
      accepted = true;
    }
    if (incoming.recentCacheSamples?.length === 0 && !previous?.values.recentCacheSamples?.length) {
      values.recentCacheSamples = [];
      accepted = true;
    }
    if (incoming.recentSpeedSamples?.length === 0 && !previous?.values.recentSpeedSamples?.length) {
      values.recentSpeedSamples = [];
      accepted = true;
    }
    const cacheAt = incoming.recentCacheSamples?.length ? readAt : null;
    if (accepts(incoming.recentCacheSamples?.length, cacheAt, dates.recentCacheSamples)) {
      values.recentCacheSamples = incoming.recentCacheSamples!.slice(0, 5).map((sample) => ({
        timestamp: sample.timestamp,
        inputTokens: sample.inputTokens,
        cachedInputTokens: sample.cachedInputTokens,
        cacheRate: sample.cacheRate,
      }));
      dates.recentCacheSamples = cacheAt!;
      accepted = true;
    }
    const speedAt = incoming.recentSpeedSamples?.length
      ? (incoming.speedSampleAt ?? incoming.recentSpeedSamples[0]!.timestamp)
      : null;
    if (accepts(incoming.recentSpeedSamples?.length, speedAt, dates.recentSpeedSamples)) {
      values.recentSpeedSamples = incoming.recentSpeedSamples!.slice(0, 5).map((sample) => ({
        timestamp: sample.timestamp,
        outputTokens: sample.outputTokens,
        seconds: sample.seconds,
        tokensPerSecond: sample.tokensPerSecond,
      }));
      dates.recentSpeedSamples = speedAt!;
      accepted = true;
    }
  }
  if (!accepted) return previous;
  values.partial = incoming.partial;
  return {
    values,
    dates,
    readAt:
      previous?.readAt && Date.parse(previous.readAt) > Date.parse(readAt!)
        ? previous.readAt
        : readAt,
  };
}

export function mergeHeaderUsageHistory(
  history: HeaderUsageHistory,
  incoming: HistoryUsageSummary | null,
  home: boolean,
): HeaderUsageHistory {
  if (!incoming) return history;
  return {
    account: mergeAccount(history.account, incoming.account, incoming.readAt),
    local: mergeLocal(
      history.local,
      home ? incoming.allConversations : incoming.conversation,
      incoming.localReadAt,
    ),
  };
}

export function presentHeaderUsageHistory(
  history: HeaderUsageHistory,
  incoming: HistoryUsageSummary | null,
  providerInstanceId: string,
  providerLabel: string,
  home: boolean,
  error: string | null = null,
): { readonly data: HistoryUsageSummary | null; readonly historicalFields: HistoricalUsageFields } {
  const live = incoming?.providerInstanceId === providerInstanceId ? incoming : null;
  const merged = mergeHeaderUsageHistory(history, live, home);
  const account = merged.account.entries.find(
    (entry) => entry.sourceId === merged.account.currentSourceId,
  );
  const liveAccount =
    live && (live.account.sourceId ?? null) !== merged.account.currentSourceId
      ? null
      : live?.account;
  const local = merged.local;
  if (!account && !local && !live) return { data: null, historicalFields: {} };
  const historicalFields: Partial<Record<HistoricalUsageField, string>> = {};
  for (const field of accountFields) {
    const at = account?.dates[field];
    if (at && (!liveAccount || error || !accepts(liveAccount[field], liveAccount.readAt, at)))
      historicalFields[field] = at;
  }
  const liveLocal = home ? live?.allConversations : live?.conversation;
  for (const field of localFields) {
    const at = local?.dates[field];
    if (
      at &&
      (!liveLocal ||
        error ||
        !validTime(live?.localReadAt) ||
        !accepts(liveLocal[field], localTime(liveLocal, live!.localReadAt, field), at))
    )
      historicalFields[field] = at;
  }
  for (const field of sampleFields) {
    const at = local?.dates[field];
    const liveAt =
      field === "recentSpeedSamples"
        ? (liveLocal?.speedSampleAt ?? liveLocal?.recentSpeedSamples?.[0]?.timestamp)
        : live?.localReadAt;
    if (
      at &&
      (!liveLocal ||
        error ||
        !validTime(live?.localReadAt) ||
        !accepts(liveLocal[field]?.length || undefined, liveAt, at))
    )
      historicalFields[field] = at;
  }
  // Request-speed estimates remain live-only; request rows retain their estimate marker on disk.
  const values = {
    ...(local?.values ?? emptyCounters()),
    ...(liveLocal?.requestSpeed &&
    validTime(live?.localReadAt) &&
    (!validTime(local?.readAt) || Date.parse(live.localReadAt) >= Date.parse(local.readAt))
      ? { requestSpeed: liveLocal.requestSpeed }
      : {}),
  };
  return {
    data: {
      providerInstanceId,
      providerLabel: providerLabel || providerInstanceId,
      readAt: live?.readAt ?? local?.readAt ?? account?.values.readAt ?? "",
      localReadAt: local?.readAt ?? null,
      localRefreshing: live?.localRefreshing ?? false,
      account: {
        ...(account?.values ?? emptyAccount()),
        ...(account?.sourceId ? { sourceId: account.sourceId } : {}),
        ...(account?.sourceLabel ? { sourceLabel: account.sourceLabel } : {}),
        stale: Boolean(liveAccount?.stale ?? account?.values.stale),
        message: liveAccount?.message ?? "",
      },
      conversation: home ? emptyCounters() : values,
      allConversations: home ? values : emptyCounters(),
    },
    historicalFields,
  };
}
