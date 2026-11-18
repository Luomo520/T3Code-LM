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
