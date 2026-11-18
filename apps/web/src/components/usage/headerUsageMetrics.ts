import type { HeaderUsageSummary } from "@t3tools/contracts";
import {
  formatUsageMoney,
  formatUsageRate,
  formatUsageRequestSpeed,
  selectUsageSpeed,
  formatUsageTokens,
  isLowCacheRate,
  isUsageDataExpired,
} from "./headerUsageFormat";

export interface HeaderUsageMetric {
  readonly label: string;
  readonly value: string;
  readonly lowCache: boolean;
  readonly expired: boolean;
}

export function headerUsageMetrics(
  data: HeaderUsageSummary | null,
  home: boolean,
  now: number,
): HeaderUsageMetric[] {
  const account = data?.account;
  const local = home ? data?.allConversations : data?.conversation;
  const expiredAccount = isUsageDataExpired(
    account?.readAt,
    (account?.refreshSeconds ?? 60) * 1000,
    Boolean(account?.stale),
    now,
  );
  const expiredLocal = isUsageDataExpired(data?.localReadAt, 30_000, false, now);
  const speed = selectUsageSpeed(local);
  const expiredSpeed =
    expiredLocal || Boolean(speed.stale) || isUsageDataExpired(speed.sampleAt, 300_000, false, now);
  const metric = (
    label: string,
    value: string,
    present: boolean,
    expired: boolean,
    lowCache = false,
  ): HeaderUsageMetric => ({ label, value, lowCache, expired: present && expired });
  return [
    metric(
      "余额",
      formatUsageMoney(account?.balance, account?.currency),
      account?.balance != null,
      expiredAccount,
    ),
    metric(
      "用量",
      formatUsageTokens(home ? account?.totalTokens : local?.tokens),
      (home ? account?.totalTokens : local?.tokens) != null,
      home ? expiredAccount : expiredLocal,
    ),
    metric("Day", formatUsageTokens(local?.todayTokens), local?.todayTokens != null, expiredLocal),
    metric(
      "总缓存",
      formatUsageRate(local?.cacheRate),
      local?.cacheRate != null,
      expiredLocal,
      isLowCacheRate(local?.cacheRate),
    ),
    ...(!home
      ? [
          metric(
            "缓存5",
            formatUsageRate(local?.recentRate),
            local?.recentRate != null,
            expiredLocal,
            isLowCacheRate(local?.recentRate),
          ),
          metric(
            "缓存",
            formatUsageRate(local?.lastRate),
            local?.lastRate != null,
            expiredLocal,
            isLowCacheRate(local?.lastRate),
          ),
          metric(
            "t/s5",
            formatUsageRequestSpeed(
              speed.estimated ? null : speed.recent,
              speed.estimated ? speed.recent : null,
            ),
            speed.recent != null,
            expiredSpeed,
          ),
          metric(
            "t/s",
            formatUsageRequestSpeed(
              speed.estimated ? null : speed.last,
              speed.estimated ? speed.last : null,
            ),
            speed.last != null,
            expiredSpeed,
          ),
        ]
      : []),
  ];
}
