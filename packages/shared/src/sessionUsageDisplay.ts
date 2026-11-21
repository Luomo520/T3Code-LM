import type { ConversationUsage, UsageCategoryCost } from "@t3tools/contracts";
import { formatPercent, formatUsd, UNKNOWN_CONVERSATION_USAGE } from "./usageFormat.ts";

const SESSION_COST_CATEGORIES = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "unallocated",
] as const;

export type SessionCostCategory = (typeof SESSION_COST_CATEGORIES)[number];

export const SESSION_COST_LABELS = {
  input: "输入",
  output: "输出",
  cacheRead: "缓存读取",
  cacheWrite: "缓存写入",
  unallocated: "分类未知",
} satisfies Record<SessionCostCategory, string>;

export const SESSION_COST_COLORS = {
  input: { light: "#2563eb", dark: "#60a5fa" },
  output: { light: "#7c3aed", dark: "#a78bfa" },
  cacheRead: { light: "#0891b2", dark: "#22d3ee" },
  cacheWrite: { light: "#a16207", dark: "#fbbf24" },
  unallocated: { light: "#6b7280", dark: "#9ca3af" },
} satisfies Record<SessionCostCategory, { light: string; dark: string }>;

const preciseUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 6,
});

function costLabel(amount: number | null | undefined, partial: boolean): string {
  if (amount == null) return UNKNOWN_CONVERSATION_USAGE;
  if (amount > 0 && amount < 0.000001) return partial ? "<$0.000001*" : "<$0.000001";
  const formatted = amount > 0 && amount < 0.01 ? preciseUsd.format(amount) : formatUsd(amount);
  return partial ? `${formatted}*` : formatted;
}

function costSegments(amount: number | null, categories: UsageCategoryCost | null) {
  if (amount === null || amount <= 0) return [];
  const known = categories
    ? categories.input + categories.output + categories.cacheRead + categories.cacheWrite
    : 0;
  return SESSION_COST_CATEGORIES.flatMap((category) => {
    const cost =
      category === "unallocated" ? Math.max(0, amount - known) : (categories?.[category] ?? 0);
    return cost > 1e-9 * amount
      ? [{ category, share: cost / amount, label: costLabel(cost, false) }]
      : [];
  });
}

export function sessionUsageDisplay(
  usage: ConversationUsage | null | undefined,
  contextWindow:
    | { readonly usedTokens: number; readonly maxTokens: number | null }
    | null
    | undefined,
) {
  const recent = usage?.turns.at(-1);
  const costPartial = usage?.costUsd != null && usage.costPartial;
  const recentCostPartial = recent?.costUsd != null && recent.costPartial;
  const used = contextWindow?.usedTokens;
  const limit = contextWindow?.maxTokens;
  const contextPercentage =
    used != null &&
    Number.isFinite(used) &&
    used >= 0 &&
    limit != null &&
    Number.isFinite(limit) &&
    limit > 0
      ? Math.min(100, (used / limit) * 100)
      : null;
  return {
    costLabel: costLabel(usage?.costUsd, costPartial),
    costPartial,
    categorySegments: costSegments(usage?.costUsd ?? null, usage?.categoryCostUsd ?? null),
    recentCostLabel: costLabel(recent?.costUsd, recentCostPartial),
    recentCostPartial,
    cacheRateLabel:
      recent?.cacheRate == null ? UNKNOWN_CONVERSATION_USAGE : formatPercent(recent.cacheRate),
    contextPercentage,
    contextLabel:
      contextPercentage === null
        ? "上下文用量未知"
        : `上下文占用 ${formatPercent(contextPercentage / 100)}`,
  };
}
