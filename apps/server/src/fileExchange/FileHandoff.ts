// @effect-diagnostics nodeBuiltinImport:off -- 保留同步到磁盘的分块位置，重启后可从已持久化的字节继续。
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FILE_HANDOFF_CHUNK_BYTES,
  FILE_HANDOFF_ROUTE_PREFIX,
  FileHandoffError,
  type AuthClientSession,
  type FileHandoffReply,
  type FileHandoffRequest,
  type FileHandoffStart,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const UPLOAD_LINK_TTL_MS = 60 * 60 * 1000;
const MAX_TRANSFERS_PER_THREAD = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const THREAD_KEY_PATTERN = /^[0-9a-f]{64}$/;
const activeWrites = new Set<string>();

interface HandoffRecord {
  readonly id: string;
  readonly sender: string;
  readonly recipient: string;
  readonly senderLabel: string;
  readonly recipientLabel: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
  readonly expectedSha256: string;
  readonly sha256: string | null;
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function transferDirectory(root: string, threadId: ThreadId) {
  return join(root, createHash("sha256").update(threadId).digest("hex"));
}

function recordPath(directory: string, id: string) {
  return join(directory, `${id}.json`);
}

function contentsPath(directory: string, id: string) {
  return join(directory, `${id}.bytes`);
}

async function readRecord(directory: string, id: string): Promise<HandoffRecord | null> {
  try {
    return JSON.parse(await fs.readFile(recordPath(directory, id), "utf8")) as HandoffRecord;
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

async function readRecords(directory: string) {
  const files = await fs.readdir(directory).catch((cause) => {
    if (isMissing(cause)) return [];
    throw cause;
  });
  return (
    await Promise.all(
      files
        .filter((name) => name.endsWith(".json") && UUID_PATTERN.test(name.slice(0, -5)))
        .map((name) => readRecord(directory, name.slice(0, -5))),
    )
  ).filter((record) => record !== null);
}

async function writeRecord(directory: string, record: HandoffRecord) {
  const temp = join(directory, `${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, JSON.stringify(record), { flag: "wx", flush: true, mode: 0o600 });
    await fs.rename(temp, recordPath(directory, record.id));
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function receivedBytes(directory: string, id: string) {
  try {
    return (await fs.stat(contentsPath(directory, id))).size;
  } catch (cause) {
    if (isMissing(cause)) return 0;
    throw cause;
  }
}

async function complete(directory: string, record: HandoffRecord) {
  const path = contentsPath(directory, record.id);
  if (record.sizeBytes === 0) {
    const file = await fs.open(path, "a", 0o600);
    await file.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (sha256 !== record.expectedSha256) {
    await fs.rm(path, { force: true });
    return false;
  }
  await writeRecord(directory, { ...record, sha256 });
  return true;
}

function label(session: AuthClientSession) {
  const { client } = session;
  return [client.label ?? client.browser ?? client.os ?? "已配对设备", client.os, client.browser]
    .filter((item, index, values) => item && values.indexOf(item) === index)
    .join(" · ");
}

function eligible(
  session: AuthClientSession,
  scope:
    | typeof AuthOrchestrationReadScope
    | typeof AuthOrchestrationOperateScope = AuthOrchestrationReadScope,
) {
  return session.scopes.includes(scope) && session.client.deviceType !== "bot";
}

function failure(message: string) {
  return new FileHandoffError({ message });
}

function storage<T>(operation: () => Promise<T>) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      Schema.is(FileHandoffError)(cause) ? cause : failure("无法读写文件传输记录。"),
  });
}

const issueUrl = Effect.fn("FileHandoff.issueUrl")(function* (
  mode: "upload" | "receive",
  directory: string,
  record: HandoffRecord,
) {
  const signer = yield* AssetSigner.AssetSigner;
  const now = yield* Clock.currentTimeMillis;
  const expiresAt = Math.min(
    record.expiresAt,
    mode === "upload" ? now + UPLOAD_LINK_TTL_MS : record.expiresAt,
  );
  const threadKey = directory.split(/[\\/]/).at(-1);
  const payload = `handoff.${mode}.${threadKey}.${record.id}.${expiresAt}`;
  const signature = yield* signer
    .sign(payload)
    .pipe(Effect.mapError(() => failure("无法创建文件传输链接。")));
  return `${FILE_HANDOFF_ROUTE_PREFIX}/${payload}.${signature}`;
});

const configuration = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return join(config.stateDir, "file-handoff");
});

const authorizedClients = Effect.gen(function* () {
  return yield* (yield* EnvironmentAuth.EnvironmentAuth)
    .listSessions()
    .pipe(Effect.mapError(() => failure("当前无法读取已配对设备。")));
});

let nextSweepAt = 0;
async function sweepExpired(root: string, now: number) {
  if (now < nextSweepAt) return;
  nextSweepAt = now + 15 * 60 * 1000;
  for (const key of await fs.readdir(root)) {
    if (!THREAD_KEY_PATTERN.test(key)) continue;
    const directory = join(root, key);
    for (const record of await readRecords(directory)) {
      const marker = recordPath(directory, record.id);
      if (record.expiresAt > now || activeWrites.has(marker)) continue;
      await fs.rm(contentsPath(directory, record.id), { force: true });
      await fs.rm(marker, { force: true });
    }
  }
}

export const startFileHandoff = Effect.fn("FileHandoff.start")(function* (
  input: FileHandoffStart,
  session: EnvironmentAuth.AuthenticatedSession,
) {
  if (
    !UUID_PATTERN.test(input.id) ||
    /^[. ]+$|[\\/\x00-\x1f\x7f]/u.test(input.name) ||
    input.recipient === session.sessionId
  ) {
    return yield* failure("文件名或设备选择无效。");
  }

  const sessions = yield* authorizedClients;
  const sender = sessions.find((item) => item.sessionId === session.sessionId);
  const recipient = sessions.find((item) => item.sessionId === input.recipient);
  if (!sender || !recipient || !eligible(recipient)) {
    return yield* failure("接收设备的授权已失效，请重新选择。");
  }
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => failure("无法读取附件大小限制。")),
  );
  if (input.sizeBytes > settings.attachmentMaxFileSizeMiB * 1024 * 1024) {
    return yield* failure(`文件超过 ${settings.attachmentMaxFileSizeMiB} MiB 上传上限。`);
  }

  const now = yield* Clock.currentTimeMillis;
  const root = yield* configuration;
  const directory = transferDirectory(root, input.threadId);
  const record = yield* storage(async () => {
    const marker = recordPath(directory, input.id);
    if (activeWrites.has(marker)) throw failure("文件正在写入，请稍后续传。");
    activeWrites.add(marker);
    try {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await sweepExpired(root, now);
      const existing = await readRecord(directory, input.id);
      if (existing) {
        if (
          existing.sender !== session.sessionId ||
          existing.recipient !== input.recipient ||
          existing.name !== input.name ||
          existing.sizeBytes !== input.sizeBytes ||
          existing.expectedSha256 !== input.sha256 ||
          existing.expiresAt <= now
        ) {
          throw failure("文件传输已经过期或资料发生变化，请重新选择文件。");
        }
        return existing;
      }
      const records = await readRecords(directory);
      if (records.filter((entry) => entry.expiresAt > now).length >= MAX_TRANSFERS_PER_THREAD) {
        throw failure("此会话的文件传输记录已满。");
      }
      const created: HandoffRecord = {
        id: input.id,
        sender: sender.sessionId,
        recipient: recipient.sessionId,
        senderLabel: label(sender),
        recipientLabel: label(recipient),
        name: input.name,
        sizeBytes: input.sizeBytes,
        expectedSha256: input.sha256,
        expiresAt: now + RETENTION_MS,
        sha256: null,
      };
      await writeRecord(directory, created);
      return created;
    } finally {
      activeWrites.delete(marker);
    }
  });
  const offset = yield* storage(() => receivedBytes(directory, record.id));
  return {
    relativeUrl: yield* issueUrl("upload", directory, record),
    offset,
    ready: record.sha256 !== null,
  };
});

export const readFileHandoff = Effect.fn("FileHandoff.read")(function* (
  input: FileHandoffRequest,
  session: EnvironmentAuth.AuthenticatedSession,
) {
  const sessions = yield* authorizedClients;
  const root = yield* configuration;
  const directory = transferDirectory(root, input.threadId);
  const now = yield* Clock.currentTimeMillis;
  if (input._tag === "list") {
    const records = yield* storage(() => readRecords(directory));
    return {
      _tag: "list",
      transfers: records
        .filter(
          (entry) =>
            entry.expiresAt > now &&
            (entry.sender === session.sessionId ||
              (entry.recipient === session.sessionId && entry.sha256 !== null)),
        )
        .sort((left, right) => right.expiresAt - left.expiresAt)
        .map(({ id, name, senderLabel, recipientLabel, sizeBytes, sha256, sender }) => ({
          id,
          name,
          senderLabel,
          recipientLabel,
          sizeBytes,
          sha256,
          outgoing: sender === session.sessionId,
        })),
      recipients: session.scopes.includes(AuthOrchestrationOperateScope)
        ? sessions
            .filter((entry) => entry.sessionId !== session.sessionId && eligible(entry))
            .map((entry) => ({ id: entry.sessionId, label: label(entry), online: entry.connected }))
        : [],
    } satisfies FileHandoffReply;
  }

  const record = yield* storage(() => readRecord(directory, input.id));
  if (
    !record ||
    record.recipient !== session.sessionId ||
    !record.sha256 ||
    record.expiresAt <= now
  ) {
    return yield* failure("该文件已过期、尚未上传完毕或不属于当前设备。");
  }
  return {
    _tag: "receive",
    relativeUrl: yield* issueUrl("receive", directory, record),
    name: record.name,
    sizeBytes: record.sizeBytes,
    sha256: record.sha256,
  } satisfies FileHandoffReply;
});

export const resolveFileHandoff = Effect.fn("FileHandoff.resolve")(function* (
  token: string,
  expectedMode: "upload" | "receive",
) {
  const now = yield* Clock.currentTimeMillis;
  const [namespace, mode, threadKey, id, expiry, signature, unexpected] = token.split(".");
  if (
    namespace !== "handoff" ||
    mode !== expectedMode ||
    !threadKey ||
    !THREAD_KEY_PATTERN.test(threadKey) ||
    !id ||
    !UUID_PATTERN.test(id) ||
    !expiry ||
    !/^\d{13}$/.test(expiry) ||
    Number(expiry) <= now ||
    !signature ||
    unexpected !== undefined
  ) {
    return null;
  }
  const signer = yield* AssetSigner.AssetSigner;
  const verified = yield* signer
    .verify(`handoff.${mode}.${threadKey}.${id}.${expiry}`, signature)
    .pipe(Effect.mapError(() => failure("无法验证文件传输链接。")));
  if (!verified) return null;
  const directory = join(yield* configuration, threadKey);
  const record = yield* storage(() => readRecord(directory, id));
  if (!record || record.expiresAt <= now) return null;
  const sessionId = mode === "upload" ? record.sender : record.recipient;
  const client = (yield* authorizedClients).find((item) => item.sessionId === sessionId);
  if (
    !client ||
    !eligible(
      client,
      mode === "upload" ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope,
    )
  ) {
    return null;
  }
  return { directory, record, path: contentsPath(directory, id) };
});

export const receiveFileHandoffChunk = Effect.fn("FileHandoff.receiveChunk")(function* (
  transfer: NonNullable<Effect.Success<ReturnType<typeof resolveFileHandoff>>>,
  offset: number,
  body: HttpServerRequest.HttpServerRequest["stream"],
) {
  const { directory, record, path } = transfer;
  const marker = recordPath(directory, record.id);
  if (activeWrites.has(marker)) {
    return HttpServerResponse.empty({ status: 409 });
  }
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      activeWrites.add(marker);
    }),
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const current = yield* storage(() => readRecord(directory, record.id));
        if (!current || current.expiresAt <= now) {
          return HttpServerResponse.empty({ status: 404 });
        }
        if (current.sha256 !== null) return HttpServerResponse.empty({ status: 204 });
        const persisted = yield* storage(() => receivedBytes(directory, record.id));
        if (offset !== persisted || offset > record.sizeBytes) {
          return HttpServerResponse.empty({ status: 409 });
        }
        const expectedBytes = Math.min(FILE_HANDOFF_CHUNK_BYTES, record.sizeBytes - offset);
        const buffer = new Uint8Array(expectedBytes);
        let length = 0;
        yield* body.pipe(
          Stream.takeWhile((part) => {
            const start = length;
            length += part.byteLength;
            if (length > expectedBytes) return false;
            buffer.set(part, start);
            return true;
          }),
          Stream.runDrain,
        );
        if (length !== expectedBytes) return HttpServerResponse.empty({ status: 400 });
        const completed = yield* Effect.uninterruptible(
          storage(async () => {
            if (length > 0) {
              const file = await fs.open(path, "a", 0o600);
              try {
                await file.writeFile(buffer);
                await file.sync();
              } finally {
                await file.close();
              }
            }
            return offset + expectedBytes < record.sizeBytes || complete(directory, current);
          }),
        );
        return HttpServerResponse.empty({ status: completed ? 204 : 422 });
      }),
    () =>
      Effect.sync(() => {
        activeWrites.delete(marker);
      }),
  );
});
