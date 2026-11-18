import { useAtom, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, HeaderUsageCounters, ProviderInstanceId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { HeaderUsageSettings } from "./HeaderUsageSettings";
import { formatUsageRate, formatUsageRequestSpeed } from "./headerUsageFormat";
import { headerUsageMetrics } from "./headerUsageMetrics";
import { useHeaderUsageQuery } from "./headerUsageQuery";
import {
  resolveHeaderUsageProvider,
  resolveHeaderUsageTarget,
  type HeaderUsageTarget,
} from "./headerUsageTarget";

const preferredTargetAtom = Atom.make<HeaderUsageTarget | null>(null);

function HeaderUsageSamples({ counters }: { readonly counters: HeaderUsageCounters | undefined }) {
  const samples = counters?.recentRequestSamples?.slice(0, 5);
  if (!samples) return <p className="text-sm text-muted-foreground">更新后台以查看逐次统计。</p>;
  if (!samples.length) return <p className="text-sm text-muted-foreground">暂无请求记录。</p>;
  return (
    <>
      <div className="min-w-0">
        <table aria-label="最近5次请求" className="w-full table-fixed text-xs tabular-nums">
          <colgroup>
            <col className="w-[26%]" />
            <col className="w-[30%]" />
            <col className="w-[22%]" />
            <col className="w-[22%]" />
          </colgroup>
          <caption className="pb-2 text-left font-medium">最近5次请求</caption>
          <thead className="text-xs text-muted-foreground">
            <tr>
              {["时间", "Token", "缓存率", "速度 t/s"].map((heading, index) => (
                <th
                  key={heading}
                  scope="col"
                  className={cn(
                    "pb-2 align-bottom font-normal break-words",
                    index === 0 ? "text-left" : "pl-1 text-right",
                  )}
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {samples.map((sample, index) => (
              // oxlint-disable-next-line react/no-array-index-key -- Samples have no ID and timestamps may repeat.
              <tr key={`${sample.timestamp}-${index}`} className="border-t border-border/60">
                <th
                  scope="row"
                  className="py-1.5 text-left align-middle font-normal whitespace-nowrap"
                >
                  <time
                    dateTime={sample.timestamp}
                    aria-label={new Date(sample.timestamp).toLocaleString()}
                    className="text-2xs text-muted-foreground"
                  >
                    {new Date(sample.timestamp).toLocaleTimeString([], { hour12: false })}
                  </time>
                </th>
                <td className="py-1.5 pl-1 text-right align-middle break-all">
                  {sample.totalTokens.toLocaleString()}
                </td>
                <td className="py-1.5 pl-1 text-right align-middle break-all">
                  {formatUsageRate(sample.cacheRate)}
                </td>
                <td className="py-1.5 pl-1 text-right align-middle break-all">
                  {formatUsageRequestSpeed(sample.tokensPerSecond, sample.estimatedTokensPerSecond)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {samples.some(
        (sample) => sample.tokensPerSecond == null && sample.estimatedTokensPerSecond != null,
      ) ? (
        <p className="mt-2 text-xs text-muted-foreground">≈响应速度，含思考与首字等待</p>
      ) : null}
    </>
  );
}

const detailMetricLabels: Record<string, string> = {
  余额: "余额",
  用量: "总用量",
  Day: "今日用量",
  总缓存: "总缓存率",
  缓存5: "最近 5 次缓存率",
  缓存: "本次缓存率",
  "t/s5": "最近 5 次速度",
  "t/s": "本次速度",
};

const compactDetailMetricLabels: Record<string, string> = {
  缓存5: "近5次缓存",
  "t/s5": "近5次速度",
};

export function HomeHeaderUsageStats() {
  const { environments } = useEnvironments();
  const environmentIds = environments.map((environment) => environment.environmentId);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const primary = usePrimaryEnvironmentId();
  const [preferred, setPreferred] = useAtom(preferredTargetAtom);
  const selectedEnvironmentId =
    preferred && environmentIds.includes(preferred.environmentId)
      ? preferred.environmentId
      : primary;
  const target = resolveHeaderUsageTarget({
    environmentIds,
    configs,
    selectedEnvironmentId,
    preferred,
  });
  const config = target ? configs.get(target.environmentId) : undefined;
  const providers =
    config?.providers.filter(
      (provider) => provider.driver === "codex" || provider.driver === "claudeAgent",
    ) ?? [];
  const provider = resolveHeaderUsageProvider(config, target?.providerInstanceId);
  const selectedProviderInstanceId = target?.providerInstanceId ?? provider?.instanceId;
  const picker = target ? (
    <div className="grid gap-2">
      <Select
        value={target.environmentId}
        onValueChange={(value) => {
          const environment = environments.find((item) => item.environmentId === value);
          if (environment) setPreferred({ environmentId: environment.environmentId });
        }}
      >
        <SelectTrigger size="compact" aria-label="统计环境">
          <SelectValue>
            {environments.find((item) => item.environmentId === target.environmentId)?.label ??
              "当前环境"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {environments.map((item) => (
            <SelectItem key={item.environmentId} value={item.environmentId}>
              {item.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {providers.length ? (
        <Select
          value={provider?.instanceId ?? null}
          onValueChange={(value) => {
            const selected = providers.find((item) => item.instanceId === value);
            if (selected)
              setPreferred({
                environmentId: target.environmentId,
                providerInstanceId: selected.instanceId,
              });
          }}
        >
          <SelectTrigger size="compact" aria-label="统计供应商">
            <SelectValue>{provider?.displayName ?? "自动选择供应商"}</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {providers.map((item) => (
              <SelectItem key={item.instanceId} value={item.instanceId}>
                {item.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  ) : null;
  return (
    <HeaderUsageStats
      environmentId={target?.environmentId ?? null}
      {...(selectedProviderInstanceId ? { providerInstanceId: selectedProviderInstanceId } : {})}
      home
      targetPicker={picker}
    />
  );
}

export function HeaderUsageStats(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: string;
  readonly providerInstanceId?: string;
  readonly home?: boolean;
  readonly targetPicker?: ReactNode;
}) {
  const query = useHeaderUsageQuery(props);
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshBusy = useRef(false);
  async function refreshManually() {
    if (refreshBusy.current) return;
    refreshBusy.current = true;
    setRefreshing(true);
    try {
      await query.refresh();
    } finally {
      refreshBusy.current = false;
      setRefreshing(false);
    }
  }
  const [, setPreferred] = useAtom(preferredTargetAtom);
  const provider = resolveHeaderUsageProvider(
    query.config ?? undefined,
    query.resolvedInstanceId ?? undefined,
  );
  const providerInstanceId = provider?.instanceId;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- remembers the visible thread provider in the external home statistics target atom
  useEffect(() => {
    if (props.home || !props.environmentId) return;
    setPreferred({
      environmentId: props.environmentId,
      ...(providerInstanceId ? { providerInstanceId } : {}),
    });
  }, [props.home, props.environmentId, providerInstanceId, setPreferred]);
  const metrics = headerUsageMetrics(query.data, Boolean(props.home), query.now);
  const counters = props.home ? query.data?.allConversations : query.data?.conversation;
  const incomplete = Boolean(
    query.error ||
    query.data?.account.stale ||
    (props.home ? query.data?.allConversations.partial : query.data?.conversation.partial),
  );
  const label = metrics
    .map(
      (item) =>
        `${detailMetricLabels[item.label] ?? item.label} ${item.value}${item.expired ? "，数据已过期" : ""}`,
    )
    .join("，");
  const settingsIdentity = JSON.stringify([props.environmentId, provider?.instanceId]);
  const sourceDescription = `${query.data?.providerLabel ?? provider?.displayName ?? "当前环境"}${
    query.data?.account.sourceLabel ? ` · 账单来源：${query.data.account.sourceLabel}` : ""
  }`;
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) setSettingsOpen(false);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-9 min-w-0 max-w-[70%] shrink cursor-pointer items-center gap-4 overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-sm px-1 font-mono text-2xs tabular-nums outline-none [scrollbar-width:none] hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [-webkit-app-region:no-drag] [&::-webkit-scrollbar]:hidden @max-[34rem]/header:gap-3 @max-[34rem]/header:text-3xs"
          />
        }
        aria-label={`${label}。点击查看余额与用量详情和查询设置。`}
        title="余额与用量：点击查看详情、刷新和查询设置"
        data-header-usage={props.home ? "home" : "thread"}
      >
        {metrics.map((item) => {
          const [heading, qualifier] = item.label.split(" · ");
          return (
            <span
              key={item.label}
              data-header-usage-metric
              className="grid shrink-0 grid-rows-[20px_13px] items-center justify-items-center text-center"
            >
              <span className="relative inline-flex h-5 flex-col justify-center whitespace-nowrap font-sans text-3xs leading-2.5 text-muted-foreground">
                <span>{heading}</span>
                {qualifier ? <span> {qualifier}</span> : null}
                {item.expired ? (
                  <sup className="absolute -top-0.5 -right-1 text-5xs" aria-hidden>
                    *
                  </sup>
                ) : null}
              </span>
              <span
                className={cn(
                  "leading-none",
                  item.lowCache ? "text-destructive-foreground" : "text-foreground",
                )}
              >
                {item.value}
              </span>
            </span>
          );
        })}
        {incomplete ? (
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        width="compact"
        align="end"
        padding="compact"
        collisionAvoidance={{ side: "shift", align: "shift" }}
        keepMounted
      >
        <div className="min-w-0 space-y-3 break-words text-sm leading-relaxed [-webkit-app-region:no-drag]">
          <PopoverTitle>余额与用量</PopoverTitle>
          {props.targetPicker}
          <p className="truncate text-xs text-muted-foreground" title={sourceDescription}>
            {sourceDescription}
          </p>
          {settingsOpen && provider && props.environmentId ? (
            <HeaderUsageSettings
              key={settingsIdentity}
              environmentId={props.environmentId}
              instanceId={provider.instanceId as ProviderInstanceId}
              driver={provider.driver}
              onSaved={() => void query.refresh()}
            />
          ) : (
            <div
              className="@container max-h-[min(60dvh,28rem)] overflow-y-auto overscroll-contain pr-1"
              data-header-usage-details
            >
              <dl className="mb-3 grid grid-cols-3 gap-x-2 gap-y-3 border-b border-border/60 pb-3 text-sm">
                {metrics.map((item) => (
                  <div key={item.label} className="min-w-0">
                    <dt
                      className="truncate text-xs text-muted-foreground"
                      title={detailMetricLabels[item.label] ?? item.label}
                    >
                      {compactDetailMetricLabels[item.label] ??
                        detailMetricLabels[item.label] ??
                        item.label}
                      {item.expired ? " *" : ""}
                    </dt>
                    <dd
                      className={cn(
                        "font-mono tabular-nums",
                        item.lowCache ? "text-destructive-foreground" : "text-foreground",
                      )}
                    >
                      {item.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <HeaderUsageSamples counters={counters} />
            </div>
          )}
          {query.error ? (
            <p role="status" className="text-sm text-destructive-foreground">
              统计刷新失败，保留上次成功数据。请检查环境连接后重试。
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="compact"
              variant="outline"
              disabled={!query.supported || refreshing}
              aria-busy={refreshing}
              onClick={() => void refreshManually()}
            >
              刷新
            </Button>
            <Button
              size="compact"
              variant="ghost"
              disabled={!provider || !query.supported}
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              {settingsOpen ? "统计详情" : "查询设置"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
