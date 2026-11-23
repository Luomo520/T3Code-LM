// @effect-diagnostics globalTimers:off -- 浏览器和 Android WebView 的 Promise 与 AbortSignal 共用这一组协商时限。
import {
  type FileHandoffReply,
  type FileHandoffRequest,
  type FileHandoffTransfer,
  type ThreadId,
} from "@t3tools/contracts";
import { createSha256 } from "@t3tools/shared/sha256";

type Signal = (input: FileHandoffRequest) => Promise<FileHandoffReply>;
type DirectScope = {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly signal: AbortSignal;
  readonly request: Signal;
};

export type HandoffFrame = string | Uint8Array<ArrayBuffer>;
export interface HandoffPeer {
  offer(): Promise<string>;
  answer(offer: string): Promise<string>;
  finish(answer: string): Promise<void>;
  open(): Promise<void>;
  send(frame: HandoffFrame): Promise<void>;
  next(): Promise<HandoffFrame>;
  close(): void;
}
export type OpenHandoffPeer = (signal: AbortSignal) => HandoffPeer;

const DIRECT_CHUNK = 32 * 1024;
const NEXT = "next";
const DONE = "done";

async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 450);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForPeer(
  scope: DirectScope,
  phase: "offer" | "answer" | "saved",
): Promise<string> {
  while (true) {
    scope.signal.throwIfAborted();
    const state = await scope.request({
      _tag: "directStatus",
      threadId: scope.threadId,
      id: scope.id,
    });
    if (state._tag !== "direct" || state.state === "closed") throw new Error("直连已结束。");
    if (state.state === "saved") return "";
    if (phase !== "saved" && state[phase]) return state[phase]!;
    await pause(scope.signal);
  }
}

export async function trySendDirectFile(
  options: DirectScope & {
    readonly makePeer: OpenHandoffPeer;
    readonly sizeBytes: number;
    readonly slice: (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>;
    readonly onProgress: (offset: number) => void;
  },
): Promise<boolean> {
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  const { signal } = controller;
  const scope = { ...options, signal };
  const timer = setTimeout(() => controller.abort(new Error("等待接收设备直连超时。")), 45_000);
  let peer: HandoffPeer | undefined;
  try {
    options.signal.throwIfAborted();
    const offer = await waitForPeer(scope, "offer");
    if (offer === "") return true;
    peer = options.makePeer(signal);
    const sdp = await peer.answer(offer);
    const result = await options.request({
      _tag: "directAnswer",
      threadId: options.threadId,
      id: options.id,
      sdp,
    });
    if (result._tag !== "direct" || result.state !== "active") return false;
    await peer.open();
    clearTimeout(timer);
    let offset = 0;
    while (offset < options.sizeBytes) {
      if ((await peer.next()) !== NEXT) throw new Error("接收设备未请求剩余文件。");
      const length = Math.min(DIRECT_CHUNK, options.sizeBytes - offset);
      const chunk = await options.slice(offset, length);
      if (chunk.length !== length) throw new Error("源文件已变化，请重新选择。");
      await peer.send(chunk);
      offset += chunk.length;
      options.onProgress(offset);
    }
    if ((await peer.next()) !== NEXT) throw new Error("接收设备未确认文件结束。");
    await peer.send(DONE);
    // 接收端先落盘再提交回执。收到了全部字节仍可能保存失败。
    const receiptTimeout = setTimeout(
      () => controller.abort(new Error("等待保存回执超时。")),
      30_000,
    );
    try {
      await waitForPeer(scope, "saved");
      return true;
    } finally {
      clearTimeout(receiptTimeout);
    }
  } catch {
    options.signal.throwIfAborted();
    return false;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    peer?.close();
  }
}

export async function receiveDirectFile(
  options: DirectScope & {
    readonly item: FileHandoffTransfer;
    readonly makePeer: OpenHandoffPeer;
    readonly write: (chunk: Uint8Array<ArrayBuffer>) => Promise<void>;
    readonly publish: () => Promise<void>;
    readonly onProgress?: (bytes: number) => void;
  },
) {
  const sha256 = options.item.directSha256;
  if (!sha256) throw new Error("该传输无法直连。");
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener("abort", abort, { once: true });
  const scope = { ...options, signal: controller.signal };
  const timer = setTimeout(() => controller.abort(new Error("直连协商超时。")), 12_000);
  let peer: HandoffPeer | undefined;
  try {
    options.signal.throwIfAborted();
    peer = options.makePeer(scope.signal);
    const sdp = await peer.offer();
    const result = await options.request({
      _tag: "directOffer",
      threadId: options.threadId,
      id: options.id,
      sdp,
    });
    if (result._tag !== "direct" || result.state !== "active")
      throw new Error("发送设备已改用中转。");
    await peer.finish(await waitForPeer(scope, "answer"));
    await peer.open();
    clearTimeout(timer);
    const hash = createSha256();
    let offset = 0;
    for (;;) {
      await peer.send(NEXT);
      const frame = await peer.next();
      if (frame === DONE) break;
      if (
        typeof frame === "string" ||
        frame.length === 0 ||
        frame.length > DIRECT_CHUNK ||
        offset + frame.length > options.item.sizeBytes
      ) {
        throw new Error("收到的文件大小或分块与传输记录不符。");
      }
      hash.update(frame);
      await options.write(frame);
      offset += frame.length;
      options.onProgress?.(offset);
    }
    if (offset !== options.item.sizeBytes || hash.digestHex() !== sha256) {
      throw new Error("收到的文件大小或 SHA-256 与传输记录不符。");
    }
    options.signal.throwIfAborted();
    await options.publish();
    return { id: options.id, sizeBytes: offset, sha256 };
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    peer?.close();
  }
}

/** 直连结束后沿用同一记录等待中转文件可领取，同时保留页面离开时的取消行为。 */
export async function waitForRelayedHandoff(
  options: DirectScope,
): Promise<Extract<FileHandoffReply, { _tag: "receive" }>> {
  for (let attempt = 0; attempt < 45; attempt++) {
    options.signal.throwIfAborted();
    const result = await options
      .request({ _tag: "receive", threadId: options.threadId, id: options.id })
      .catch(() => null);
    if (result?._tag === "receive") return result;
    await pause(options.signal);
  }
  throw new Error("正在改用中转，上传完成后可继续领取该文件。");
}
