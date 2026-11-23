import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  FileHandoffInboxTransfer,
  FileHandoffReply,
  FileHandoffRequest,
} from "@t3tools/contracts";

import {
  enqueueFileDownload,
  fileHandoffDownloadKey,
  readHandoffDownload,
} from "../../lib/systemFileDownload";

const processing = new Set<string>();

export async function advanceAutomaticHandoff(
  item: FileHandoffInboxTransfer,
  options: {
    readonly environmentId: EnvironmentId;
    readonly httpBaseUrl: string;
    readonly active: () => boolean;
    readonly request: (input: FileHandoffRequest) => Promise<FileHandoffReply>;
  },
): Promise<"saved" | "waiting"> {
  if (item.autoReceive !== true || !options.active() || item.expiresAt <= Date.now())
    return "waiting";
  const id = item.id;
  const threadId = item.threadId;
  const key = await fileHandoffDownloadKey(options.environmentId, threadId, id);
  if (processing.has(key)) return "waiting";
  processing.add(key);
  try {
    const local = await readHandoffDownload(key, item.sizeBytes, item.sha256);
    if (!options.active()) return "waiting";
    if (local?.status === "downloaded" && local.uri) {
      const receipt = await options.request({
        _tag: "confirmSaved",
        threadId,
        id,
        sizeBytes: item.sizeBytes,
        sha256: item.sha256,
        savedPath: local.uri,
      });
      return receipt._tag === "finished" && receipt.disposition === "saved" ? "saved" : "waiting";
    }
    if (local?.nativeId) return "waiting";

    const release = await options.request({ _tag: "receive", threadId, id });
    if (!options.active()) return "waiting";
    if (
      release._tag !== "receive" ||
      release.sizeBytes !== item.sizeBytes ||
      release.sha256 !== item.sha256
    ) {
      throw new Error("待保存文件的大小或 SHA-256 已发生变化。");
    }
    const url = resolveAssetUrl(options.httpBaseUrl, release.relativeUrl);
    if (!url) throw new Error("接收文件的下载地址无效。");
    await enqueueFileDownload(url, release.name, release.sizeBytes, release.sha256, key, true);
    return "waiting";
  } finally {
    processing.delete(key);
  }
}
