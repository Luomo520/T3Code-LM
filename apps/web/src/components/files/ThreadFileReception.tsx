import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FileHandoffReply,
  type FileHandoffRequest,
  type FileHandoffTransfer,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  formatFileHandoffReceipt,
  unwrapFileHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";

import { useConnectedEnvironmentIds } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
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

export function DesktopFileHandoffInbox() {
  const environments = useConnectedEnvironmentIds();
  return environments.map((environmentId) => (
    <DesktopHandoffEnvironment key={environmentId} environmentId={environmentId} />
  ));
}

function DesktopHandoffEnvironment({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { httpBaseUrl, request } = useReception(environmentId);
  const inbox = useEnvironmentQuery(
    httpBaseUrl ? fileHandoffAtoms.list({ environmentId, input: { _tag: "inbox" } }) : null,
  );
  useHandoffRefresh(inbox.refresh, httpBaseUrl !== null, inbox.isPending);
  const entries = inbox.data?._tag === "inbox" ? inbox.data.transfers : null;

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
  return null;
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
  const { httpBaseUrl, request, transfers } = useThreadHandoffs(props.thread);
  const file = transfers.find((item) => item.id === props.id);
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
