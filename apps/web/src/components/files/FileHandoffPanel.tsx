import {
  fileHandoffErrorMessage,
  receiveDirectFile,
  sendHandoffFile,
  unwrapFileHandoff,
  waitForRelayedHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  AuthOrchestrationReadScope,
  type AuthSessionId,
  type FileHandoffTransfer,
  type FileHandoffRequest,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { startFileDownload, startVerifiedDesktopDownload } from "~/lib/fileDownload";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { openDesktopHandoffPeer } from "./desktopHandoffPeer";

import {
  fileHandoffAtoms as atoms,
  quietFileHandoff as quiet,
  saveBrowserHandoff,
  type SavePicker,
} from "./fileHandoffReception";

export function FileHandoffPanel({ thread }: { readonly thread: ScopedThreadRef }) {
  const [opened, setOpened] = useState(false);
  const canRead = useEnvironmentScope(thread.environmentId, AuthOrchestrationReadScope);
  if (!canRead) return null;
  return (
    <details
      className="shrink-0 border-b px-3 py-2 text-sm"
      onToggle={(event) => {
        if (event.currentTarget.open) setOpened(true);
      }}
    >
      <summary className="cursor-pointer">设备间传文件</summary>
      {opened && <FileHandoffContents thread={thread} />}
    </details>
  );
}

function FileHandoffContents({ thread }: { readonly thread: ScopedThreadRef }) {
  const { environmentId, threadId } = thread;
  const connection = usePreparedConnection(environmentId);
  const list = useEnvironmentQuery(
    atoms.list({ environmentId, input: { _tag: "list", threadId } }),
  );
  const start = useAtomCommand(atoms.start, quiet);
  const receive = useAtomCommand(atoms.receive, quiet);
  const [closing, setClosing] = useState<string | null>(null);
  const [recipient, setRecipient] = useState<AuthSessionId | null>(null);
  const [selection, setSelection] = useState<{ readonly file: File; readonly id: string } | null>(
    null,
  );
  const [lockedRecipient, setLockedRecipient] = useState<AuthSessionId | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyDownload, setBusyDownload] = useState<string | null>(null);
  const [pendingReceipt, setPendingReceipt] = useState<{
    readonly id: string;
    readonly sizeBytes: number;
    readonly sha256: string;
    readonly savedPath?: string;
  } | null>(null);
  const upload = useRef<AbortController | null>(null);
  const directDownload = useRef<AbortController | null>(null);
  const [transport, setTransport] = useState<"direct" | "relay">("relay");
  const supportsDirect =
    window.desktopBridge?.getClientPlatform() === "win32" &&
    typeof RTCPeerConnection === "function";
  const request = async (input: FileHandoffRequest) =>
    unwrapFileHandoff(await receive({ environmentId, input }));
  const fileInput = useRef<HTMLInputElement>(null);
  const snapshot = list.data?._tag === "list" ? list.data : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 面板卸载时终止仍活跃的上传。
  useEffect(
    () => () => {
      upload.current?.abort();
      directDownload.current?.abort();
    },
    [],
  );
  useLiveRefresh(list.isPending ? null : list.refresh, { intervalMs: 5_000 });

  async function send() {
    if (!selection || !recipient || upload.current || connection._tag !== "Some") return;
    const controller = new AbortController();
    upload.current = controller;
    setLockedRecipient(recipient);
    setError(null);
    setProgress(0);
    setTransport(supportsDirect ? "direct" : "relay");
    try {
      const { file, id } = selection;
      await sendHandoffFile({
        environmentId,
        httpBaseUrl: connection.value.httpBaseUrl,
        start,
        input: {
          threadId,
          id,
          recipient,
          sizeBytes: file.size,
          name: file.name,
          ...(supportsDirect ? { direct: true } : {}),
        },
        ...(supportsDirect
          ? {
              direct: {
                makePeer: openDesktopHandoffPeer,
                request,
                onFallback: () => setTransport("relay"),
              },
            }
          : {}),
        slice: async (offset, length) =>
          new Uint8Array(await file.slice(offset, offset + length).arrayBuffer()),
        post: (url, body, signal) =>
          fetch(url, {
            method: "POST",
            body,
            signal,
            headers: { "Content-Type": "application/octet-stream" },
          }),
        signal: controller.signal,
        onProgress: (offset) =>
          setProgress(file.size > 0 ? Math.floor((100 * offset) / file.size) : 100),
      });
      setSelection(null);
      setLockedRecipient(null);
      if (fileInput.current) fileInput.current.value = "";
    } catch (cause) {
      setError(
        controller.signal.aborted
          ? "上传已暂停。"
          : fileHandoffErrorMessage(cause, "上传中断，请点击继续上传。"),
      );
    } finally {
      upload.current = null;
      setProgress(null);
      list.refresh();
    }
  }

  async function cancel(id: string) {
    if (closing !== null) return;
    setClosing(id);
    setError(null);
    try {
      unwrapFileHandoff(await receive({ environmentId, input: { _tag: "cancel", threadId, id } }));
      if (selection?.id === id) {
        setSelection(null);
        setLockedRecipient(null);
        if (fileInput.current) fileInput.current.value = "";
      }
      list.refresh();
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "取消传输失败，请重试。"));
    } finally {
      setClosing(null);
    }
  }

  async function confirmSaved(receipt: NonNullable<typeof pendingReceipt>) {
    try {
      unwrapFileHandoff(
        await receive({ environmentId, input: { _tag: "confirmSaved", threadId, ...receipt } }),
      );
      setPendingReceipt(null);
      setError(null);
      list.refresh();
    } catch {
      setPendingReceipt(receipt);
      setError("文件已保存，接收回执暂未送达。");
    }
  }

  async function download(item: FileHandoffTransfer) {
    if (busyDownload || pendingReceipt || connection._tag !== "Some") return;
    const id = item.id;
    const controller = new AbortController();
    directDownload.current = controller;
    setBusyDownload(id);
    setError(null);
    try {
      const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      const canDirect = item.directSha256 && supportsDirect && picker;
      const destination =
        picker && (canDirect || (!window.desktopBridge && item.expiresAt !== undefined))
          ? await picker.call(window, { suggestedName: item.name })
          : null;
      if (item.directSha256) {
        if (canDirect && destination) {
          const target = await destination.createWritable();
          try {
            const receipt = await receiveDirectFile({
              id,
              item,
              threadId,
              request,
              signal: controller.signal,
              makePeer: openDesktopHandoffPeer,
              write: (bytes) => target.write(bytes),
              publish: () => target.close(),
            });
            await confirmSaved(receipt);
            return;
          } catch {
            await target.abort().catch(() => undefined);
            controller.signal.throwIfAborted();
          }
        }
        await request({ _tag: "directAbandon", threadId, id }).catch(() => undefined);
        setError("正在改用中转，等待发送设备上传。");
      }
      const result = item.directSha256
        ? await waitForRelayedHandoff({ id, threadId, request, signal: controller.signal })
        : await request({ _tag: "receive", threadId, id });
      setError(null);
      if (result._tag !== "receive") throw new Error("无法领取该文件。");
      const url = resolveAssetUrl(connection.value.httpBaseUrl, result.relativeUrl);
      if (!url) throw new Error("下载地址无效，请重试。");
      let verified = false;
      let savedPath: string | undefined;
      if (destination) {
        await saveBrowserHandoff(url, destination, result.sizeBytes, result.sha256);
        verified = true;
      } else if (window.desktopBridge && item.expiresAt !== undefined) {
        const saved = await startVerifiedDesktopDownload({ url, fileName: result.name });
        verified = saved !== null;
        savedPath = saved?.savedPath;
      } else {
        await startFileDownload({ url, fileName: result.name });
      }
      if (verified)
        await confirmSaved({
          id,
          sizeBytes: result.sizeBytes,
          sha256: result.sha256,
          ...(savedPath ? { savedPath } : {}),
        });
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError"))
        setError(fileHandoffErrorMessage(cause, "下载未完成，请重试。"));
    } finally {
      directDownload.current = null;
      setBusyDownload(null);
    }
  }

  return (
    <div className="mt-2 max-h-[50vh] space-y-2 overflow-auto">
      {list.error && <p role="alert">无法读取传输记录，请检查环境版本和连接。</p>}
      {snapshot && snapshot.recipients.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="file"
            aria-label="选择要发送的文件"
            ref={fileInput}
            className="w-full min-w-0"
            disabled={progress !== null}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              setSelection(file ? { file, id: randomUUID() } : null);
              setLockedRecipient(null);
              setError(null);
            }}
          />
          <select
            aria-label="接收设备"
            className="max-w-full rounded border bg-background px-2 py-1"
            value={recipient ?? ""}
            disabled={lockedRecipient !== null}
            onChange={(event) =>
              setRecipient(
                snapshot.recipients.find((item) => item.id === event.currentTarget.value)?.id ??
                  null,
              )
            }
          >
            <option value="">选择接收设备</option>
            {snapshot.recipients.map((device) => (
              <option key={device.id} value={device.id}>
                {device.label} · {device.online ? "在线" : "离线"} · {device.id.slice(-6)}
              </option>
            ))}
          </select>
          {progress === null ? (
            <Button size="sm" disabled={!recipient || !selection} onClick={() => void send()}>
              {lockedRecipient ? "继续上传" : "发送"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => upload.current?.abort()}>
              暂停上传
            </Button>
          )}
        </div>
      )}
      {progress !== null && (
        <p role="status">
          {transport === "direct" ? "等待直连或正在发送" : "正在中转"} · {progress}%
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {pendingReceipt && (
        <Button
          size="sm"
          variant="outline"
          disabled={busyDownload !== null}
          onClick={async () => {
            setBusyDownload(pendingReceipt.id);
            await confirmSaved(pendingReceipt);
            setBusyDownload(null);
          }}
        >
          重试接收回执
        </Button>
      )}
      {snapshot?.transfers.map((item) => (
        <div key={item.id} className="flex items-center justify-between gap-2 border-t py-1">
          <div className="min-w-0">
            <div className="break-all">{item.name}</div>
            <div className="text-xs text-muted-foreground">
              {item.outgoing ? `发往 ${item.recipientLabel}` : `来自 ${item.senderLabel}`} ·{" "}
              {item.sizeBytes.toLocaleString()} 字节
              {item.disposition === "saved"
                ? " · 已保存并校验"
                : item.disposition === "cancelled"
                  ? " · 已取消"
                  : item.outgoing
                    ? item.sha256
                      ? " · 可领取"
                      : " · 等待上传"
                    : ""}
              {item.expiresAt !== undefined && !item.disposition ? (
                <time dateTime={new Date(item.expiresAt).toISOString()}>
                  {" · 到期 " + new Date(item.expiresAt).toLocaleString()}
                </time>
              ) : null}
            </div>
            {item.sha256 && (
              <details className="text-xs">
                <summary className="cursor-pointer">SHA-256</summary>
                <code className="break-all">{item.sha256}</code>
              </details>
            )}
          </div>
          {item.outgoing && item.expiresAt !== undefined && !item.disposition ? (
            <Button
              variant="outline"
              size="sm"
              disabled={closing !== null || progress !== null}
              onClick={() => void cancel(item.id)}
            >
              取消传输
            </Button>
          ) : null}
          {!item.outgoing && !item.disposition && item.autoReceive !== true && (
            <Button
              variant="outline"
              size="sm"
              disabled={busyDownload !== null || pendingReceipt !== null}
              onClick={() => void download(item)}
            >
              {item.directSha256 ? "直连接收" : "下载"}
            </Button>
          )}
        </div>
      ))}
      {snapshot?.recipients.length === 0 && <p>当前没有可发送的其他已配对设备。</p>}
      {snapshot?.transfers.length === 0 && <p>此会话暂无发送或接收记录。</p>}
      <Button variant="outline" size="sm" disabled={list.isPending} onClick={list.refresh}>
        刷新
      </Button>
    </div>
  );
}
