import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  createFileHandoffAtoms,
  fileHandoffErrorMessage,
  sendHandoffFile,
  unwrapFileHandoff,
} from "@t3tools/client-runtime/state/fileHandoff";
import {
  AuthOrchestrationReadScope,
  type AuthSessionId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { getDocumentAsync } from "expo-document-picker";
import { fetch } from "expo/fetch";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";

import { connectionAtomRuntime } from "../../connection/runtime";
import {
  enqueueFileDownload,
  readFileDownload,
  showDownloadedFiles,
  type FileDownload,
} from "../../lib/systemFileDownload";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

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
          <FileHandoffContents {...context} />
        </View>
      )}
    </View>
  );
}

type Selection = { readonly file: File; readonly id: string; readonly name: string };

function deleteSelection(selection: Selection | null) {
  try {
    if (selection?.file.exists) selection.file.delete();
  } catch {
    // 文档选择器的暂存副本失效时，由系统清理缓存。
  }
}

function FileHandoffContents({ environmentId, threadId }: Context) {
  const connection = usePreparedConnection(environmentId);
  const list = useEnvironmentQuery(
    atoms.list({ environmentId, input: { _tag: "list", threadId } }),
  );
  const start = useAtomCommand(atoms.start, quiet);
  const receive = useAtomCommand(atoms.receive, quiet);
  const [recipient, setRecipient] = useState<{ id: AuthSessionId; label: string } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [locked, setLocked] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [download, setDownload] = useState<{ id: string; nativeId: string } | null>(null);
  const [downloadState, setDownloadState] = useState<FileDownload | null>(null);
  const [busyDownload, setBusyDownload] = useState(false);
  const [choosingRecipient, setChoosingRecipient] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const picked = useRef<Selection | null>(null);
  const snapshot = list.data?._tag === "list" ? list.data : null;

  useEffect(
    () => () => {
      const controller = upload.current;
      controller?.abort();
      if (!controller) deleteSelection(picked.current);
    },
    [],
  );

  useEffect(() => {
    if (download === null) return;
    let subscribed = true;
    const refresh = () => {
      void readFileDownload(download.nativeId)
        .then((status) => {
          if (!subscribed) return;
          setDownloadState(status);
          if (status?.status === "failed") setError(status.error ?? "下载中断，可继续下载。");
          if (status && ["failed", "cancelled", "downloaded"].includes(status.status))
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
  }, [download]);

  const downloadRetryable =
    downloadState?.status === "failed" || downloadState?.status === "cancelled";
  const currentDownloadLabel =
    downloadState?.status === "downloaded"
      ? "已保存"
      : downloadRetryable
        ? "继续下载"
        : downloadState?.status === "paused"
          ? "等待连接"
          : "已下载 " + (downloadState?.bytesDownloaded.toLocaleString() ?? "0") + " 字节";

  async function pickFile() {
    if (upload.current) return;
    try {
      const result = await getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const next = { file: new File(asset.uri), id: uuidv4(), name: asset.name };
      deleteSelection(picked.current);
      picked.current = next;
      setSelection(next);
      setLocked(false);
      setError(null);
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "无法读取选中的文件。"));
    }
  }

  async function send() {
    if (!selection || !recipient || upload.current || connection._tag !== "Some") return;
    const controller = new AbortController();
    upload.current = controller;
    setProgress(0);
    setLocked(true);
    setError(null);
    const { file, name, id } = selection;
    try {
      const handle = file.open();
      try {
        const sizeBytes = handle.size;
        if (sizeBytes === null) throw new Error("无法读取文件大小，请重新选择。");
        await sendHandoffFile({
          environmentId,
          httpBaseUrl: connection.value.httpBaseUrl,
          start,
          input: { threadId, id, recipient: recipient.id, sizeBytes, name },
          slice: async (offset, length) => {
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
      } finally {
        handle.close();
      }
      deleteSelection(selection);
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

  async function downloadFile(id: string) {
    if (busyDownload || connection._tag !== "Some") return;
    setBusyDownload(true);
    setError(null);
    try {
      const result = unwrapFileHandoff(
        await receive({ environmentId, input: { _tag: "receive", threadId, id } }),
      );
      if (result._tag !== "receive") throw new Error("无法领取该文件。");
      const url = resolveAssetUrl(connection.value.httpBaseUrl, result.relativeUrl);
      if (!url) throw new Error("下载地址无效，请重试。");
      const nativeId = await enqueueFileDownload(url, result.name, result.sizeBytes, result.sha256);
      setDownloadState(null);
      setDownload({ id, nativeId });
    } catch (cause) {
      setError(fileHandoffErrorMessage(cause, "下载未开始，请重试。"));
    } finally {
      setBusyDownload(false);
    }
  }

  return (
    <ScrollView className="max-h-80" contentContainerClassName="gap-2 py-2">
      {list.error && (
        <AppText accessibilityLiveRegion="polite">无法读取传输记录，请检查环境版本和连接。</AppText>
      )}
      {snapshot && snapshot.recipients.length > 0 && (
        <View className="flex-row flex-wrap gap-1">
          <Button
            size="compact"
            disabled={progress !== null}
            label={selection?.name ?? "选择文件"}
            onPress={() => void pickFile()}
          />
          <Button
            size="compact"
            disabled={locked}
            label={recipient?.label ?? "选择接收设备"}
            onPress={() => setChoosingRecipient((value) => !value)}
          />
          {progress === null ? (
            <Button
              size="compact"
              tone="primary"
              disabled={!recipient || !selection}
              label={locked ? "继续上传" : "发送"}
              onPress={() => void send()}
            />
          ) : (
            <Button size="compact" label="暂停上传" onPress={() => upload.current?.abort()} />
          )}
        </View>
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
      {progress !== null && <AppText accessibilityLiveRegion="polite">已上传 {progress}%</AppText>}
      {error && <AppText accessibilityLiveRegion="polite">{error}</AppText>}
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
              {item.outgoing ? (item.sha256 ? " · 可领取" : " · 等待上传") : ""}
            </AppText>
            {item.sha256 && (
              <AppText selectable className="text-xs text-foreground-muted">
                SHA-256 {item.sha256}
              </AppText>
            )}
          </View>
          {!item.outgoing && (
            <Button
              size="compact"
              disabled={busyDownload || (download?.id === item.id && !downloadRetryable)}
              label={download?.id === item.id ? currentDownloadLabel : "下载"}
              onPress={() => void downloadFile(item.id)}
            />
          )}
        </View>
      ))}
      {snapshot?.recipients.length === 0 && <AppText>当前没有可发送的其他已配对设备。</AppText>}
      {snapshot?.transfers.length === 0 && <AppText>此会话暂无发送或接收记录。</AppText>}
      <Button size="compact" disabled={list.isPending} label="刷新" onPress={list.refresh} />
    </ScrollView>
  );
}
