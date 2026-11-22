import {
  FILE_HANDOFF_CHUNK_BYTES,
  WS_METHODS,
  type EnvironmentId,
  type FileHandoffStart,
} from "@t3tools/contracts";
import { createSha256 } from "@t3tools/shared/sha256";
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
    AtomCommandResult<{ relativeUrl: string; offset: number; ready: boolean }, unknown>
  >;
  readonly slice: (offset: number, length: number) => Promise<Chunk>;
  readonly post: (
    url: string,
    body: Chunk,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; status: number }>;
  readonly signal: AbortSignal;
  readonly onProgress: (offset: number) => void;
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

  // 最后一个分块的响应丢失时，使用同一传输编号补交完成请求。
  let offset = result.offset;
  do {
    if (signal.aborted) throw new Error("上传已暂停。");
    const length = Math.min(FILE_HANDOFF_CHUNK_BYTES, input.sizeBytes - offset);
    const chunk = await options.slice(offset, length);
    const url = new URL(uploadUrl);
    url.searchParams.set("offset", String(offset));
    const response = await options.post(url.href, chunk, signal);
    if (!response.ok) throw new Error(`上传中断（HTTP ${response.status}），请点击继续上传。`);
    offset += length;
    onProgress(offset);
  } while (offset < input.sizeBytes);
}

export function fileHandoffErrorMessage(error: unknown, fallback: string) {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : fallback;
}
