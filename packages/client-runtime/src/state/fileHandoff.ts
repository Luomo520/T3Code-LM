import {
  FILE_HANDOFF_CHUNK_BYTES,
  WS_METHODS,
  type EnvironmentId,
  type FileHandoffRequest,
  type FileHandoffReply,
  type FileHandoffStart,
  type FileHandoffTransfer,
} from "@t3tools/contracts";
import { createSha256 } from "@t3tools/shared/sha256";
import { trySendDirectFile, type OpenHandoffPeer } from "./fileHandoffDirect.ts";
export { receiveDirectFile, waitForRelayedHandoff } from "./fileHandoffDirect.ts";
export type { HandoffFrame, HandoffPeer, OpenHandoffPeer } from "./fileHandoffDirect.ts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { resolveAssetUrl } from "./assets.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  type AtomCommandResult,
  squashAtomCommandFailure,
} from "./runtime.ts";

export function createFileHandoffAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "file-handoff:list",
      tag: WS_METHODS.fileHandoffRead,
      idleTtlMs: 0,
      staleTimeMs: 0,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "file-handoff:start",
      tag: WS_METHODS.fileHandoffStart,
    }),
    receive: createEnvironmentRpcCommand(runtime, {
      label: "file-handoff:receive",
      tag: WS_METHODS.fileHandoffRead,
    }),
  };
}

export function unwrapFileHandoff<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw squashAtomCommandFailure(result);
}

type Chunk = Uint8Array<ArrayBuffer>;

export async function sendHandoffFile(options: {
  readonly httpBaseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly input: Omit<FileHandoffStart, "sha256">;
  readonly start: (target: {
    environmentId: EnvironmentId;
    input: FileHandoffStart;
  }) => Promise<
    AtomCommandResult<
      { relativeUrl: string; offset: number; ready: boolean; direct?: boolean },
      unknown
    >
  >;
  readonly slice: (offset: number, length: number) => Promise<Chunk>;
  readonly post: (
    url: string,
    body: Chunk,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; status: number }>;
  readonly signal: AbortSignal;
  readonly onProgress: (offset: number) => void;
  readonly direct?: {
    readonly makePeer: OpenHandoffPeer;
    readonly request: (input: FileHandoffRequest) => Promise<FileHandoffReply>;
    readonly onFallback?: () => void;
  };
}) {
  const { environmentId, input, signal, onProgress } = options;
  const hash = createSha256();
  for (let offset = 0; offset < input.sizeBytes; offset += FILE_HANDOFF_CHUNK_BYTES) {
    signal.throwIfAborted();
    const length = Math.min(FILE_HANDOFF_CHUNK_BYTES, input.sizeBytes - offset);
    const chunk = await options.slice(offset, length);
    if (chunk.byteLength !== length) throw new Error("源文件已变化，请重新选择。");
    hash.update(chunk);
  }
  signal.throwIfAborted();
  const result = unwrapFileHandoff(
    await options.start({ environmentId, input: { ...input, sha256: hash.digestHex() } }),
  );
  const uploadUrl = resolveAssetUrl(options.httpBaseUrl, result.relativeUrl);
  if (!uploadUrl || result.offset > input.sizeBytes) throw new Error("文件传输进度无效。");
  onProgress(result.offset);
  if (result.ready) return;
  if (options.direct) {
    const direct = options.direct;
    if (result.direct) {
      if (
        await trySendDirectFile({ ...input, ...direct, signal, slice: options.slice, onProgress })
      )
        return;
      const abandoned = await direct
        .request({ _tag: "directAbandon", threadId: input.threadId, id: input.id })
        .catch(() => null);
      if (abandoned?._tag === "direct" && abandoned.state === "saved") return;
      onProgress(result.offset);
    }
    direct.onFallback?.();
  }

  // 最后一个分块的响应丢失时，使用同一传输编号补交完成请求。
  let offset = result.offset;
  do {
    if (signal.aborted) throw new Error("上传已暂停。");
    const length = Math.min(FILE_HANDOFF_CHUNK_BYTES, input.sizeBytes - offset);
    const chunk = await options.slice(offset, length);
    const url = new URL(uploadUrl);
    url.searchParams.set("offset", String(offset));
    const response = await options.post(url.href, chunk, signal);
    if (!response.ok) {
      const state = await options.direct
        ?.request({ _tag: "directStatus", threadId: input.threadId, id: input.id })
        .catch(() => null);
      if (state?._tag === "direct" && state.state === "saved") return;
      throw new Error(`上传中断（HTTP ${response.status}），请点击继续上传。`);
    }
    offset += length;
    onProgress(offset);
  } while (offset < input.sizeBytes);
}

export function formatFileHandoffReceipt(
  file: Pick<
    FileHandoffTransfer,
    "disposition" | "name" | "recipientLabel" | "savedPath" | "installation"
  >,
): string | null {
  if (file.disposition === "cancelled") return `${file.name} 的传输已取消。`;
  if (file.disposition !== "saved") return null;
  const saved = `${file.recipientLabel} 已保存并校验 ${file.name}${file.savedPath ? `，保存到 ${file.savedPath}` : ""}。`;
  const install = file.installation;
  if (install?.status === "verified")
    return `${saved}已核验安装 ${install.packageName} ${install.version}（${install.versionCode}）。`;
  if (install?.status === "cancelled") return `${saved}已取消安装，文件已保留。`;
  return saved;
}

export function fileHandoffErrorMessage(error: unknown, fallback: string) {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : fallback;
}
