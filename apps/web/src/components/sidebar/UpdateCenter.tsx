import { useAtomValue } from "@effect/atom-react";
import { DownloadIcon, MonitorIcon, RefreshCwIcon, ServerIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { environmentIdsKey } from "~/state/environmentAtomList";
import { liveShellEnvironmentIdsAtom } from "~/state/shell";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarUpdateReleaseNotes } from "./SidebarUpdateReleaseNotes";
import { runningThreadCountAtom } from "./UpdateEverythingDialog";
import { UpdateCenterProgress } from "./UpdateCenterProgress";
import { useUpdateEverythingRun } from "./updateEverythingRun";
import { type UpdateCenterDevice, type UpdateCenterItem, useUpdateCenter } from "./useUpdateCenter";
import { desktopUpdateId, serverUpdateId } from "./useUpdateEverything";

function UpdateVersions({ item }: { readonly item: UpdateCenterItem }) {
  return (
    <span className="flex max-w-[55%] min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs text-muted-foreground">
      <span className="wrap-anywhere" aria-label="当前运行版本">
        {item.current ?? "未确认"}
      </span>
      {item.target ? (
        <>
          <span aria-hidden>→</span>
          <strong className="wrap-anywhere font-medium text-foreground" aria-label="可更新版本">
            {item.target}
          </strong>
        </>
      ) : null}
    </span>
  );
}

function SoftwareRow({
  item,
  selection,
  onToggle,
}: {
  readonly item: UpdateCenterItem;
  readonly selection: ReadonlySet<string>;
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined;
}) {
  const canSelect = item.selectable && onToggle !== undefined;
  const contents = (
    <>
      <span className="min-w-0 flex-1 wrap-anywhere text-sm">
        {item.name}
        {item.detail ? (
          <span className="block text-xs text-muted-foreground">{item.detail}</span>
        ) : null}
        {item.error ? <span className="block text-xs text-destructive">{item.error}</span> : null}
      </span>
      <UpdateVersions item={item} />
    </>
  );
  const className =
    "flex min-h-10 items-center gap-2.5 px-2.5 py-2 first:rounded-t-md last:rounded-b-md";
  return canSelect ? (
    <label className={cn(className, "cursor-pointer hover:bg-accent/60")}>
      <input
        type="checkbox"
        checked={selection.has(item.id)}
        aria-label={item.name}
        className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
        onChange={(event) => onToggle(item.id, event.currentTarget.checked)}
      />
      {contents}
    </label>
  ) : (
    <div className={className}>{contents}</div>
  );
}

function DeviceSoftware({
  device,
  selection,
  onToggle,
  confirming,
}: {
  readonly device: UpdateCenterDevice;
  readonly selection: ReadonlySet<string>;
  readonly onToggle?: ((id: string, checked: boolean) => void) | undefined;
  readonly confirming: boolean;
}) {
  const restarting = device.local
    ? device.restartEnvironments.filter(() => selection.has(desktopUpdateId))
    : device.restartEnvironments.filter(({ environmentId }) =>
        selection.has(serverUpdateId(environmentId)),
      );
  const resuming = useAtomValue(
    runningThreadCountAtom(
      environmentIdsKey(
        restarting.filter((entry) => entry.continuesThreads).map((entry) => entry.environmentId),
      ),
    ),
  );
  const interrupted = useAtomValue(
    runningThreadCountAtom(
      environmentIdsKey(
        restarting.filter((entry) => !entry.continuesThreads).map((entry) => entry.environmentId),
      ),
    ),
  );
  const visibleItems = confirming
    ? device.items.filter((item) => selection.has(item.id))
    : device.items;
  const DeviceIcon = device.local ? MonitorIcon : ServerIcon;
  const willRestart = device.local ? selection.has(desktopUpdateId) : restarting.length > 0;
  const liveShells = useAtomValue(liveShellEnvironmentIdsAtom);
  const knowsRunningCount =
    restarting.length > 0 &&
    restarting.every(
      ({ canReadThreads, environmentId }) => canReadThreads && liveShells.has(environmentId),
    );
  const alsoUpdatesCli = device.items.some(
    ({ id }) =>
      id !== desktopUpdateId &&
      !restarting.some(({ environmentId }) => id === serverUpdateId(environmentId)) &&
      selection.has(id),
  );
  const remoteDesktop = device.items.find(
    (item) => item.remoteDesktopUpdate && selection.has(item.id),
  )?.remoteDesktopUpdate;
  const restartDevice = device.local
    ? "桌面端及本机服务端"
    : remoteDesktop
      ? "该电脑上的桌面端及其托管的所有后端"
      : "服务端";
  const restartImpact = knowsRunningCount
    ? `${remoteDesktop ? "当前连接中，" : ""}${interrupted + resuming} 个运行中的会话将被中断。${resuming > 0 ? `重连后可恢复其中 ${resuming} 个会话。` : ""}${interrupted > 0 ? "请在重连后继续未完成的工作。" : ""}`
    : "暂无法确认受影响的会话数。请在重连后检查正在进行的工作。";
  const impact = willRestart
    ? `${restartDevice}将重启。${restartImpact}${remoteDesktop ? "其他后端受影响的会话数未知。" : ""}`
    : confirming
      ? "无需重启。0 个运行中的会话将被中断。"
      : null;
  if (visibleItems.length === 0) return null;
  return (
    <section className="min-w-0">
      <h3 className="flex items-center gap-2 pb-1.5 text-sm font-medium">
        <DeviceIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="wrap-anywhere">{device.name}</span>
      </h3>
      <div className="divide-y divide-border/65 rounded-md bg-muted/30">
        {visibleItems.map((item) => (
          <SoftwareRow key={item.id} item={item} selection={selection} onToggle={onToggle} />
        ))}
      </div>
      {impact ? (
        <p className="pt-1.5 text-xs leading-relaxed text-muted-foreground">
          {impact}
          {confirming && remoteDesktop === "reference-version"
            ? "旧版桌面端按该设备更新源的实际可用版本安装，所示目标版本供参考。"
            : null}
          {confirming && alsoUpdatesCli
            ? "安装时将重新核对最新兼容版本，并等待正在使用所选 CLI 的任务结束。新会话将使用更新后的 CLI。"
            : null}
          {confirming && device.local && willRestart && selection.size > 1
            ? "本机将在其他所选软件处理完后重启。"
            : null}
        </p>
      ) : null}
    </section>
  );
}

export function UpdateCenter({ surface }: { readonly surface: "shortcut" | "about" }) {
  const center = useUpdateCenter();
  const run = useUpdateEverythingRun();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmed, setConfirmed] = useState<ReadonlyMap<string, UpdateCenterItem> | null>(null);
  const [checkPending, setCheckPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [finishedMessage, setFinishedMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  const initialConfirmFocus = useRef(false);
  const inFlight = useRef(false);
  const items = center.groups.flatMap(({ items }) => items);
  const selectable = new Map(
    items.filter(({ selectable }) => selectable).map((item) => [item.id, item]),
  );
  const selection = new Set(Array.from(selected).filter((id) => selectable.has(id)));
  const confirmationChanged =
    confirmed !== null &&
    Array.from(confirmed).some(([id, item]) => {
      const latest = selectable.get(id);
      return (
        latest?.target !== item.target || latest?.remoteDesktopUpdate !== item.remoteDesktopUpdate
      );
    });
  const progress =
    run !== null || (submitted && (pending || finishedMessage !== null || problem !== null));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 确认面板渲染后将键盘焦点移动到返回按钮。
  useEffect(() => {
    if (confirmed && initialConfirmFocus.current) {
      initialConfirmFocus.current = false;
      actionRef.current?.focus();
    }
  }, [confirmed]);

  const check = async () => {
    if (checkPending) return;
    setCheckPending(true);
    setProblem(null);
    try {
      await center.check();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "无法检查更新。");
    } finally {
      setCheckPending(false);
    }
  };

  const changeChannel = async (channel: "stable" | "beta") => {
    if (checkPending || channel === center.channel) return;
    setCheckPending(true);
    setProblem(null);
    setSelected(new Set());
    try {
      await center.setChannel(channel);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "无法切换更新通道。");
    } finally {
      setCheckPending(false);
    }
  };

  const reset = () => {
    setConfirmed(null);
    setSelected(new Set());
    setProblem(null);
    setSubmitted(false);
    setFinishedMessage(null);
  };
  const updateOpen = (value: boolean) => {
    if (!value) reset();
    setOpen(value);
  };
  const toggle = (id: string, checked: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const confirm = async () => {
    if (confirmed === null || confirmationChanged || inFlight.current) return;
    inFlight.current = true;
    setProblem(null);
    setSubmitted(true);
    setPending(true);
    setConfirmed(null);
    setSelected(new Set());
    try {
      setFinishedMessage(await center.run(new Set(confirmed.keys())));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "发生未知错误。");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const heading = progress ? "更新进度" : confirmed ? "确认更新" : "更新中心";
  const checking = checkPending || center.checking;
  const summary = progress
    ? "查看各设备的更新状态"
    : confirmed
      ? "核对更新项目及重启影响"
      : selectable.size > 0
        ? `${selectable.size} 项可更新 · ${center.groups.filter((device) => device.items.some((item) => item.selectable)).length} 台设备`
        : checking
          ? "正在检查更新…"
          : "当前没有可直接更新的软件";
  const displaySelection = confirmed !== null ? new Set(confirmed.keys()) : selection;
  let body: ReactNode;
  if (progress) {
    body = run ? (
      <UpdateCenterProgress run={run} desktopState={center.desktopState} />
    ) : (
      <p role="status" className="text-sm">
        {pending ? "正在准备更新…" : problem ? "更新执行失败" : finishedMessage}
      </p>
    );
  } else {
    body = (
      <>
        {center.groups.map((device) => (
          <DeviceSoftware
            key={device.id}
            device={device}
            selection={displaySelection}
            confirming={confirmed !== null}
            onToggle={confirmed === null ? toggle : undefined}
          />
        ))}
        {center.desktopState &&
        center.desktopState.releaseNotes.length > 0 &&
        confirmed === null ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">桌面端更新说明</summary>
            <SidebarUpdateReleaseNotes
              shell={window.desktopBridge}
              state={center.desktopState}
              tooltip="桌面端新版本"
            />
          </details>
        ) : null}
        {confirmationChanged ? (
          <p role="alert" className="text-sm text-destructive">
            可更新版本或设备连接已变化，请返回重新选择。
          </p>
        ) : null}
      </>
    );
  }
  const actions = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {progress ? (
        <Button size="sm" variant="outline" disabled={pending || run !== null} onClick={reset}>
          完成
        </Button>
      ) : confirmed ? (
        <>
          <Button ref={actionRef} size="sm" variant="outline" onClick={() => setConfirmed(null)}>
            返回选择
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={surface === "shortcut" ? () => updateOpen(false) : reset}
          >
            取消
          </Button>
          <Button size="sm" disabled={confirmationChanged} onClick={() => void confirm()}>
            确认更新
          </Button>
        </>
      ) : (
        <>
          {center.canCheck ? (
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
              {checking ? "正在检查…" : "检查更新"}
            </Button>
          ) : null}
          {surface === "shortcut" ? (
            <Button size="sm" variant="ghost" onClick={() => updateOpen(false)}>
              取消
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={selection.size === 0}
            onClick={() => {
              initialConfirmFocus.current = true;
              setConfirmed(new Map(Array.from(selection).map((id) => [id, selectable.get(id)!])));
            }}
          >
            更新所选项
          </Button>
        </>
      )}
    </div>
  );
  const contents = (
    <>
      <div className="flex flex-col gap-3">
        {body}
        {problem ? (
          <p role="alert" className="wrap-anywhere text-sm text-destructive">
            {progress ? "更新失败" : "检查更新失败"}。{problem}
          </p>
        ) : null}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 pt-3">
        {!progress ? (
          <span className="text-xs text-muted-foreground" aria-live="polite">
            已选择 {displaySelection.size} 项
          </span>
        ) : null}
        <div className="ml-auto">{actions}</div>
      </footer>
    </>
  );

  if (surface === "about") {
    return (
      <div className="flex flex-col gap-3 py-3">
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {confirmed || progress ? `${heading} · ${summary}` : summary}
        </p>
        {!confirmed && !progress ? (
          <label className="flex flex-wrap items-center gap-2 text-sm">
            更新通道
            <select
              className="h-9 rounded-md border border-input bg-background px-2"
              value={center.channel}
              disabled={checkPending || center.desktopState?.status === "downloading"}
              onChange={(event) =>
                void changeChannel(event.currentTarget.value === "beta" ? "beta" : "stable")
              }
            >
              <option value="stable">正式版</option>
              <option value="beta">测试版（Beta）</option>
            </select>
          </label>
        ) : null}
        {contents}
      </div>
    );
  }
  return (
    <Popover open={open} onOpenChange={updateOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full bg-sidebar-control-surface px-2.5 text-xs font-medium text-sidebar-foreground outline-hidden ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset [&_svg]:size-3.5"
          />
        }
      >
        {progress ? (
          <RefreshCwIcon aria-hidden className={run ? "motion-safe:animate-spin" : undefined} />
        ) : (
          <DownloadIcon aria-hidden />
        )}
        {progress ? "更新进度" : "更新"}
        {!progress && selectable.size > 0 ? (
          <span className="rounded-full bg-primary/10 px-1.5 text-xs tabular-nums">
            {selectable.size}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup
        side="top"
        align="end"
        padding="none"
        width="lg"
        className="max-w-[calc(100vw-1rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
          <div className="min-w-0">
            <PopoverTitle>{heading}</PopoverTitle>
            <p className="pt-0.5 text-xs text-muted-foreground" aria-live="polite">
              {summary}
            </p>
          </div>
          <PopoverClose
            render={<Button size="icon-sm" variant="ghost" aria-label="关闭更新中心" />}
          >
            <XIcon aria-hidden />
          </PopoverClose>
        </div>
        <ScrollArea scrollFade className="max-h-[min(34rem,calc(100dvh-8rem))] min-h-0">
          <div className="px-3 py-2.5">{contents}</div>
        </ScrollArea>
      </PopoverPopup>
    </Popover>
  );
}
