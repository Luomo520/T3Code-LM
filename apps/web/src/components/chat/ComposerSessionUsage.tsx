import { useState } from "react";
import type { ConversationUsage } from "@t3tools/contracts";
import {
  SESSION_COST_COLORS,
  SESSION_COST_LABELS,
  sessionUsageDisplay,
} from "@t3tools/shared/sessionUsageDisplay";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function ComposerSessionUsage({
  usage,
  contextWindow,
  theme,
}: {
  readonly usage: ConversationUsage | null | undefined;
  readonly contextWindow:
    | { readonly usedTokens: number; readonly maxTokens: number | null }
    | null
    | undefined;
  readonly theme: "light" | "dark";
}) {
  const [mode, setMode] = useState<"hover" | "pinned" | null>(null);
  const display = sessionUsageDisplay(usage, contextWindow);
  const contextColor = theme === "dark" ? "#4ade80" : "#15803d";
  return (
    <Popover
      open={mode !== null}
      onOpenChange={(open, details) => {
        if (details.reason === "trigger-press" && mode === "hover") {
          if (!open) details.cancel();
          setMode("pinned");
        } else if (details.reason === "trigger-hover") {
          if (mode === "pinned") details.cancel();
          else setMode(open ? "hover" : null);
        } else {
          setMode(open ? "pinned" : null);
        }
      }}
    >
      <PopoverTrigger
        type="button"
        openOnHover={mode !== "pinned"}
        delay={150}
        aria-label={`会话费用 ${display.costLabel}，${display.contextLabel}，查看用量详情`}
        render={
          <button
            type="button"
            className="flex min-h-7 max-w-full items-center gap-2 rounded-md px-2 text-xs text-muted-foreground tabular-nums hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-ring pointer-coarse:min-h-11"
          />
        }
      >
        <span className="max-w-full truncate">{display.costLabel}</span>
        <span className="flex w-14 shrink-0 flex-col gap-1" aria-hidden>
          <span className="flex h-[3px] overflow-hidden rounded-full bg-muted-foreground/25">
            {display.categorySegments.map(({ category, share }) => (
              <span
                key={category}
                style={{
                  width: `${share * 100}%`,
                  backgroundColor: SESSION_COST_COLORS[category][theme],
                }}
              />
            ))}
          </span>
          <span className="flex h-0.5 overflow-hidden rounded-full bg-muted-foreground/25">
            {display.contextPercentage === null ? null : (
              <span
                style={{ width: `${display.contextPercentage}%`, backgroundColor: contextColor }}
              />
            )}
          </span>
        </span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" width="sm" padding="compact">
        <div className="mb-2">
          <PopoverTitle>会话用量</PopoverTitle>
        </div>
        <dl className="grid grid-cols-[1fr_auto] gap-y-1.5 text-xs tabular-nums">
          <dt>累计费用</dt>
          <dd className="text-end">{display.costLabel}</dd>
          <dt>最近一轮费用</dt>
          <dd className="text-end">{display.recentCostLabel}</dd>
          <dt>最近一轮缓存命中率</dt>
          <dd className="text-end">{display.cacheRateLabel}</dd>
        </dl>
        {display.categorySegments.length > 0 ? (
          <dl className="mt-2 grid grid-cols-[1fr_auto] gap-y-1.5 border-t border-border pt-2 text-xs tabular-nums">
            {display.categorySegments.map(({ category, label }) => (
              <div key={category} className="contents">
                <dt className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: SESSION_COST_COLORS[category][theme] }}
                  />
                  {SESSION_COST_LABELS[category]}
                </dt>
                <dd className="text-end">{label}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">{display.contextLabel}</p>
        {display.costPartial || display.recentCostPartial ? (
          <p className="mt-1 text-xs text-muted-foreground">* 仅含已知费用</p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
