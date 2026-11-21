// @effect-diagnostics nodeBuiltinImport:off - Position writes and sync are required for durable range checkpoints.
// @effect-diagnostics globalTimers:off - Reset the request idle deadline as long as bytes keep arriving.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const WORKERS = 4;
const MIN_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENTS = 256;
const IDLE_TIMEOUT = 30_000;

interface DownloadProgress {
  readonly receivedBytes: number;
  readonly totalBytes: number;
}

interface DownloadOptions {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly url: string;
  readonly destination: string;
  /** Stable and on the same volume as the destination. */
  readonly stagingDirectory: string;
  /** Stable source namespace across refreshed signed URLs. */
  readonly source: string;
  readonly headers?: Headers;
  readonly signal: AbortSignal;
  readonly checksums?: ReadonlyArray<{
    readonly algorithm: "sha256" | "sha512";
    readonly expectedHex: string;
  }>;
  readonly onProgress: (progress: DownloadProgress) => void;
}

export function downloadKey(value: string): string {
  return NodeCrypto.createHash("sha256").update(value).digest("hex");
}

function contentLength(response: Response): number | undefined {
  const value = response.headers.get("content-length");
  if (value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
    return Number(value);
  }
}

function hasIdentityEncoding(response: Response): boolean {
  const encoding = response.headers.get("content-encoding");
  return encoding === null || encoding.toLowerCase() === "identity";
}

function strongETag(response: Response): string | undefined {
  const tag = response.headers.get("etag");
  return tag !== null && /^"[^"]*"$/.test(tag) ? tag : undefined;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await NodeFSP.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writeSynced(path: string, value: string): Promise<void> {
  const file = await NodeFSP.open(path, "w", 0o600);
  try {
    await file.writeFile(value, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

// A failed request must release its response and stop every worker before a retry can open the partial file.
async function withResponse<A>(
  options: DownloadOptions,
  signal: AbortSignal,
  headers: Headers,
  handle: (response: Response, activity: () => void, signal: AbortSignal) => Promise<A>,
): Promise<A> {
  const idle = new AbortController();
  const requestSignal = AbortSignal.any([signal, idle.signal]);
  const abortForIdle = () => idle.abort(new Error("The download stopped receiving data."));
  let timer = setTimeout(abortForIdle, IDLE_TIMEOUT);
  const activity = () => {
    clearTimeout(timer);
    timer = setTimeout(abortForIdle, IDLE_TIMEOUT);
  };
  let response: Response | undefined;
  try {
    requestSignal.throwIfAborted();
    response = await options.fetch(options.url, { headers, signal: requestSignal });
    activity();
    return await handle(response, activity, requestSignal);
  } finally {
    clearTimeout(timer);
    await response?.body?.cancel().catch(() => undefined);
  }
}

async function writeBody(
  response: Response,
  file: NodeFSP.FileHandle,
  start: number,
  expected: number | undefined,
  signal: AbortSignal,
  onChunk: (bytes: number) => void,
): Promise<number> {
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        if (expected !== undefined && received + value.byteLength > expected) {
          throw new Error("The download returned more bytes than expected.");
        }
        let written = 0;
        while (written < value.byteLength) {
          const { bytesWritten } = await file.write(
            value,
            written,
            value.byteLength - written,
            start + received + written,
          );
          if (bytesWritten === 0) throw new Error("Could not write the download to disk.");
          written += bytesWritten;
        }
        received += value.byteLength;
        onChunk(value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
  }
  signal.throwIfAborted();
  if (expected !== undefined && received !== expected) {
    throw new Error("The download ended before all bytes were received.");
  }
  return received;
}

async function checkIntegrity(partialPath: string, options: DownloadOptions): Promise<void> {
  const checksums = options.checksums ?? [];
  if (checksums.length === 0) return;
  const hashes = checksums.map(({ algorithm }) => NodeCrypto.createHash(algorithm));
  for await (const chunk of NodeFS.createReadStream(partialPath, { signal: options.signal })) {
    for (const hash of hashes) hash.update(chunk);
  }
  if (hashes.some((hash, index) => hash.digest("hex") !== checksums[index]?.expectedHex)) {
    await NodeFSP.rm(options.stagingDirectory, { recursive: true, force: true });
    throw new Error("The download checksum does not match the update manifest.");
  }
}

const rangeUnavailable = new Error("The server did not send the requested byte range.");

async function downloadSegments(
  options: DownloadOptions,
  headers: Headers,
  partialPath: string,
  totalBytes: number,
  tag: string | undefined,
): Promise<void> {
  const segmentBytes = Math.max(MIN_SEGMENT_BYTES, Math.ceil(totalBytes / MAX_SEGMENTS));
  const segmentCount = Math.ceil(totalBytes / segmentBytes);
  const versionPath = NodePath.join(options.stagingDirectory, "version");
  // Use an opaque key so signed URLs and ETags are never stored on disk.
  const version = downloadKey(
    JSON.stringify([1, options.source, totalBytes, segmentBytes, tag, options.checksums]),
  );
  const checkpoint = (index: number) => NodePath.join(options.stagingDirectory, `done-${index}`);
  const existing = await NodeFSP.stat(partialPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const resume = existing?.size === totalBytes && (await readIfPresent(versionPath)) === version;
  if (!resume) {
    await NodeFSP.rm(options.stagingDirectory, { recursive: true, force: true });
    await NodeFSP.mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
  }
  const partial = await NodeFSP.open(partialPath, resume ? "r+" : "wx", 0o600);
  try {
    if (!resume) {
      await partial.truncate(totalBytes);
      await partial.sync();
      await writeSynced(versionPath, version);
    }
    const pending: number[] = [];
    let receivedBytes = 0;
    const length = (index: number) => Math.min(segmentBytes, totalBytes - index * segmentBytes);
    const saved = resume ? new Set(await NodeFSP.readdir(options.stagingDirectory)) : new Set();
    for (let index = 0; index < segmentCount; index += 1) {
      if (saved.has(`done-${index}`)) receivedBytes += length(index);
      else pending.push(index);
    }
    options.onProgress({ receivedBytes, totalBytes });

    const transfer = new AbortController();
    const signal = AbortSignal.any([options.signal, transfer.signal]);
    let next = 0;
    const work = async () => {
      while (next < pending.length) {
        signal.throwIfAborted();
        const index = pending[next++]!;
        const start = index * segmentBytes;
        const count = length(index);
        const end = start + count - 1;
        const rangeHeaders = new Headers(headers);
        rangeHeaders.set("range", `bytes=${start}-${end}`);
        if (tag !== undefined) rangeHeaders.set("if-range", tag);
        await withResponse(options, signal, rangeHeaders, async (response, activity, request) => {
          if (response.status === 200 || response.status === 416) throw rangeUnavailable;
          if (response.status !== 206)
            throw new Error(`Download returned HTTP ${response.status}.`);
          if (
            response.headers.get("content-range") !== `bytes ${start}-${end}/${totalBytes}` ||
            !hasIdentityEncoding(response)
          ) {
            throw rangeUnavailable;
          }
          if (tag !== undefined && strongETag(response) !== tag) {
            throw new Error("The download changed while it was being transferred.");
          }
          await writeBody(response, partial, start, count, request, (bytes) => {
            activity();
            receivedBytes += bytes;
            options.onProgress({ receivedBytes, totalBytes });
          });
        });
        await partial.sync();
        await writeSynced(checkpoint(index), "");
      }
    };
    await Promise.allSettled(
      Array.from({ length: Math.min(WORKERS, pending.length) }, async () => {
        try {
          await work();
        } catch (error) {
          transfer.abort(error);
        }
      }),
    );
    signal.throwIfAborted();
  } finally {
    await partial.close();
  }
}

async function downloadWhole(
  options: DownloadOptions,
  partialPath: string,
  response: Response,
  activity: () => void,
  signal: AbortSignal,
): Promise<void> {
  if (response.status !== 200) throw new Error(`Download returned HTTP ${response.status}.`);
  await NodeFSP.rm(options.stagingDirectory, { recursive: true, force: true });
  await NodeFSP.mkdir(options.stagingDirectory, { recursive: true, mode: 0o700 });
  const total = hasIdentityEncoding(response) ? contentLength(response) : undefined;
  const partial = await NodeFSP.open(partialPath, "wx", 0o600);
  let receivedBytes = 0;
  try {
    options.onProgress({ receivedBytes, totalBytes: total ?? 0 });
    await writeBody(response, partial, 0, total, signal, (bytes) => {
      activity();
      receivedBytes += bytes;
      options.onProgress({ receivedBytes, totalBytes: total ?? 0 });
    });
    await partial.sync();
  } finally {
    await partial.close();
  }
}

export async function downloadToFile(options: DownloadOptions): Promise<void> {
  const partialPath = NodePath.join(options.stagingDirectory, "data.part");
  const headers = new Headers(options.headers);
  headers.set("accept-encoding", "identity");
  const probeHeaders = new Headers(headers);
  probeHeaders.set("range", "bytes=0-0");
  const probe = await withResponse(
    options,
    options.signal,
    probeHeaders,
    async (response, activity, signal) => {
      if (response.status === 200) {
        await downloadWhole(options, partialPath, response, activity, signal);
        return "complete" as const;
      }
      if (response.status === 416 && response.headers.get("content-range") === "bytes */0") {
        return null;
      }
      if (response.status !== 206) throw new Error(`Download returned HTTP ${response.status}.`);
      const size = /^bytes 0-0\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
      const totalBytes = Number(size);
      const tag = strongETag(response);
      return totalBytes > 0 &&
        Number.isSafeInteger(totalBytes) &&
        hasIdentityEncoding(response) &&
        (tag !== undefined || Boolean(options.checksums?.length))
        ? { totalBytes, tag }
        : null;
    },
  );

  if (probe && probe !== "complete") {
    try {
      await downloadSegments(options, headers, partialPath, probe.totalBytes, probe.tag);
    } catch (error) {
      if (error !== rangeUnavailable) throw error;
      await withResponse(options, options.signal, headers, async (response, activity, signal) => {
        if (
          response.status === 200 &&
          probe.tag !== undefined &&
          strongETag(response) !== probe.tag &&
          !options.checksums?.length
        ) {
          throw new Error("The download changed while it was being transferred.", { cause: error });
        }
        await downloadWhole(options, partialPath, response, activity, signal);
      });
    }
  } else if (probe !== "complete") {
    await withResponse(options, options.signal, headers, (response, activity, signal) =>
      downloadWhole(options, partialPath, response, activity, signal),
    );
  }
  await checkIntegrity(partialPath, options);
  options.signal.throwIfAborted();
  await NodeFSP.rename(partialPath, options.destination);
  await NodeFSP.rm(options.stagingDirectory, { recursive: true, force: true }).catch(
    () => undefined,
  );
}
