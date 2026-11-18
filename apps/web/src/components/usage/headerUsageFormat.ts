import type { HeaderUsageCounters } from "@t3tools/contracts";

export function formatUsageTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0";
  if (value < 1000) return Math.round(value).toString();
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ] as const;
  const [divisor, suffix] =
    value >= 100000 && value < 999950000
      ? units[2]
      : (units.find(([unit]) => Math.round((value / unit) * 10) / 10 >= 1) ?? units[3]);
  return (value / divisor).toFixed(1) + suffix;
}

export function formatUsageSpeed(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  return value.toFixed(1);
}

export function isLowCacheRate(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 0.9;
}

export function formatUsageRate(value: number | null | undefined): string {
  if (isLowCacheRate(value) && (value! * 100).toFixed(1) === "90.0") return "<90.0%";
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? `${(value * 100).toFixed(1)}%`
    : "—";
}

export function formatUsageMoney(
  value: number | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const unit = currency === "USD" ? "$" : currency === "CNY" ? "¥" : (currency ?? "");
  const amount =
    Math.abs(value) >= 10000 ? formatUsageTokens(Math.abs(value)) : Math.abs(value).toFixed(2);
  return `${value < 0 ? "−" : ""}${unit}${amount}`;
}

export function isUsageDataExpired(
  readAt: string | null | undefined,
  maxAgeMs: number,
  stale: boolean,
  now: number,
): boolean {
  if (!readAt) return false;
  const timestamp = Date.parse(readAt);
  return stale || !Number.isFinite(timestamp) || now >= timestamp + maxAgeMs;
}

/** Keep strict text throughput and estimated request throughput in separate windows. */
export function selectUsageSpeed(local: HeaderUsageCounters | undefined) {
  const request = local?.requestSpeed;
  const requestAt = request?.sampleAt ? Date.parse(request.sampleAt) : NaN;
  const strictAt = local?.speedSampleAt ? Date.parse(local.speedSampleAt) : NaN;
  const estimated = Boolean(
    request &&
    Number.isFinite(requestAt) &&
    (request.recent != null || request.last != null) &&
    (local?.speedStale || local?.lastSpeed == null || local?.recentSpeed == null) &&
    (!Number.isFinite(strictAt) || requestAt > strictAt),
  );
  return {
    estimated,
    recent: estimated ? request?.recent : local?.recentSpeed,
    last: estimated ? request?.last : local?.lastSpeed,
    sampleAt: estimated ? request?.sampleAt : local?.speedSampleAt,
    stale: estimated ? request?.stale : local?.speedStale,
  };
}

export function formatUsageRequestSpeed(
  measured: number | null | undefined,
  estimated: number | null | undefined,
): string {
  const strict = formatUsageSpeed(measured);
  if (strict !== "—") return strict;
  const fallback = formatUsageSpeed(estimated);
  return fallback === "—" ? fallback : `≈${fallback}`;
}
