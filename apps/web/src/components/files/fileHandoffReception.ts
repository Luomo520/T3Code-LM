import type {
  EnvironmentId,
  FileHandoffReply,
  FileHandoffRequest,
  ThreadId,
} from "@t3tools/contracts";
import { FILE_HANDOFF_ROUTE_PREFIX } from "@t3tools/contracts";
import { createFileHandoffAtoms } from "@t3tools/client-runtime/state/fileHandoff";
import { connectionAtomRuntime } from "~/connection/runtime";
import {
  observeFileDownloads,
  startFileDownload,
  startVerifiedDesktopDownload,
} from "~/lib/fileDownload";
import { createSha256 } from "@t3tools/shared/sha256";

export type SavePicker = (options: {
  readonly suggestedName: string;
}) => Promise<FileSystemFileHandle>;

export async function saveBrowserHandoff(
  url: string,
  file: FileSystemFileHandle,
  sizeBytes: number,
  sha256: string,
) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok || !response.body) throw new Error("无法读取文件，请重试。");
  const reader = response.body.getReader();
  const target = await file.createWritable();
  const hash = createSha256();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > sizeBytes) throw new Error("收到的文件大小与传输记录不符。");
      hash.update(value);
      await target.write(value);
    }
    if (received !== sizeBytes || hash.digestHex() !== sha256)
      throw new Error("文件 SHA-256 或大小校验失败，请重试。");
    await target.close();
  } catch (error) {
    await target.abort().catch(() => undefined);
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const fileHandoffAtoms = createFileHandoffAtoms(connectionAtomRuntime);
export const quietFileHandoff = { reportFailure: false, reportDefect: false };

interface IncomingFile {
  readonly id: string;
  readonly name: string;
  readonly sha256: string | null;
  readonly sizeBytes: number;
}

export interface ReceiptTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly file: IncomingFile;
}

type Receipt =
  | { readonly state: "working" | "downloaded" | "failed" }
  | { readonly state: "receipt" | "saved"; readonly savedPath?: string };

const receipts = new Map<string, Receipt>();
const listeners = new Set<() => void>();

function receiptKey(target: ReceiptTarget): string {
  return JSON.stringify([target.environmentId, target.threadId, target.file.id]);
}

export function readFileReceipt(target: ReceiptTarget): Receipt | null {
  return receipts.get(receiptKey(target)) ?? null;
}

export function subscribeFileReceipts(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setReceipt(target: ReceiptTarget, value: Receipt) {
  const key = receiptKey(target);
  receipts.delete(key);
  receipts.set(key, value);
  if (receipts.size > 1024) {
    const removable = [...receipts].find(
      ([, receipt]) =>
        receipt.state === "downloaded" || receipt.state === "saved" || receipt.state === "failed",
    );
    if (removable) receipts.delete(removable[0]);
  }
  for (const listener of listeners) listener();
}

export async function receiveAgentFile(
  input: ReceiptTarget & {
    readonly request: (input: FileHandoffRequest) => Promise<FileHandoffReply>;
    readonly httpBaseUrl: string;
    readonly automatic: boolean;
    readonly retry?: boolean;
    readonly desktop?: boolean;
  },
) {
  const previous = readFileReceipt(input);
  if (
    !input.file.sha256 ||
    previous?.state === "working" ||
    previous?.state === "saved" ||
    (!input.retry && (previous?.state === "failed" || previous?.state === "downloaded"))
  )
    return;

  const { id, name, sha256, sizeBytes } = input.file;
  setReceipt(input, { state: "working" });
  let verified: { savedPath?: string } | null =
    previous?.state === "receipt"
      ? previous.savedPath
        ? { savedPath: previous.savedPath }
        : {}
      : null;
  try {
    if (!verified) {
      const desktop = window.desktopBridge;
      const picker = (window as Window & { showSaveFilePicker?: SavePicker }).showSaveFilePicker;
      const destination =
        !input.automatic && !input.desktop && !desktop && picker
          ? await picker.call(window, { suggestedName: name })
          : null;
      const result = await input.request({ _tag: "receive", threadId: input.threadId, id });
      if (
        result._tag !== "receive" ||
        result.sha256 !== sha256 ||
        result.sizeBytes !== sizeBytes ||
        !result.relativeUrl.startsWith(FILE_HANDOFF_ROUTE_PREFIX + "/")
      )
        throw new Error("文件与传输记录不符。");
      const url = new URL(result.relativeUrl, input.httpBaseUrl).href;
      if ((input.automatic || input.desktop) && desktop?.downloadHandoffFile) {
        observeFileDownloads();
        verified = await desktop.downloadHandoffFile({
          url,
          fileName: result.name,
          transferId: id,
          sizeBytes,
          sha256,
        });
      } else if (destination) {
        await saveBrowserHandoff(url, destination, sizeBytes, sha256);
        verified = {};
      } else if (desktop?.downloadFile && desktop.onFileDownload) {
        const event = await startVerifiedDesktopDownload({ url, fileName: result.name });
        if (!event) throw new Error("文件未保存。");
        verified = event.savedPath ? { savedPath: event.savedPath } : {};
      } else {
        await startFileDownload({ url, fileName: result.name });
        setReceipt(input, { state: "downloaded" });
        return;
      }
    }
    const reply = await input.request({
      _tag: "confirmSaved",
      threadId: input.threadId,
      id,
      sizeBytes,
      sha256,
      ...verified,
    });
    if (reply._tag !== "finished" || reply.disposition !== "saved")
      throw new Error("文件回执暂不可用。");
    setReceipt(input, { state: "saved", ...verified });
  } catch {
    setReceipt(input, verified ? { state: "receipt", ...verified } : { state: "failed" });
  }
}
