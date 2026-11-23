import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createFileHandoffAtoms,
  fileHandoffErrorMessage,
  formatFileMoveResult,
  hasVerifiedFileMoveReceipt,
  type PendingFileMove,
  receiveDirectFile,
  sendHandoffFile,
  unwrapFileHandoff,
  waitForRelayedHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthSessionId,
  type EnvironmentId,
  type FileHandoffTransfer,
  type FileHandoffRequest,
  type ThreadId,
} from "@t3tools/contracts";
import { getDocumentAsync } from "expo-document-picker";
import { fetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  enqueueFileDownload,
  fileHandoffDownloadKey,
  readHandoffDownload,
  readFileDownload,
  saveDirectHandoff,
  supportsDirectHandoffSave,
  showDownloadedFiles,
  type FileDownload,
} from "../../lib/systemFileDownload";
import { isAppActive, useAppActive } from "../../lib/appState";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentConnectedAtom } from "../../state/use-remote-environment-registry";
import { useAndroidHandoffPeer } from "./useAndroidHandoffPeer";
import { localFileMove } from "./localFileMove";
import { localScreenCapture, type LocalCaptureKind } from "./localScreenCapture";
import { ReceivedApkInstallAction } from "./ReceivedApkInstallAction";

const atoms = createFileHandoffAtoms(connectionAtomRuntime);
const quiet = { reportFailure: false, reportDefect: false };

type Context = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function FileHandoffPanel(context: Context) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const canRead = useEnvironmentScope(context.environmentId, AuthOrchestrationReadScope);
  if (Platform.OS !== "android" || !canRead) return null;
  return (
    <View className="border-b border-border px-3 py-1">
      <Button
        size="compact"
        tone="text"
        label={open ? "收起设备间传文件" : "设备间传文件"}
        onPress={() => {
          setOpened(true);
          setOpen((value) => !value);
        }}
      />
      {opened && (
        <View className={open ? "" : "hidden"}>
          <FileHandoffContents
            key={JSON.stringify([context.environmentId, context.threadId])}
            {...context}
            visible={open}
          />
        </View>
      )}
    </View>
  );
}

type Download = {
  readonly id: string;
  readonly nativeId?: string;
  readonly uri?: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly supportsReceipt: boolean;
};

const downloadsByThread = new Map<string, Download>();

type Selection = {
  readonly file: File;
  readonly id: string;
  readonly name: string;
  readonly moveToken?: string;
};

function deleteSelection(selection: Selection | null) {
  if (selection?.moveToken) {
    void localFileMove?.discard(selection.moveToken).catch(() => {});
    return;
  }
  try {
    if (selection?.file.exists) selection.file.delete();
  } catch {
    // 文档选择器的暂存副本失效时，由系统清理缓存。
  }
}

function FileHandoffContents({ environmentId, threadId, visible }: Context & { visible: boolean }) {
  const appActive = useAppActive();
  const canSend = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const connection = usePreparedConnection(environmentId);
  const list = useEnvironmentQuery(
    atoms.list({ environmentId, input: { _tag: "list", threadId } }),
  );
  const start = useAtomCommand(atoms.start, quiet);
  const receive = useAtomCommand(atoms.receive, quiet);
  const [recipient, setRecipient] = useState<{ id: AuthSessionId; label: string } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingFileMove | null>(null);
  const moveRef = useRef<PendingFileMove | null>(null);
  const [moveStatus, setMoveStatus] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const downloadKey = JSON.stringify([environmentId, threadId]);
  const [download, setDownload] = useState(() => downloadsByThread.get(downloadKey) ?? null);
  const [closing, setClosing] = useState<string | null>(null);
  // 直传在发回执前已经落盘，重开面板时继续回报，避免把旧文件当作进行中的下载。
  const [receiptPending, setReceiptPending] = useState(() =>
    Boolean(download?.supportsReceipt && download.uri),
  );
  const sendingReceipt = useRef(false);
  const acknowledged = useRef(new Set<string>());
  const [downloadState, setDownloadState] = useState<FileDownload | null>(() =>
    download?.uri
      ? { status: "downloaded", bytesDownloaded: download.sizeBytes, uri: download.uri }
      : null,
  );
  const [receivingId, setReceivingId] = useState<string | null>(null);
  const busyDownload = receivingId !== null;
  const [choosingRecipient, setChoosingRecipient] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const selectionPending = useRef(false);
  const captureRequest = useRef<string | null>(null);
  const [capturePhase, setCapturePhase] = useState<LocalCaptureKind | "recording-active" | null>(
    null,
  );
  const directDownload = useRef<AbortController | null>(null);
  const directPeer = useAndroidHandoffPeer();
  const supportsDirect = supportsDirectHandoffSave();
  const [transport, setTransport] = useState<"direct" | "relay">("relay");
  const request = async (input: FileHandoffRequest) =>
    unwrapFileHandoff(await receive({ environmentId, input }));
  const picked = useRef<Selection | null>(null);
  const snapshot = list.data?._tag === "list" ? list.data : null;
  const refreshList = list.refresh;
  const liveConnection = useAtomValue(environmentConnectedAtom(environmentId));
  const connected = liveConnection && connection._tag === "Some";
  const canUsePanel = visible && connected;

  const captureAvailable = canUsePanel && canSend;
  const sendAvailability = useRef<{ readonly active: boolean }>({ active: captureAvailable });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 关闭面板或环境断开时立即取消未完成的投屏。
  useEffect(() => {
    sendAvailability.current = { active: captureAvailable };
    if (!captureAvailable) return;
    const native = localScreenCapture;
    const listener = native?.addListener("onRecordingStarted", ({ requestId }) => {
      if (captureRequest.current === requestId) setCapturePhase("recording-active");
    });
    return () => {
      sendAvailability.current = { active: false };
      listener?.remove();
      if (captureRequest.current)
        void native?.cancelCapture(captureRequest.current).catch(() => {});
    };
  }, [captureAvailable]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 离开前台或失去环境权限后，停止读取和上传本机选中的文件。
  useEffect(() => {
    if (!appActive || !connected || !canSend) upload.current?.abort();
  }, [appActive, canSend, connected]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 前台接收面板及时显示另一台设备发来的直连邀请。
  useEffect(() => {
    if (!appActive || !visible || !connected) return;
    refreshList();
    const timer = setInterval(refreshList, 5_000);
    return () => clearInterval(timer);
  }, [appActive, visible, connected, refreshList]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 面板关闭时取消上传并释放文档选择器缓存。
  useEffect(
    () => () => {
      const controller = upload.current;
      controller?.abort();
      directDownload.current?.abort();
      deleteSelection(picked.current);
      picked.current = null;
      if (moveRef.current) void localFileMove?.discard(moveRef.current.token).catch(() => {});
      moveRef.current = null;
    },
    [],
  );

  function preserveMove(move: PendingFileMove, message: string) {
    if (moveRef.current !== move) return;
    moveRef.current = null;
    setPendingMove(null);
    setMoveStatus(message);
    void localFileMove?.discard(move.token).catch(() => {});
  }

  const settleMove = useEffectEvent((move: PendingFileMove) => {
    if (!localFileMove || moveRef.current !== move) return;
    moveRef.current = null;
    setMoveStatus("目标设备已确认保存，正在核对源文件。");
    void localFileMove
      .finish(move.token, move.sha256)
      .catch(() => "retained" as const)
      .then((result) => {
        setMoveStatus(formatFileMoveResult(result));
        setPendingMove(null);
      });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 根据接收设备完成保存的回执核对本机源文件。
  useEffect(() => {
    if (!pendingMove || !canUsePanel || !appActive || !canSend) return;
    const item = snapshot?.transfers.find((entry) => entry.id === pendingMove.id);
    if (hasVerifiedFileMoveReceipt(item, pendingMove)) settleMove(pendingMove);
  }, [appActive, canSend, canUsePanel, pendingMove, snapshot]);

  async function confirmSaved(saved: Download) {
    if (sendingReceipt.current || acknowledged.current.has(saved.id)) return;
    sendingReceipt.current = true;
    try {
      unwrapFileHandoff(
        await receive({
          environmentId,
          input: {
            _tag: "confirmSaved",
            threadId,
            id: saved.id,
            sizeBytes: saved.sizeBytes,
            sha256: saved.sha256,
            ...(saved.uri ? { savedPath: saved.uri } : {}),
          },
        }),
      );
      acknowledged.current.add(saved.id);
      if (downloadsByThread.get(downloadKey)?.id === saved.id)
        downloadsByThread.delete(downloadKey);
      setReceiptPending(false);
      setError(null);
      setDownload((current) => (current?.id === saved.id ? null : current));
      list.refresh();
    } catch {
      setReceiptPending(true);
      setError("文件已保存，接收回执暂未送达。");
    } finally {
      sendingReceipt.current = false;
    }
  }
  const confirmAfterDownload = useEffectEvent((saved: Download) => {
    if (saved.supportsReceipt) void confirmSaved(saved);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 轮询原生下载服务直到保存或失败。
  useEffect(() => {
    if (!download?.nativeId) return;
    const nativeId = download.nativeId;
    let subscribed = true;
    const refresh = () => {
      void readFileDownload(nativeId)
        .then((status) => {
          if (!subscribed) return;
          setDownloadState(status);
          if (!status) {
            downloadsByThread.delete(downloadKey);
            setDownload(null);
          }
          if (status?.status === "downloaded")
            confirmAfterDownload({ ...download, ...(status.uri ? { uri: status.uri } : {}) });
          if (status?.status === "failed") setError(status.error ?? "下载中断，可继续下载。");
          if (!status || ["failed", "cancelled", "downloaded"].includes(status.status))
            clearInterval(timer);
        })
        .catch(() => {
          if (subscribed) setError("无法读取下载状态。");
        });
    };
    const timer = setInterval(refresh, 1000);
    refresh();
    return () => {
      subscribed = false;
      clearInterval(timer);
    };
  }, [download, downloadKey]);

  const applyLocalHandoff = useEffectEvent(
    (item: FileHandoffTransfer, status: FileDownload, sha256: string) => {
      const next = {
        id: item.id,
        name: item.name,
        sizeBytes: item.sizeBytes,
        sha256,
        supportsReceipt: item.expiresAt !== undefined,
        ...(status.uri ? { uri: status.uri } : {}),
        ...(status.nativeId ? { nativeId: status.nativeId } : {}),
      };
      downloadsByThread.set(downloadKey, next);
      setDownload(next);
      setDownloadState(status);
      if (status.status === "downloaded" && next.supportsReceipt) void confirmSaved(next);
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 重新进入会话时恢复同一个传输及尚未送达的回执。
  useEffect(() => {
    if (!snapshot || download || busyDownload) return;
    let active = true;
    void (async () => {
      for (const item of snapshot.transfers) {
        const sha256 = item.sha256 ?? item.directSha256;
        if (
          item.outgoing ||
          item.disposition ||
          !sha256 ||
          !active ||
          acknowledged.current.has(item.id)
        )
          continue;
        const key = await fileHandoffDownloadKey(environmentId, threadId, item.id);
        const status = await readHandoffDownload(key, item.sizeBytes, sha256).catch(() => null);
        if (active && status) {
          applyLocalHandoff(item, status, sha256);
          return;
        }
      }
    })().catch(() => {});
    return () => {
      active = false;
    };
  }, [busyDownload, download, environmentId, snapshot, threadId]);

  const savedUri = download?.uri ?? downloadState?.uri;
  const retryReceipt = useEffectEvent(() => {
    if (download && savedUri) void confirmSaved({ ...download, uri: savedUri });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 连接恢复后重发已保存文件的回执。
  useEffect(() => {
    if (connection._tag !== "Some" || !receiptPending || !snapshot) return;
    // oxlint-disable-next-line react/set-state-in-effect -- 向远端重交保存回执，只有异步请求返回后才更新界面。
    retryReceipt();
  }, [connection._tag, receiptPending, snapshot]);

  const downloadRetryable =
    downloadState?.status === "failed" ||
    downloadState?.status === "cancelled" ||
    (downloadState?.status === "paused" && downloadState.retryable === true);
  const currentDownloadLabel =
    downloadState?.status === "downloaded"
      ? "已保存"
      : downloadRetryable
        ? "继续下载"
        : downloadState?.status === "paused"
          ? "等待连接"
          : "已下载 " + (downloadState?.bytesDownloaded.toLocaleString() ?? "0") + " 字节";

  function acceptSelection(
    uri: string,
    name: string,
    authorization: { readonly active: boolean },
    moveToken?: string,
  ) {
    const next = { file: new File(uri), id: uuidv4(), name, ...(moveToken ? { moveToken } : {}) };
    if (!authorization.active || sendAvailability.current !== authorization) {
      deleteSelection(next);
      return;
    }
    deleteSelection(picked.current);
    picked.current = next;
    setSelection(next);
    setLocked(false);
    setError(null);
  }

  async function pickFile(mode: "copy" | "move") {
    if (!captureAvailable || !isAppActive() || selectionPending.current || upload.current) return;
    if (mode === "move" && (!localFileMove || pendingMove)) return;
    const authorization = sendAvailability.current;
    selectionPending.current = true;
    try {
      if (mode === "move" && localFileMove) {
        const result = await localFileMove.pick();
        if (result) acceptSelection(result.uri, result.name, authorization, result.token);
        return;
      }
      const result = await getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        acceptSelection(asset.uri, asset.name, authorization);
      }
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "无法读取选中的文件。"));
    } finally {
      selectionPending.current = false;
    }
  }

  async function capture(kind: LocalCaptureKind) {
    if (
      !localScreenCapture ||
      !captureAvailable ||
      !isAppActive() ||
      selectionPending.current ||
      upload.current
    )
      return;
    const authorization = sendAvailability.current;
    selectionPending.current = true;
    const requestId = uuidv4();
    captureRequest.current = requestId;
    setCapturePhase(kind);
    setError(null);
    try {
      const result = await localScreenCapture.capture(kind, requestId);
      if (result) acceptSelection(result.uri, result.name, authorization);
      else if (sendAvailability.current === authorization) {
        setError(
          kind === "screenshot"
            ? "未取得截图。请在本机重新授权后重试。"
            : "录屏已结束，未保留录像。",
        );
      }
    } catch (cause) {
      if (sendAvailability.current === authorization) {
        setError(fileHandoffErrorMessage(cause, "无法开始捕获，请重试。"));
      }
    } finally {
      captureRequest.current = null;
      selectionPending.current = false;
      setCapturePhase(null);
    }
  }

  async function send() {
    if (
      !selection ||
      !recipient ||
      !captureAvailable ||
      !isAppActive() ||
      selectionPending.current ||
      upload.current ||
      connection._tag !== "Some"
    )
      return;
    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    setTransport(supportsDirect ? "direct" : "relay");
    setLocked(true);
    setError(null);
    const { file, name, id, moveToken } = selection;
    try {
      if (localScreenCapture && !(await localScreenCapture.isUnlocked())) {
        throw new Error("解锁手机后可以继续上传。");
      }
      controller.signal.throwIfAborted();
      const handle = file.open();
      try {
        const sizeBytes = handle.size;
        if (sizeBytes === null) throw new Error("无法读取文件大小，请重新选择。");
        const sha256 = await sendHandoffFile({
          environmentId,
          httpBaseUrl: connection.value.httpBaseUrl,
          start,
          input: {
            threadId,
            id,
            recipient: recipient.id,
            sizeBytes,
            name,
            ...(supportsDirect ? { direct: true } : {}),
          },
          ...(supportsDirect
            ? {
                direct: {
                  makePeer: directPeer.makePeer,
                  request,
                  onFallback: () => setTransport("relay"),
                },
              }
            : {}),
          slice: async (offset, length) => {
            controller.signal.throwIfAborted();
            if (!isAppActive()) throw new Error("回到会话后可继续上传。");
            handle.offset = offset;
            return length === 0 ? new Uint8Array() : handle.readBytes(length);
          },
          post: (url, body, signal) =>
            fetch(url, {
              method: "POST",
              body,
              signal,
              headers: { "Content-Type": "application/octet-stream" },
            }),
          signal: controller.signal,
          onProgress: (offset) =>
            setProgress(sizeBytes > 0 ? Math.floor((100 * offset) / sizeBytes) : 100),
        });
        if (moveToken) {
          const pending = { token: moveToken, id, sha256, sizeBytes };
          moveRef.current = pending;
          setPendingMove(pending);
          setMoveStatus("等待目标设备保存并校验文件。");
        }
      } finally {
        handle.close();
      }
      if (!moveToken) deleteSelection(selection);
      picked.current = null;
      setSelection(null);
      setLocked(false);
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
      if (pendingMove?.id === id) preserveMove(pendingMove, "传输已取消，源文件已保留。");
      if (selection?.id === id) {
        deleteSelection(selection);
        picked.current = null;
        setSelection(null);
        setLocked(false);
      }
      list.refresh();
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "取消传输失败，请重试。"));
    } finally {
      setClosing(null);
    }
  }

  const downloadInProgress =
    download !== null && !downloadRetryable && downloadState?.status !== "downloaded";
  async function downloadFile(item: FileHandoffTransfer) {
    if (
      directDownload.current ||
      downloadInProgress ||
      receiptPending ||
      !canUsePanel ||
      !isAppActive() ||
      connection._tag !== "Some"
    )
      return;
    const id = item.id;
    const controller = new AbortController();
    directDownload.current = controller;
    setReceivingId(id);
    setError(null);
    try {
      if (localScreenCapture && !(await localScreenCapture.isUnlocked())) {
        throw new Error("解锁手机后可以接收文件。");
      }
      controller.signal.throwIfAborted();
      const handoffKey = await fileHandoffDownloadKey(environmentId, threadId, item.id);
      const knownSha = item.sha256 ?? item.directSha256;
      const local = knownSha
        ? await readHandoffDownload(handoffKey, item.sizeBytes, knownSha)
        : null;
      if (knownSha && local && (local.status === "downloaded" || local.nativeId)) {
        const saved = {
          id,
          name: item.name,
          sizeBytes: item.sizeBytes,
          sha256: knownSha,
          supportsReceipt: item.expiresAt !== undefined,
          ...(local.uri ? { uri: local.uri } : {}),
          ...(local.nativeId ? { nativeId: local.nativeId } : {}),
        };
        setDownload(saved);
        setDownloadState(local);
        if (local.status === "downloaded" && saved.supportsReceipt) await confirmSaved(saved);
        return;
      }
      if (item.directSha256) {
        if (supportsDirect && !upload.current && !local?.retryable) {
          const cacheFile = new File(Paths.cache, `t3-handoff-${uuidv4()}`);
          try {
            cacheFile.create();
            const handle = cacheFile.open();
            let closed = false;
            let savedUri: string | undefined;
            try {
              const receipt = await receiveDirectFile({
                id,
                item,
                threadId,
                request,
                signal: controller.signal,
                makePeer: directPeer.makePeer,
                write: async (bytes) => handle.writeBytes(bytes),
                publish: async () => {
                  await handle.close();
                  closed = true;
                  savedUri = await saveDirectHandoff(
                    cacheFile.uri,
                    item.name,
                    item.sizeBytes,
                    item.directSha256!,
                    handoffKey,
                  );
                },
              });
              const saved = {
                ...receipt,
                name: item.name,
                supportsReceipt: true,
                ...(savedUri ? { uri: savedUri } : {}),
              };
              downloadsByThread.set(downloadKey, saved);
              setDownload(saved);
              setDownloadState({ status: "downloaded", bytesDownloaded: item.sizeBytes });
              await confirmSaved(saved);
              return;
            } finally {
              if (!closed) await handle.close();
            }
          } catch {
            controller.signal.throwIfAborted();
          } finally {
            try {
              if (cacheFile.exists) cacheFile.delete();
            } catch {
              // 系统会清理临时缓存。
            }
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
      const nativeId = await enqueueFileDownload(
        url,
        result.name,
        result.sizeBytes,
        result.sha256,
        handoffKey,
      );
      setDownloadState(null);
      const next = {
        id,
        nativeId,
        name: item.name,
        sizeBytes: result.sizeBytes,
        sha256: result.sha256,
        supportsReceipt: item.expiresAt !== undefined,
      };
      downloadsByThread.set(downloadKey, next);
      setDownload(next);
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "下载未开始，请重试。"));
    } finally {
      directDownload.current = null;
      setReceivingId(null);
    }
  }

  return (
    <ScrollView className="max-h-80" contentContainerClassName="gap-2 py-2">
      {directPeer.view}
      {list.error && (
        <AppText accessibilityLiveRegion="polite">无法读取传输记录，请检查环境版本和连接。</AppText>
      )}
      {snapshot && localScreenCapture && snapshot.recipients.length > 0 && captureAvailable && (
        <View className="flex-row flex-wrap gap-1">
          {capturePhase === null && (
            <>
              <Button
                size="compact"
                disabled={progress !== null}
                label="截图"
                onPress={() => void capture("screenshot")}
              />
              <Button
                size="compact"
                disabled={progress !== null}
                label="录屏"
                onPress={() => void capture("recording")}
              />
            </>
          )}
          {capturePhase !== null && (
            <Button
              size="compact"
              label={capturePhase === "recording-active" ? "停止录屏" : "取消请求"}
              onPress={() => {
                const requestId = captureRequest.current;
                if (!requestId) return;
                if (capturePhase === "recording-active") {
                  void localScreenCapture?.stopRecording(requestId).catch(() => {});
                } else {
                  void localScreenCapture?.cancelCapture(requestId).catch(() => {});
                }
              }}
            />
          )}
          {capturePhase !== null && (
            <AppText
              accessibilityLiveRegion="polite"
              className="self-center text-xs text-foreground-muted"
            >
              {capturePhase === "recording-active"
                ? "正在录屏，最长 30 秒"
                : "正在等待系统屏幕捕获"}
            </AppText>
          )}
        </View>
      )}
      {canSend && snapshot && snapshot.recipients.length > 0 && (
        <View className="flex-row flex-wrap gap-1">
          <Button
            size="compact"
            disabled={!connected || capturePhase !== null || progress !== null}
            label={selection?.name ?? "选择文件"}
            onPress={() => void pickFile("copy")}
          />
          {localFileMove && (
            <Button
              size="compact"
              disabled={
                !connected || capturePhase !== null || progress !== null || pendingMove !== null
              }
              label="选择要移动的文件"
              onPress={() => void pickFile("move")}
            />
          )}
          {selection && progress === null && (
            <Button
              size="compact"
              tone="text"
              label="清除选择"
              disabled={capturePhase !== null}
              onPress={() => {
                deleteSelection(picked.current);
                picked.current = null;
                setSelection(null);
                setLocked(false);
              }}
            />
          )}
          <Button
            size="compact"
            disabled={!connected || locked}
            label={recipient?.label ?? "选择接收设备"}
            onPress={() => setChoosingRecipient((value) => !value)}
          />
          {progress === null ? (
            <Button
              size="compact"
              tone="primary"
              disabled={!connected || capturePhase !== null || !recipient || !selection}
              label={locked ? "继续上传" : selection?.moveToken ? "移动" : "发送"}
              onPress={() => void send()}
            />
          ) : (
            <Button size="compact" label="暂停上传" onPress={() => upload.current?.abort()} />
          )}
        </View>
      )}
      {moveStatus && <AppText accessibilityLiveRegion="polite">{moveStatus}</AppText>}
      {pendingMove && moveStatus === "等待目标设备保存并校验文件。" && (
        <Button
          size="compact"
          tone="text"
          label="保留源文件"
          onPress={() => preserveMove(pendingMove, "已选择保留源文件。")}
        />
      )}
      {choosingRecipient &&
        !locked &&
        snapshot?.recipients.map((device) => (
          <Button
            key={device.id}
            size="compact"
            label={
              device.label + " · " + (device.online ? "在线" : "离线") + " · " + device.id.slice(-6)
            }
            onPress={() => {
              setRecipient({ id: device.id, label: device.label });
              setChoosingRecipient(false);
            }}
          />
        ))}
      {progress !== null && (
        <AppText accessibilityLiveRegion="polite">
          {transport === "direct" ? "等待直连或正在发送" : "正在中转"} · {progress}%
        </AppText>
      )}
      {error && <AppText accessibilityLiveRegion="polite">{error}</AppText>}
      {receiptPending && download ? (
        <Button
          size="compact"
          label="重试接收回执"
          onPress={() => void confirmSaved({ ...download, ...(savedUri ? { uri: savedUri } : {}) })}
        />
      ) : null}
      {download && (
        <Button
          size="compact"
          label="打开下载目录"
          onPress={() => void showDownloadedFiles().catch(() => setError("无法打开下载目录。"))}
        />
      )}
      {snapshot?.transfers.map((item) => (
        <View key={item.id} className="flex-row items-center gap-2 border-t border-border py-1">
          <View className="flex-1">
            <AppText>{item.name}</AppText>
            <AppText className="text-xs text-foreground-muted">
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
              {item.expiresAt !== undefined && !item.disposition
                ? " · 到期 " + new Date(item.expiresAt).toLocaleString()
                : ""}
            </AppText>
            {item.sha256 && (
              <AppText selectable className="text-xs text-foreground-muted">
                SHA-256 {item.sha256}
              </AppText>
            )}
            {!item.outgoing &&
            !item.urlDownload &&
            item.disposition === "saved" &&
            item.sha256 &&
            item.savedPath &&
            /\.apk$/i.test(item.name) ? (
              <ReceivedApkInstallAction
                name={item.name}
                sizeBytes={item.sizeBytes}
                sha256={item.sha256}
                uri={item.savedPath}
                receiptKey={JSON.stringify([environmentId, threadId, item.id, item.sha256])}
                installation={item.installation}
                onReport={async (installation) => {
                  await request({
                    _tag: "reportInstall",
                    threadId,
                    id: item.id,
                    sha256: item.sha256!,
                    installation,
                  });
                  list.refresh();
                }}
              />
            ) : null}
          </View>
          {item.outgoing && item.expiresAt !== undefined && !item.disposition ? (
            <Button
              size="compact"
              disabled={closing !== null || progress !== null}
              label="取消传输"
              onPress={() => void cancel(item.id)}
            />
          ) : null}
          {!item.outgoing && !item.disposition && (
            <Button
              size="compact"
              disabled={
                !connected ||
                busyDownload ||
                downloadInProgress ||
                receiptPending ||
                (download?.id === item.id && !downloadRetryable)
              }
              label={
                receivingId === item.id
                  ? "正在接收…"
                  : download?.id === item.id
                    ? currentDownloadLabel
                    : item.directSha256
                      ? "直连接收"
                      : "下载"
              }
              onPress={() => void downloadFile(item)}
            />
          )}
        </View>
      ))}
      {canSend && snapshot?.recipients.length === 0 && (
        <AppText>当前没有可发送的其他已配对设备。</AppText>
      )}
      {snapshot?.transfers.length === 0 && <AppText>此会话暂无发送或接收记录。</AppText>}
      <Button size="compact" disabled={list.isPending} label="刷新" onPress={list.refresh} />
    </ScrollView>
  );
}
