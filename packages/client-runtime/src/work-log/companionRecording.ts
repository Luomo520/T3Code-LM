import { readImageDimensions } from "@t3tools/shared/imageDimensions";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import type { companionRecordingOutput } from "./itemDetail.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FRAMES = 64;
const FRAME_MS = 200;
const MOVIE_OFFSET = 224;

export type CompanionRecording = NonNullable<ReturnType<typeof companionRecordingOutput>>;
export type CompanionRecordingFailure = "expired" | "unavailable";

export const companionRecordingFailureText: Record<CompanionRecordingFailure, string> = {
  expired: "录像链接已过期，请在此会话重新获取录像。",
  unavailable: "无法播放录像，请检查连接后重试。",
};

export interface CompanionRecordingFrame {
  readonly uri: string;
  readonly width: number;
  readonly height: number;
}

export function isCompanionMp4(recording: CompanionRecording): boolean {
  return recording.url?.endsWith(".mp4") === true;
}

export async function resolveCompanionMp4Url(
  recording: CompanionRecording,
  httpBaseUrl: string | null,
  refresh: (() => Promise<string | null>) | undefined,
): Promise<string | null> {
  if (!httpBaseUrl) return null;
  const renewed = recording.resource && refresh ? await refresh().catch(() => null) : null;
  const renewedUrl = renewed && companionRecordingUrl(renewed, httpBaseUrl, "mp4");
  if (renewedUrl) return renewedUrl;
  return recording.url &&
    recording.expiresAt !== null &&
    recording.expiresAt > Effect.runSync(Clock.currentTimeMillis)
    ? companionRecordingUrl(recording.url, httpBaseUrl, "mp4")
    : null;
}

function companionRecordingUrl(
  url: string,
  httpBaseUrl: string,
  extension: "avi" | "mp4" = "avi",
): string | null {
  // 只加载与当前会话连接绑定的服务端签名路径。
  const path =
    /^(?:https?:\/\/[^/?#]+)?(\/api\/assets\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/[a-f0-9-]{36}\.(?:avi|mp4))$/u.exec(
      url,
    )?.[1];
  if (!path?.endsWith(`.${extension}`)) return null;
  try {
    const base = new URL(httpBaseUrl);
    if (base.protocol !== "https:" && base.protocol !== "http:") return null;
    return new URL(path, base).href;
  } catch {
    return null;
  }
}

function parseCompanionRecording(bytes: Uint8Array) {
  if (bytes.length < MOVIE_OFFSET + 8 || bytes.length > MAX_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const four = (offset: number, expected: string) =>
    expected
      .split("")
      .every((character, index) => bytes[offset + index] === character.charCodeAt(0));

  // 这里匹配 ScreenRecording 写出的单流 MJPEG 布局，包含 movi 和最终索引。
  if (
    !four(0, "RIFF") ||
    u32(4) !== bytes.length - 8 ||
    !four(8, "AVI ") ||
    !four(12, "LIST") ||
    u32(16) !== 192 ||
    !four(20, "hdrl") ||
    !four(24, "avih") ||
    u32(28) !== 56 ||
    u32(32) !== FRAME_MS * 1000 ||
    u32(56) !== 1 ||
    !four(88, "LIST") ||
    u32(92) !== 116 ||
    !four(96, "strl") ||
    !four(100, "strh") ||
    u32(104) !== 56 ||
    !four(108, "vids") ||
    !four(112, "MJPG") ||
    u32(128) !== 1 ||
    u32(132) !== 1000 / FRAME_MS ||
    !four(164, "strf") ||
    u32(168) !== 40 ||
    u32(172) !== 40 ||
    !four(188, "MJPG") ||
    !four(212, "LIST") ||
    !four(220, "movi")
  ) {
    return null;
  }
  const width = u32(64);
  const height = u32(68);
  const frameCount = u32(48);
  if (
    width === 0 ||
    width > 640 ||
    height === 0 ||
    height > 4096 ||
    u32(176) !== width ||
    u32(180) !== height ||
    frameCount === 0 ||
    frameCount > MAX_FRAMES ||
    frameCount !== u32(140)
  ) {
    return null;
  }
  const end = 220 + u32(216);
  if (
    end < MOVIE_OFFSET ||
    end + 8 + frameCount * 16 !== bytes.length ||
    !four(end, "idx1") ||
    u32(end + 4) !== frameCount * 16
  ) {
    return null;
  }

  const frames: Uint8Array[] = [];
  let offset = MOVIE_OFFSET;
  for (let index = 0; index < frameCount; index++) {
    if (offset + 8 > end || !four(offset, "00dc")) return null;
    const size = u32(offset + 4);
    const jpegEnd = offset + 8 + size;
    const entry = end + 8 + index * 16;
    if (
      size < 4 ||
      jpegEnd + (size % 2) > end ||
      !four(entry, "00dc") ||
      u32(entry + 8) !== offset - 220 ||
      u32(entry + 12) !== size
    ) {
      return null;
    }
    const frame = bytes.subarray(offset + 8, jpegEnd);
    if (frame[0] !== 0xff || frame[1] !== 0xd8 || frame.at(-2) !== 0xff || frame.at(-1) !== 0xd9) {
      return null;
    }
    const dimensions = readImageDimensions(frame);
    if (dimensions?.width !== width || dimensions.height !== height) return null;
    frames.push(frame);
    offset = jpegEnd + (size % 2);
  }
  return offset === end ? { frames, width, height } : null;
}

type RecordingFetch = (
  url: string,
  init: {
    readonly signal: AbortSignal;
    readonly credentials: "omit";
    readonly redirect: "error";
  },
) => Promise<Pick<Response, "ok" | "body" | "headers">>;

async function readRecording(response: Awaited<ReturnType<RecordingFetch>>) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  try {
    const length = Number(response.headers.get("content-length"));
    if (!response.ok || length > MAX_BYTES) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return parseCompanionRecording(bytes);
  } finally {
    void reader.cancel().catch(() => {});
  }
}

export async function playCompanionRecording(input: {
  readonly recording: CompanionRecording;
  readonly httpBaseUrl: string | null;
  readonly signal: AbortSignal;
  readonly fetch: RecordingFetch;
  readonly refresh?: (() => Promise<string | null>) | undefined;
  readonly onFrame: (frame: CompanionRecordingFrame) => void;
}): Promise<CompanionRecordingFailure | null> {
  const { recording, httpBaseUrl, signal, onFrame } = input;
  const expired = () =>
    recording.expiresAt !== null && recording.expiresAt <= Effect.runSync(Clock.currentTimeMillis);
  if (signal.aborted) return null;
  const refreshed =
    recording.resource && input.refresh ? await input.refresh().catch(() => null) : null;
  if (signal.aborted) return null;
  const renewedUrl = refreshed && httpBaseUrl && companionRecordingUrl(refreshed, httpBaseUrl);
  const oldUrl = recording.url && httpBaseUrl && companionRecordingUrl(recording.url, httpBaseUrl);
  if (!renewedUrl && expired()) return "expired";
  const url = renewedUrl || (recording.expiresAt !== null ? oldUrl : null);
  if (!url) return "unavailable";
  try {
    const response = await input.fetch(url, { signal, credentials: "omit", redirect: "error" });
    const movie = await readRecording(response);
    if (!movie) return !renewedUrl && expired() ? "expired" : "unavailable";
    const { width, height } = movie;
    for (const frame of movie.frames) {
      if (signal.aborted) break;
      onFrame({ uri: `data:image/jpeg;base64,${Base64.encode(frame)}`, width, height });
      await Effect.runPromise(Effect.sleep(FRAME_MS), { signal });
    }
    return null;
  } catch {
    return signal.aborted ? null : !renewedUrl && expired() ? "expired" : "unavailable";
  }
}
