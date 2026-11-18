import type { HeaderUsageSummary } from "@t3tools/contracts";
import type { HistoricalUsageFields, HistoryUsageSummary } from "./headerUsageHistory";
import { isUsageDataExpired } from "./headerUsageStatus";
import {
  formatUsageMoney,
  formatUsageRate,
  formatUsageTokens,
  formatUsageRequestSpeed,
  selectUsageSpeed,
  isLowCacheRate,
} from "./headerUsageFormat";

export interface HeaderUsageMetric {
  readonly label: string;
  readonly value: string;
  readonly lowCache: boolean;
  readonly expired: boolean;
}

export const detailMetricLabels: Readonly<Record<string, string>> = {
  余额: "余额",
  用量: "总用量",
  Day: "今日用量",
  总缓存: "总缓存率",
  缓存5: "最近5次缓存率",
  缓存: "本次缓存率",
  "t/s5": "最近5次速度",
  "t/s": "本次速度",
};

export function headerUsageMetrics(
  data: HeaderUsageSummary | HistoryUsageSummary | null,
  home: boolean,
  now: number,
  history: HistoricalUsageFields = {},
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
  const metrics: readonly (readonly [string, string, boolean?, boolean?])[] = [
    [
      "余额",
      formatUsageMoney(account?.balance, account?.currency),
      false,
      Boolean(history.balance) || (expiredAccount && account?.balance != null),
    ],
    [
      "用量",
      formatUsageTokens(home ? account?.totalTokens : local?.tokens),
      false,
      home
        ? Boolean(history.totalTokens) || (expiredAccount && account?.totalTokens != null)
        : Boolean(history.tokens) || (expiredLocal && local?.tokens != null),
    ],
    [
      "Day",
      formatUsageTokens(local?.todayTokens),
      false,
      Boolean(history.todayTokens) || (expiredLocal && local?.todayTokens != null),
    ],
    [
      "总缓存",
      formatUsageRate(local?.cacheRate),
      isLowCacheRate(local?.cacheRate),
      Boolean(history.cacheRate) || (expiredLocal && local?.cacheRate != null),
    ],
    ...(!home
      ? ([
          [
            "缓存5",
            formatUsageRate(local?.recentRate),
            isLowCacheRate(local?.recentRate),
            Boolean(history.recentRate) || (expiredLocal && local?.recentRate != null),
          ],
          [
            "缓存",
            formatUsageRate(local?.lastRate),
            isLowCacheRate(local?.lastRate),
            Boolean(history.lastRate) || (expiredLocal && local?.lastRate != null),
          ],
          [
            "t/s5",
            formatUsageRequestSpeed(
              speed.estimated ? null : speed.recent,
              speed.estimated ? speed.recent : null,
            ),
            false,
            (!speed.estimated && Boolean(history.recentSpeed)) ||
              (expiredSpeed && speed.recent != null),
          ],
          [
            "t/s",
            formatUsageRequestSpeed(
              speed.estimated ? null : speed.last,
              speed.estimated ? speed.last : null,
            ),
            false,
            (!speed.estimated && Boolean(history.lastSpeed)) ||
              (expiredSpeed && speed.last != null),
          ],
        ] as const)
      : []),
  ];
  return metrics.map(([label, value, lowCache = false, expired = false]) => ({
    label,
    value,
    lowCache,
    expired,
  }));
}
