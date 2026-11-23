import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FileHandoffReply,
  type FileHandoffRequest,
  type FileHandoffTransfer,
  type FileHandoffUrlDownload,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  formatFileHandoffReceipt,
  unwrapFileHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { useConnectedEnvironmentIds } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { SavedFileHandoffLocation } from "./SavedFileHandoffLocation";
import {
  fileHandoffAtoms,
  quietFileHandoff,
  readFileReceipt,
  receiveAgentFile,
  subscribeFileReceipts,
} from "./fileHandoffReception";

function useReception(environmentId: EnvironmentId) {
  const receive = useAtomCommand(fileHandoffAtoms.receive, quietFileHandoff);
  const connection = usePreparedConnection(environmentId);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const httpBaseUrl = canRead && connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const request = async (input: FileHandoffRequest) =>
    unwrapFileHandoff(await receive({ environmentId, input }));
  return { httpBaseUrl, request };
}

function useHandoffRefresh(refresh: () => void, enabled: boolean, pending: boolean) {
  const tick = useEffectEvent(() => {
    if (!pending) refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 连接期间监测接收任务，桌面退至后台时仍要领取。
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setInterval(tick, 10_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
}

export function FileHandoffInbox() {
  const environments = useConnectedEnvironmentIds();
  return environments.map((environmentId) => (
    <HandoffEnvironment key={environmentId} environmentId={environmentId} />
  ));
}

function HandoffEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { httpBaseUrl, request } = useReception(environmentId);
  const desktop = Boolean(window.desktopBridge?.downloadHandoffFile);
  const inbox = useEnvironmentQuery(
    httpBaseUrl ? fileHandoffAtoms.list({ environmentId, input: { _tag: "inbox" } }) : null,
  );
  useHandoffRefresh(inbox.refresh, httpBaseUrl !== null, inbox.isPending);
  const entries = desktop && inbox.data?._tag === "inbox" ? inbox.data.transfers : null;
  const urlDownloads = inbox.data?._tag === "inbox" ? inbox.data.urlDownloads : undefined;
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const next = urlDownloads?.find((item) => !handled.has(item.id));

  const process = useEffectEvent(async (transfers: NonNullable<typeof entries>, url: string) => {
    for (const file of transfers) {
      if (file.autoReceive === true) {
        await receiveAgentFile({
          file,
          environmentId,
          threadId: file.threadId,
          httpBaseUrl: url,
          automatic: true,
          request,
        });
      }
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 已认证收件箱返回的新任务交给桌面下载器。
  useEffect(() => {
    if (httpBaseUrl && entries && inbox.dataUpdatedAt > 0) void process(entries, httpBaseUrl);
  }, [entries, httpBaseUrl, inbox.dataUpdatedAt]);
  return httpBaseUrl && next ? (
    <UrlDownloadDialog
      key={next.id}
      environmentId={environmentId}
      item={next}
      httpBaseUrl={httpBaseUrl}
      desktop={desktop}
      request={request}
      finished={() => {
        setHandled((current) => new Set([...current, next.id]));
        inbox.refresh();
      }}
    />
  ) : null;
}

function UrlDownloadDialog({
  environmentId,
  item,
  httpBaseUrl,
  desktop,
  request,
  finished,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: FileHandoffUrlDownload;
  readonly httpBaseUrl: string;
  readonly desktop: boolean;
  readonly request: (input: FileHandoffRequest) => Promise<FileHandoffReply>;
  readonly finished: () => void;
}) {
  const { id, threadId } = item;
  const [ready, setReady] = useState(item.ready);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(item.failure ?? null);
  async function save(file: NonNullable<FileHandoffUrlDownload["ready"]>) {
    const target = { environmentId, threadId, file: { id, name: item.name, ...file } };
    await receiveAgentFile({
      ...target,
      httpBaseUrl,
      desktop,
      request,
      automatic: false,
      retry: true,
    });
    const receipt = readFileReceipt(target);
    if (receipt?.state === "saved" || receipt?.state === "downloaded") {
      toastManager.add({
        type: "success",
        title: receipt.state === "saved" ? `已保存 ${item.name}` : "已交给浏览器下载",
      });
      finished();
    } else {
      setError(
        receipt?.state === "receipt" ? "文件已保存，接收回执待发送。" : "文件未保存，请重试。",
      );
    }
  }

  async function respond(action: "approveUrl" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      if (action === "approveUrl" && ready) {
        await save(ready);
      } else {
        const reply = await request({ _tag: action, threadId, id });
        if (reply._tag === "finished" && reply.disposition === "cancelled") finished();
        else if (reply._tag === "receive") {
          const file = { sizeBytes: reply.sizeBytes, sha256: reply.sha256 };
          setReady(file);
          // 浏览器选择保存位置需要一次新的点击手势。
          if (desktop) await save(file);
        } else throw new Error("无法处理下载请求。");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法处理下载请求，请重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>下载到这台设备</DialogTitle>
          <DialogDescription>
            {item.senderLabel} 请求下载 {item.name}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="break-all text-sm" lang="en" dir="ltr">
            {item.sourceUrl}
          </p>
          {busy ? (
            <p role="status" className="mt-2 text-sm">
              正在处理下载请求…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void respond("cancel")}>
            取消请求
          </Button>
          <Button disabled={busy} onClick={() => void respond("approveUrl")}>
            {ready ? "保存到我的设备" : "确认下载"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function useThreadHandoffs(thread: ScopedThreadRef) {
  const { httpBaseUrl, request } = useReception(thread.environmentId);
  const list = useEnvironmentQuery(
    httpBaseUrl
      ? fileHandoffAtoms.list({
          environmentId: thread.environmentId,
          input: { _tag: "list", threadId: thread.threadId },
        })
      : null,
  );
  const transfers = list.data?._tag === "list" ? list.data.transfers : [];
  return { httpBaseUrl, request, list, transfers };
}

export function ThreadFileSaveStatus(props: {
  readonly thread: ScopedThreadRef;
  readonly id: string;
  readonly fallback: string;
}) {
  const { httpBaseUrl, request, list, transfers } = useThreadHandoffs(props.thread);
  const file = transfers.find((item) => item.id === props.id);
  useHandoffRefresh(
    list.refresh,
    httpBaseUrl !== null &&
      (!file?.disposition ||
        (file.installRequested === true && file.installation?.status !== "verified")),
    list.isPending,
  );
  const settled = file ? formatFileHandoffReceipt(file) : null;
  if (file && settled) {
    return (
      <div className="space-y-1.5">
        <p>{settled}</p>
        {file.disposition === "saved" && !file.outgoing ? (
          <SavedFileHandoffLocation threadId={props.thread.threadId} transferId={file.id} />
        ) : null}
      </div>
    );
  }
  if (httpBaseUrl && file?.autoReceive && !file.outgoing) {
    return (
      <ThreadFileReceipt
        thread={props.thread}
        file={file}
        httpBaseUrl={httpBaseUrl}
        request={request}
      />
    );
  }
  return <p>{props.fallback}</p>;
}

export function ThreadFileReception({ thread }: { readonly thread: ScopedThreadRef }) {
  const { httpBaseUrl, request, list, transfers } = useThreadHandoffs(thread);
  useHandoffRefresh(list.refresh, httpBaseUrl !== null, list.isPending);
  const incoming = transfers.filter((transfer) => transfer.autoReceive && !transfer.outgoing);
  if (!httpBaseUrl || incoming.length === 0) return null;
  return (
    <div className="chat-content-lane space-y-1 pb-2">
      {incoming.map((file) => (
        <ThreadFileReceipt
          key={file.id}
          thread={thread}
          file={file}
          httpBaseUrl={httpBaseUrl}
          request={request}
        />
      ))}
    </div>
  );
}

function ThreadFileReceipt(props: {
  readonly thread: ScopedThreadRef;
  readonly file: FileHandoffTransfer;
  readonly httpBaseUrl: string;
  readonly request: (input: FileHandoffRequest) => Promise<FileHandoffReply>;
}) {
  const target = { ...props.thread, file: props.file };
  const desktop = Boolean(window.desktopBridge?.downloadHandoffFile);
  const getReceipt = () => readFileReceipt(target);
  const receipt = useSyncExternalStore(subscribeFileReceipts, getReceipt, getReceipt);
  const status =
    formatFileHandoffReceipt(props.file) ??
    (receipt?.state === "working"
      ? "正在接收…"
      : receipt?.state === "saved"
        ? receipt.savedPath
          ? `已保存并校验 · ${receipt.savedPath}`
          : "已保存并校验"
        : receipt?.state === "downloaded"
          ? "已交给浏览器下载，请在浏览器下载列表查看。"
          : receipt?.state === "receipt"
            ? "文件已保存，接收回执待发送。"
            : receipt?.state === "failed"
              ? "文件未领取，请重试。"
              : desktop
                ? "等待桌面端接收…"
                : "等待保存");
  const showLocation =
    props.file.disposition === "saved" ||
    (!props.file.disposition && (receipt?.state === "saved" || receipt?.state === "receipt"));
  const canSave =
    !props.file.disposition &&
    props.file.sha256 &&
    (desktop
      ? receipt?.state === "failed" || receipt?.state === "receipt"
      : receipt?.state !== "working" && receipt?.state !== "saved");
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border py-1.5 text-xs">
      <div className="min-w-0 break-words">
        <div className="font-medium">{props.file.name}</div>
        <div role="status" className="text-muted-foreground">
          {status}
        </div>
      </div>
      {showLocation ? (
        <SavedFileHandoffLocation threadId={props.thread.threadId} transferId={props.file.id} />
      ) : null}
      {canSave ? (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void receiveAgentFile({
              ...target,
              httpBaseUrl: props.httpBaseUrl,
              request: props.request,
              automatic: false,
              desktop,
              retry: true,
            })
          }
        >
          {receipt?.state === "receipt"
            ? "重试接收回执"
            : receipt?.state === "failed" || receipt?.state === "downloaded"
              ? "重新保存"
              : "保存到我的设备"}
        </Button>
      ) : null}
    </div>
  );
}
