import type { HeaderUsageSummary } from "@t3tools/contracts";
import { formatUsageRate, formatUsageRequestSpeed } from "./headerUsageFormat";
import type { HistoricalUsageFields, HistoryUsageSummary } from "./headerUsageHistory";
import {
  headerUsageMetrics,
  detailMetricLabels,
  type HeaderUsageMetric,
} from "./headerUsageMetrics";

export interface UsageDetails {
  readonly provider: string;
  readonly source: string | null;
  readonly notice: string | null;
  readonly metrics: readonly HeaderUsageMetric[];
  readonly rows: readonly {
    readonly timestamp: string;
    readonly tokens: string;
    readonly cache: string;
    readonly speed: string;
  }[];
  readonly emptyText: string;
}

function marked(value: string, historical: boolean): string {
  return value === formatUsageRate(null) || !historical ? value : `${value}*`;
}

export function usageDetails(
  data: HeaderUsageSummary | HistoryUsageSummary | null,
  home: boolean,
  error: string | null,
  history: HistoricalUsageFields = {},
  now = Date.now(),
): UsageDetails {
  const local = home ? data?.allConversations : data?.conversation;
  const account = data?.account as HistoryUsageSummary["account"] | undefined;
  const historical = Boolean(history.recentRequestSamples);
  return {
    provider: data?.providerLabel ?? "统计尚不可用",
    source: account?.sourceLabel ?? null,
    notice: error ? "暂未更新，保留上次记录。" : null,
    metrics: headerUsageMetrics(data, home, now, history).map((item) => ({
      ...item,
      label: detailMetricLabels[item.label] ?? item.label,
    })),
    rows: (local?.recentRequestSamples ?? []).slice(0, 5).map((sample) => ({
      timestamp: sample.timestamp,
      tokens: marked(sample.totalTokens.toLocaleString(), historical),
      cache: marked(formatUsageRate(sample.cacheRate), historical),
      speed: marked(
        formatUsageRequestSpeed(sample.tokensPerSecond, sample.estimatedTokensPerSecond),
        historical,
      ),
    })),
    emptyText: !data
      ? "请连接配套后台。"
      : local?.recentRequestSamples === undefined
        ? "更新后台以查看逐次统计。"
        : "暂无请求记录。",
  };
}
