import type { DesktopFileDownloadEvent } from "@t3tools/contracts";
import { toastManager } from "~/components/ui/toast";

const downloads = new Map<string, ReturnType<typeof toastManager.add>>();
let listening = false;
export function observeFileDownloads() {
  const bridge = window.desktopBridge;
  if (listening || !bridge?.onFileDownload) return;
  listening = true;
  bridge.onFileDownload((event: DesktopFileDownloadEvent) => {
    const done = event.state === "completed";
    const failed = event.state === "interrupted";
    const cancelled = event.state === "cancelled";
    const terminal = done || failed || cancelled;
    const progress =
      event.totalBytes > 0
        ? `${Math.floor((event.receivedBytes / event.totalBytes) * 100)}%`
        : `${(event.receivedBytes / 1048576).toFixed(1)} MB`;
    const options = {
      type: done ? "success" : failed ? "error" : cancelled ? "info" : "loading",
      title: done ? "下载完成" : failed ? "下载中断" : cancelled ? "下载已取消" : "正在下载",
      description: `${event.fileName}${terminal ? "" : ` · ${progress}`}${failed ? "。请检查网络、剩余空间和文件是否变化，然后重新点击下载。" : ""}`,
      timeout: terminal ? 8000 : 0,
      actionProps: terminal
        ? undefined
        : {
            children: "取消",
            onClick: () => {
              void bridge.cancelFileDownload?.(event.id);
            },
          },
    };
    const existing = downloads.get(event.id);
    if (existing) toastManager.update(existing, options);
    else downloads.set(event.id, toastManager.add(options));
    if (terminal) downloads.delete(event.id);
  });
}

export async function startFileDownload(file: { url: string; fileName: string }): Promise<void> {
  const response = await fetch(file.url, { method: "HEAD", cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      response.status === 403
        ? "大文件仅支持局域网直接下载，请连接局域网后重试。"
        : response.status === 409
          ? "文件已变化，请重新点击下载。"
          : "下载文件暂不可用，请检查文件、权限及网络后重试。",
    );
  }
  const bridge = window.desktopBridge;
  if (bridge?.downloadFile) {
    observeFileDownloads();
    const result = await bridge.downloadFile(file);
    if (result.method === "idm")
      toastManager.add({
        type: "info",
        title: "已提交 IDM",
        description: "请在 IDM 中确认保存位置和查看进度。",
      });
    return;
  }
  if (bridge) {
    if (!(await bridge.openExternal(file.url)))
      throw new Error("无法打开系统浏览器，请更新桌面客户端后重试。");
  } else {
    const anchor = document.createElement("a");
    anchor.href = file.url;
    anchor.download = file.fileName;
    anchor.rel = "noopener noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }
  toastManager.add({
    type: "info",
    title: "已提交浏览器下载",
    description: "请在浏览器下载列表查看进度。",
  });
}

export async function startVerifiedDesktopDownload(file: {
  url: string;
  fileName: string;
  sha256: string;
}) {
  const bridge = window.desktopBridge;
  if (!bridge?.downloadFile || !bridge.onFileDownload) {
    await startFileDownload(file);
    return null;
  }
  observeFileDownloads();
  const terminal = new Map<string, DesktopFileDownloadEvent>();
  let selectedId: string | undefined;
  let announce: ((event: DesktopFileDownloadEvent) => void) | undefined;
  const unsubscribe = bridge.onFileDownload((event) => {
    if (event.state === "progressing") return;
    if (selectedId === undefined) terminal.set(event.id, event);
    else if (event.id === selectedId) announce?.(event);
  });
  try {
    const result = await bridge.downloadFile({ url: file.url, fileName: file.fileName });
    if (result.method === "cancelled") return null;
    if (result.method !== "builtin" || result.id === undefined) return null;
    selectedId = result.id;
    const event =
      terminal.get(selectedId) ??
      (await new Promise<DesktopFileDownloadEvent>((resolve) => {
        announce = resolve;
      }));
    if (event.state === "interrupted") throw new Error("下载或校验中断，请重试。");
    if (event.state !== "completed") return null;
    if (event.verifiedSha256 !== file.sha256) {
      throw new Error("下载器未提供一致的 SHA-256 校验证明，无法确认接收。");
    }
    return event;
  } finally {
    unsubscribe();
  }
}
