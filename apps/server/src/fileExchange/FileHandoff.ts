// @effect-diagnostics nodeBuiltinImport:off -- 保留同步到磁盘的分块位置，重启后可从已持久化的字节继续。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FILE_HANDOFF_CHUNK_BYTES,
  FILE_HANDOFF_ROUTE_PREFIX,
  FileHandoffError,
  type AuthClientSession,
  type AuthSessionId,
  type FileHandoffInstallation,
  type FileHandoffReply,
  type FileHandoffInboxTransfer,
  type FileHandoffRequest,
  type FileHandoffStart,
  type FileHandoffUrlDownload,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as AssetSigner from "../assets/AssetSigner.ts";
import { externalDownloadMaxBytes } from "../assets/downloadNetworkPolicy.ts";
import type { OpenMediaFile } from "../assets/MediaFile.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import {
  activeDirectHandoff,
  allowsDirectHandoff,
  beginDirectHandoff,
  closeDirectHandoff,
  isDirectHandoffRequest,
  signalDirectHandoff,
} from "./FileHandoffDirect.ts";

import {
  indexFileHandoff,
  indexedFileHandoffs,
  removeFromFileHandoffInbox,
} from "./FileHandoffInbox.ts";
import { fetchRemoteFile, remoteFileName, remoteFileUrl } from "./RemoteFileDownload.ts";

const MAX_INBOX_RESULTS = 100;
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
  readonly disposition?: "saved" | "cancelled";
  readonly serverStaged?: true;
  readonly sourceUrl?: string;
  readonly urlFailure?: string;
  readonly autoReceive?: true;
  readonly directNegotiated?: true;
  readonly savedPath?: string;
  readonly installRequested?: true;
  readonly installation?: FileHandoffInstallation;
  readonly requesterAlias?: string;
  readonly sourceOrdinal?: number;
  readonly claimed?: true;
  readonly deliveryRevision?: string;
  readonly management?: { readonly requestId: string; readonly ordinal: number };
}

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function transferDirectory(root: string, threadId: ThreadId) {
  return NodePath.join(root, NodeCrypto.createHash("sha256").update(threadId).digest("hex"));
}

function recordPath(directory: string, id: string) {
  return NodePath.join(directory, `${id}.json`);
}

function contentsPath(directory: string, id: string) {
  return NodePath.join(directory, `${id}.bytes`);
}

async function readRecord(directory: string, id: string): Promise<HandoffRecord | null> {
  try {
    return JSON.parse(await NodeFSP.readFile(recordPath(directory, id), "utf8")) as HandoffRecord;
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
}

async function readRecords(directory: string) {
  const files = await NodeFSP.readdir(directory).catch((cause) => {
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
  const temp = NodePath.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
  try {
    await NodeFSP.writeFile(temp, JSON.stringify(record), { flag: "wx", flush: true, mode: 0o600 });
    await NodeFSP.rename(temp, recordPath(directory, record.id));
  } finally {
    await NodeFSP.rm(temp, { force: true });
  }
}

async function receivedBytes(directory: string, id: string) {
  try {
    return (await NodeFSP.stat(contentsPath(directory, id))).size;
  } catch (cause) {
    if (isMissing(cause)) return 0;
    throw cause;
  }
}

async function complete(directory: string, record: HandoffRecord) {
  const path = contentsPath(directory, record.id);
  if (record.sizeBytes === 0) {
    const file = await NodeFSP.open(path, "a", 0o600);
    await file.close();
  }
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  if (sha256 !== record.expectedSha256) {
    await NodeFSP.rm(path, { force: true });
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

const isHandoffError = Schema.is(FileHandoffError);

function storage<T>(operation: () => Promise<T>) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => (isHandoffError(cause) ? cause : failure("无法读写文件传输记录。")),
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
    .sign(
      mode === "receive" && record.deliveryRevision
        ? `${payload}.${record.deliveryRevision}`
        : payload,
    )
    .pipe(Effect.mapError(() => failure("无法创建文件传输链接。")));
  return `${FILE_HANDOFF_ROUTE_PREFIX}/${payload}.${signature}`;
});

const configuration = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  return NodePath.join(config.stateDir, "file-handoff");
});

const authorizedClients = Effect.gen(function* () {
  return yield* (yield* EnvironmentAuth.EnvironmentAuth)
    .listSessions()
    .pipe(Effect.mapError(() => failure("当前无法读取已配对设备。")));
});

async function sweepExpired(root: string, now: number) {
  const keys = await NodeFSP.readdir(root).catch((cause) => {
    if (isMissing(cause)) return [];
    throw cause;
  });
  for (const key of keys) {
    if (!THREAD_KEY_PATTERN.test(key)) continue;
    const directory = NodePath.join(root, key);
    for (const record of await readRecords(directory)) {
      const marker = recordPath(directory, record.id);
      if (activeWrites.has(marker) || (!record.disposition && record.expiresAt > now)) continue;
      activeWrites.add(marker);
      try {
        await NodeFSP.rm(contentsPath(directory, record.id), { force: true });
        if (record.serverStaged && record.autoReceive) {
          await removeFromFileHandoffInbox(root, record.recipient, key, record.id);
        }
        if (record.expiresAt <= now) {
          await NodeFSP.rm(marker, { force: true });
          closeDirectHandoff(marker);
        }
      } finally {
        activeWrites.delete(marker);
      }
    }
  }
}

export const sweepFileHandoffs = Effect.fn("FileHandoff.sweep")(function* () {
  const root = yield* configuration;
  const now = yield* Clock.currentTimeMillis;
  yield* storage(() => sweepExpired(root, now));
});

export const layerCleanup = Layer.effectDiscard(
  forkParked(
    sweepFileHandoffs().pipe(
      Effect.catch((cause) => Effect.logWarning("Failed to clean up file handoffs.", { cause })),
      Effect.repeat(Schedule.spaced("15 minutes")),
    ),
  ),
);

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
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await readRecord(directory, input.id);
      if (existing) {
        if (
          existing.sender !== session.sessionId ||
          existing.recipient !== input.recipient ||
          existing.name !== input.name ||
          existing.sizeBytes !== input.sizeBytes ||
          existing.expectedSha256 !== input.sha256 ||
          existing.disposition !== undefined ||
          existing.expiresAt <= now
        ) {
          throw failure("文件传输已经过期或资料发生变化，请重新选择文件。");
        }
        return existing;
      }
      const records = await readRecords(directory);
      if (
        records.filter((entry) => entry.expiresAt > now && !entry.disposition).length >=
        MAX_TRANSFERS_PER_THREAD
      ) {
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
      if (input.direct && allowsDirectHandoff(sender, recipient)) beginDirectHandoff(marker, now);
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
    ...(activeDirectHandoff(recordPath(directory, input.id), now) ? { direct: true } : {}),
  };
});

// 会话资源由服务端保存，允许发起设备同时是接收设备。
export const stageThreadFileHandoff = Effect.fn("FileHandoff.stageThreadFile")(function* (input: {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly requester: AuthSessionId;
  readonly requesterAlias?: string;
  readonly sourceOrdinal?: number;
  readonly recipient: AuthSessionId;
  readonly name: string;
  readonly sourcePath: string;
  readonly sourceFile?: OpenMediaFile;
  readonly autoReceive?: true;
  readonly expectedSourceSha256?: string;
  readonly installRequested?: true;
}) {
  const name = Array.from(input.name.replace(/[\\/\x00-\x1f\x7f]/gu, "_").trim())
    .slice(0, 240)
    .join("");
  if (!UUID_PATTERN.test(input.id) || !name || /^[. ]+$/u.test(name)) {
    return yield* failure("文件名或传输编号无效。");
  }
  const sessions = yield* authorizedClients;
  const sender = sessions.find((session) => session.sessionId === input.requester);
  const recipient = sessions.find((session) => session.sessionId === input.recipient);
  if (
    !sender ||
    !recipient ||
    !eligible(sender, AuthOrchestrationOperateScope) ||
    !eligible(recipient)
  ) {
    return yield* failure("接收设备的授权已失效，请重新选择。");
  }
  if (
    input.installRequested &&
    (!name.toLowerCase().endsWith(".apk") ||
      recipient.client.browser !== undefined ||
      recipient.client.os?.toLowerCase() !== "android")
  ) {
    return yield* failure("只有发送到 Android 客户端的 APK 可以请求安装确认。");
  }
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => failure("无法读取附件大小限制。")),
  );
  const maxBytes = settings.attachmentMaxFileSizeMiB * 1024 * 1024;
  const now = yield* Clock.currentTimeMillis;
  const root = yield* configuration;
  const directory = transferDirectory(root, input.threadId);
  return yield* storage(async () => {
    const marker = recordPath(directory, input.id);
    if (activeWrites.has(marker)) throw failure("该文件正在准备，请稍后查询。");
    activeWrites.add(marker);
    const staging = NodePath.join(directory, `${input.id}.stage`);
    try {
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
      const existing = await readRecord(directory, input.id);
      if (existing) {
        if (
          !existing.serverStaged ||
          (existing.sender !== input.requester &&
            (input.requesterAlias === undefined ||
              existing.requesterAlias !== input.requesterAlias)) ||
          (existing.recipient !== input.recipient && existing.management === undefined)
        ) {
          throw failure("文件传输资料发生变化，请重新选择设备。");
        }
        if (existing.autoReceive && !existing.disposition && existing.expiresAt > now) {
          await indexFileHandoff(root, existing.recipient, NodePath.basename(directory), {
            threadId: input.threadId,
            id: existing.id,
            expiresAt: existing.expiresAt,
          });
        }
        return threadFileHandoffStatus(existing);
      }
      const records = await readRecords(directory);
      if (
        records.filter((entry) => entry.expiresAt > now && !entry.disposition).length >=
        MAX_TRANSFERS_PER_THREAD
      ) {
        throw failure("此会话的文件传输记录已满。");
      }
      const source =
        input.sourceFile?.handle ??
        (await NodeFSP.open(
          input.sourcePath,
          NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
        ));
      let sizeBytes = 0;
      const hash = NodeCrypto.createHash("sha256");
      try {
        const initial = input.sourceFile?.info ?? (await source.stat({ bigint: true }));
        if (!initial.isFile() || initial.size > BigInt(maxBytes))
          throw failure("文件不可读取或超过附件大小上限。");
        await NodeFSP.rm(staging, { force: true });
        const output = await NodeFSP.open(staging, "wx", 0o600);
        try {
          const buffer = Buffer.alloc(FILE_HANDOFF_CHUNK_BYTES);
          let bytesRead: number;
          do {
            ({ bytesRead } = await source.read(buffer, 0, buffer.length, sizeBytes));
            if (bytesRead === 0) break;
            sizeBytes += bytesRead;
            if (sizeBytes > maxBytes) throw failure("文件超过附件大小上限。");
            const bytes = buffer.subarray(0, bytesRead);
            hash.update(bytes);
            await output.writeFile(bytes);
          } while (bytesRead > 0);
          const current = await source.stat({ bigint: true });
          if (
            current.size !== BigInt(sizeBytes) ||
            current.mtimeNs !== initial.mtimeNs ||
            current.ctimeNs !== initial.ctimeNs
          ) {
            throw failure("文件正在变化，请稍后重试。");
          }
          await output.sync();
        } finally {
          await output.close();
        }
      } finally {
        if (!input.sourceFile) await source.close();
      }
      const sha256 = hash.digest("hex");
      if (input.expectedSourceSha256 !== undefined && sha256 !== input.expectedSourceSha256) {
        throw failure("文件与设备回传时的 SHA-256 不符。");
      }
      const record: HandoffRecord = {
        id: input.id,
        sender: sender.sessionId,
        recipient: recipient.sessionId,
        senderLabel: "会话文件",
        ...(input.requesterAlias === undefined ? {} : { requesterAlias: input.requesterAlias }),
        ...(input.sourceOrdinal === undefined ? {} : { sourceOrdinal: input.sourceOrdinal }),
        recipientLabel: label(recipient),
        name,
        sizeBytes,
        expectedSha256: sha256,
        expiresAt: now + RETENTION_MS,
        sha256,
        serverStaged: true,
        ...(input.autoReceive === true ? { autoReceive: true } : {}),
        ...(input.installRequested === true ? { installRequested: true } : {}),
      };
      // 收件箱查阅时核对原记录，因此重启前仅写入的索引条目不会变成待收文件。
      if (record.autoReceive) {
        await indexFileHandoff(root, record.recipient, NodePath.basename(directory), {
          threadId: input.threadId,
          id: record.id,
          expiresAt: record.expiresAt,
        });
      }
      await NodeFSP.rename(staging, contentsPath(directory, input.id));
      await writeRecord(directory, record);
      return threadFileHandoffStatus(record);
    } finally {
      await NodeFSP.rm(staging, { force: true });
      activeWrites.delete(marker);
    }
  });
});

export const stageThreadUrlDownload = Effect.fn("FileHandoff.stageThreadUrlDownload")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly id: string;
    readonly requester: AuthSessionId;
    readonly requesterAlias: string;
    readonly sourceOrdinal: number;
    readonly recipient: AuthSessionId;
    readonly sourceUrl: string;
  }) {
    if (!UUID_PATTERN.test(input.id)) return yield* failure("文件传输编号无效。");
    const url = yield* Effect.try({
      try: () => remoteFileUrl(input.sourceUrl),
      catch: (error) => (isHandoffError(error) ? error : failure("下载网址格式无效。")),
    });
    const sessions = yield* authorizedClients;
    const sender = sessions.find((session) => session.sessionId === input.requester);
    const recipient = sessions.find((session) => session.sessionId === input.recipient);
    if (
      !sender ||
      !recipient ||
      !eligible(sender, AuthOrchestrationOperateScope) ||
      !eligible(recipient)
    )
      return yield* failure("接收设备的授权已失效，请重新选择。");

    const now = yield* Clock.currentTimeMillis;
    const root = yield* configuration;
    const directory = transferDirectory(root, input.threadId);
    return yield* storage(async () => {
      const marker = recordPath(directory, input.id);
      if (activeWrites.has(marker)) throw failure("该文件正在准备，请稍后查询。");
      activeWrites.add(marker);
      try {
        await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
        const existing = await readRecord(directory, input.id);
        if (existing) {
          if (existing.sourceUrl !== url.href || existing.requesterAlias !== input.requesterAlias)
            throw failure("文件传输资料发生变化。");
          if (!existing.disposition && existing.expiresAt > now) {
            await indexFileHandoff(root, existing.recipient, NodePath.basename(directory), {
              threadId: input.threadId,
              id: existing.id,
              expiresAt: existing.expiresAt,
            });
          }
          return threadFileHandoffStatus(existing);
        }
        const records = await readRecords(directory);
        if (
          records.filter((entry) => entry.expiresAt > now && !entry.disposition).length >=
          MAX_TRANSFERS_PER_THREAD
        ) {
          throw failure("此会话的文件传输记录已满。");
        }
        const record: HandoffRecord = {
          id: input.id,
          sender: sender.sessionId,
          recipient: recipient.sessionId,
          senderLabel: label(sender),
          recipientLabel: label(recipient),
          requesterAlias: input.requesterAlias,
          sourceOrdinal: input.sourceOrdinal,
          sourceUrl: url.href,
          name: remoteFileName(url),
          sizeBytes: 0,
          expectedSha256: "",
          expiresAt: now + RETENTION_MS,
          sha256: null,
          serverStaged: true,
          autoReceive: true,
          deliveryRevision: NodeCrypto.randomUUID(),
        };
        await indexFileHandoff(root, record.recipient, NodePath.basename(directory), {
          threadId: input.threadId,
          id: record.id,
          expiresAt: record.expiresAt,
        });
        await writeRecord(directory, record);
        return threadFileHandoffStatus(record);
      } finally {
        activeWrites.delete(marker);
      }
    });
  },
);

const approveUrlDownload = Effect.fn("FileHandoff.approveUrlDownload")(function* (
  directory: string,
  id: string,
  sessionId: AuthSessionId,
  now: number,
) {
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(() => failure("无法读取文件大小限制。")),
  );
  const externalLimit = yield* Config.String("T3CODE_EXTERNAL_DOWNLOAD_MAX_MIB").pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  const maxBytes = Math.min(
    settings.attachmentMaxFileSizeMiB * 1024 * 1024,
    Number(externalDownloadMaxBytes(externalLimit)),
  );
  return yield* Effect.tryPromise({
    try: async (signal) => {
      const marker = recordPath(directory, id);
      if (activeWrites.has(marker)) throw failure("文件正在下载，请稍后重试。");
      activeWrites.add(marker);
      const staging = NodePath.join(directory, `${id}.stage`);
      try {
        const record = await readRecord(directory, id);
        if (
          !record?.sourceUrl ||
          record.recipient !== sessionId ||
          record.disposition ||
          record.expiresAt <= now
        ) {
          throw failure("该下载请求已过期或不属于当前设备。");
        }
        if (record.sha256) return record;
        await NodeFSP.rm(staging, { force: true });
        try {
          const file = await fetchRemoteFile(record.sourceUrl, staging, maxBytes, signal);
          signal.throwIfAborted();
          const { urlFailure: _previousFailure, ...pending } = record;
          const next: HandoffRecord = { ...pending, ...file, expectedSha256: file.sha256 };
          await NodeFSP.rename(staging, contentsPath(directory, id));
          await writeRecord(directory, next);
          return next;
        } catch (cause) {
          const error = isHandoffError(cause)
            ? cause
            : failure("无法下载来源文件，请检查网址后重试。");
          if (!signal.aborted) {
            await NodeFSP.rm(contentsPath(directory, id), { force: true });
            await writeRecord(directory, { ...record, urlFailure: error.message });
          }
          throw error;
        }
      } finally {
        try {
          await NodeFSP.rm(staging, { force: true });
        } finally {
          activeWrites.delete(marker);
        }
      }
    },
    catch: (error) =>
      isHandoffError(error) ? error : failure("无法下载来源文件，请检查网址后重试。"),
  });
});

function threadFileHandoffStatus(record: HandoffRecord) {
  return {
    id: record.id,
    name: record.name,
    recipientLabel: record.recipientLabel,
    status: record.disposition ?? ("awaiting_save" as const),
    ...(record.sourceUrl === undefined ? {} : { urlDownload: true as const }),
    ...(!record.disposition && record.urlFailure ? { urlFailure: record.urlFailure } : {}),
    ...(record.claimed && !record.disposition ? { claimed: true as const } : {}),
    ...(record.savedPath === undefined ? {} : { savedPath: record.savedPath }),
    ...(record.installRequested ? { installRequested: true as const } : {}),
    ...(record.installation === undefined ? {} : { installation: record.installation }),
  };
}

export const readThreadFileHandoffStatus = Effect.fn("FileHandoff.threadFileStatus")(function* (
  threadId: ThreadId,
  id: string,
) {
  if (!UUID_PATTERN.test(id)) return yield* failure("文件传输编号无效。");
  const now = yield* Clock.currentTimeMillis;
  const directory = transferDirectory(yield* configuration, threadId);
  const record = yield* storage(() => readRecord(directory, id));
  if (!record?.serverStaged || record.expiresAt <= now)
    return yield* failure("该会话文件传输记录不存在或已过期。");
  return threadFileHandoffStatus(record);
});

export const manageThreadFileHandoff = Effect.fn("FileHandoff.manageThreadFile")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestedId?: string;
  readonly requestText: string;
  readonly requester: AuthSessionId;
  readonly requesterAlias: string;
  readonly requestId: string;
  readonly ordinal: number;
  readonly recipient?: AuthSessionId;
}) {
  if (input.requestedId !== undefined && !UUID_PATTERN.test(input.requestedId)) {
    return yield* failure("文件传输编号无效。");
  }
  const clients = yield* authorizedClients;
  const sender = clients.find((entry) => entry.sessionId === input.requester);
  const recipient = clients.find((entry) => entry.sessionId === input.recipient);
  if (
    !sender ||
    !eligible(sender, AuthOrchestrationOperateScope) ||
    (input.recipient !== undefined && (!recipient || !eligible(recipient)))
  ) {
    return yield* failure("请求设备或接收设备的授权已失效。");
  }
  const root = yield* configuration;
  const directory = transferDirectory(root, input.threadId);
  const now = yield* Clock.currentTimeMillis;
  const requestText = input.requestText.normalize("NFKC").toLocaleLowerCase();
  const fileReference = requestText.split(/改发|\bto\b/iu, 1)[0] ?? "";
  const explicitIds = fileReference.match(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gu);
  const hasFileName = /[\p{L}\p{N}_-]\.[a-z0-9]{1,12}(?![a-z0-9])/u.test(fileReference);
  const refersToTransfer =
    input.recipient !== undefined ||
    /(?:(?:刚才|刚刚|上次|这|那|上一)(?:的|这|那|一|个|次|份|件|张)*(?:文件|传输|交付|附件)?|文件(?:传输)?|传输|交付|附件)\s*(?:取消)?\s*(?:吧)?[。！!]?\s*$|\b(?:the last|the file|the transfer|that|this)\b/iu.test(
      fileReference,
    );
  return yield* storage(async () => {
    const records = (await readRecords(directory)).filter(
      (record) =>
        record.serverStaged &&
        record.expiresAt > now &&
        (record.sourceOrdinal === undefined || record.sourceOrdinal < input.ordinal) &&
        (record.sender === input.requester || record.requesterAlias === input.requesterAlias),
    );
    const explicitlyNamed = records.filter((record) => {
      const name = record.name.normalize("NFKC").toLocaleLowerCase();
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9_.-])${escaped}(?![a-z0-9_.-])`, "u").test(fileReference);
    });
    const namedFiles = new Set(explicitlyNamed.map((record) => record.name));
    const matching = explicitIds
      ? records.filter((record) => explicitIds.includes(record.id))
      : hasFileName || explicitlyNamed.length > 0
        ? explicitlyNamed
        : refersToTransfer
          ? records
          : [];
    const recent = matching.toSorted(
      (left, right) =>
        (right.sourceOrdinal ?? 0) - (left.sourceOrdinal ?? 0) || right.expiresAt - left.expiresAt,
    );
    const candidate =
      recent.find((record) => record.management?.requestId === input.requestId) ?? recent[0];
    if (
      !candidate ||
      (explicitIds ? explicitIds.length !== 1 : namedFiles.size > 1) ||
      (input.requestedId !== undefined && input.requestedId !== candidate.id) ||
      (recent[1]?.sourceOrdinal === candidate.sourceOrdinal &&
        recent[1]?.expiresAt === candidate.expiresAt &&
        candidate.management?.requestId !== input.requestId)
    )
      throw failure("无法唯一确定此会话的文件传输，请指明原文件或传输编号。");
    const marker = recordPath(directory, candidate.id);
    if (activeWrites.has(marker)) throw failure("文件正在处理，请稍后重试。");
    activeWrites.add(marker);
    try {
      const record = await readRecord(directory, candidate.id);
      if (!record || record.expiresAt <= now) throw failure("该文件传输已过期。");
      if (record.management?.requestId === input.requestId) {
        if (record.disposition === "cancelled") {
          if (record.autoReceive) {
            await removeFromFileHandoffInbox(
              root,
              record.recipient,
              NodePath.basename(directory),
              record.id,
            );
          }
          await NodeFSP.rm(contentsPath(directory, record.id), { force: true });
        }
        return threadFileHandoffStatus(record);
      }
      if (record.management && record.management.ordinal >= input.ordinal) {
        throw failure("该文件已有更新的处理请求。");
      }
      if (record.disposition || record.claimed) return threadFileHandoffStatus(record);

      const management = { requestId: input.requestId, ordinal: input.ordinal };
      if (recipient && record.recipient === recipient.sessionId) {
        const unchanged = { ...record, management };
        await writeRecord(directory, unchanged);
        return threadFileHandoffStatus(unchanged);
      }
      // 改发只授权传输文件，安装意图属于原命令指定的接收设备。
      const { installRequested: _installRequested, ...redirectedRecord } = record;
      const next: HandoffRecord = recipient
        ? {
            ...redirectedRecord,
            management,
            recipient: recipient.sessionId,
            recipientLabel: label(recipient),
            deliveryRevision: NodeCrypto.randomUUID(),
          }
        : { ...record, management, disposition: "cancelled" };
      const threadKey = NodePath.basename(directory);
      if (recipient && record.autoReceive) {
        await indexFileHandoff(root, recipient.sessionId, threadKey, {
          threadId: input.threadId,
          id: record.id,
          expiresAt: record.expiresAt,
        });
      }
      // 只有原记录能交付字节。改发先写新索引，旧索引会因接收端不符而失效。
      await writeRecord(directory, next);
      if (record.autoReceive) {
        await removeFromFileHandoffInbox(root, record.recipient, threadKey, record.id);
      }
      if (next.disposition === "cancelled")
        await NodeFSP.rm(contentsPath(directory, next.id), { force: true });
      return threadFileHandoffStatus(next);
    } finally {
      activeWrites.delete(marker);
    }
  });
});

export const readFileHandoff = Effect.fn("FileHandoff.read")(function* (
  input: FileHandoffRequest,
  session: EnvironmentAuth.AuthenticatedSession,
) {
  const root = yield* configuration;
  const now = yield* Clock.currentTimeMillis;
  if (input._tag === "inbox") {
    if (!session.scopes.includes(AuthOrchestrationReadScope)) {
      return yield* failure("当前设备没有读取收件箱的权限。");
    }
    const inbox = yield* storage(async () => {
      const candidates = await indexedFileHandoffs(root, session.sessionId, now);
      const matches: FileHandoffInboxTransfer[] = [];
      const urlDownloads: FileHandoffUrlDownload[] = [];
      for (const { threadId, id } of candidates) {
        const record = await readRecord(transferDirectory(root, threadId), id);
        if (
          !record?.serverStaged ||
          !record.autoReceive ||
          record.disposition ||
          record.recipient !== session.sessionId ||
          record.expiresAt <= now
        )
          continue;
        if (record.sourceUrl) {
          if (urlDownloads.length < MAX_INBOX_RESULTS) {
            urlDownloads.push({
              threadId,
              id,
              name: record.name,
              sourceUrl: record.sourceUrl,
              ...(record.urlFailure ? { failure: record.urlFailure } : {}),
              senderLabel: record.senderLabel,
              expiresAt: record.expiresAt,
              ...(record.sha256
                ? { ready: { sizeBytes: record.sizeBytes, sha256: record.sha256 } }
                : {}),
            });
          }
          continue;
        }
        if (record.sha256 === null || matches.length >= MAX_INBOX_RESULTS) continue;
        matches.push({
          threadId,
          id,
          name: record.name,
          sizeBytes: record.sizeBytes,
          senderLabel: record.senderLabel,
          expiresAt: record.expiresAt,
          sha256: record.sha256,
          autoReceive: true,
        });
      }
      return {
        transfers: matches,
        ...(urlDownloads.length ? { urlDownloads } : {}),
      };
    });
    return { _tag: "inbox", ...inbox } satisfies FileHandoffReply;
  }

  const sessions = yield* authorizedClients;
  const directory = transferDirectory(root, input.threadId);
  if (input._tag === "list") {
    const records = yield* storage(() => readRecords(directory));
    return {
      _tag: "list",
      transfers: records
        .filter(
          (entry) =>
            entry.expiresAt > now &&
            (entry.sender === session.sessionId ||
              (entry.recipient === session.sessionId &&
                entry.disposition !== "cancelled" &&
                (entry.sha256 !== null ||
                  entry.sourceUrl !== undefined ||
                  activeDirectHandoff(recordPath(directory, entry.id), now) !== undefined))),
        )
        .sort((left, right) => right.expiresAt - left.expiresAt)
        .map(
          ({
            id,
            name,
            senderLabel,
            recipientLabel,
            sizeBytes,
            sha256,
            sender,
            expiresAt,
            disposition,
            expectedSha256,
            serverStaged,
            sourceUrl,
            urlFailure,
            autoReceive,
            recipient,
            savedPath,
            installRequested,
            installation,
          }) => ({
            id,
            name,
            senderLabel,
            recipientLabel,
            sizeBytes,
            sha256,
            expiresAt,
            outgoing:
              sender === session.sessionId && (!serverStaged || recipient !== session.sessionId),
            ...(sourceUrl === undefined ? {} : { urlDownload: true as const }),
            ...(!disposition && urlFailure ? { urlFailure } : {}),
            ...(serverStaged && autoReceive && !sourceUrl && recipient === session.sessionId
              ? { autoReceive: true as const }
              : {}),
            ...(savedPath === undefined ? {} : { savedPath }),
            ...(installRequested ? { installRequested } : {}),
            ...(installation === undefined ? {} : { installation }),
            ...(disposition === undefined ? {} : { disposition }),
            ...(!sha256 && activeDirectHandoff(recordPath(directory, id), now)
              ? { directSha256: expectedSha256 }
              : {}),
          }),
        ),
      recipients: session.scopes.includes(AuthOrchestrationOperateScope)
        ? sessions
            .filter((entry) => entry.sessionId !== session.sessionId && eligible(entry))
            .map((entry) => ({ id: entry.sessionId, label: label(entry), online: entry.connected }))
        : [],
    } satisfies FileHandoffReply;
  }

  if (!UUID_PATTERN.test(input.id)) return yield* failure("文件传输编号无效。");
  if (isDirectHandoffRequest(input)) {
    const record = yield* storage(() => readRecord(directory, input.id));
    const person = sessions.find((device) => device.sessionId === session.sessionId);
    const outgoing = record?.sender === session.sessionId;
    if (
      !record ||
      record.expiresAt <= now ||
      !person ||
      !(outgoing || record.recipient === session.sessionId) ||
      !eligible(person, outgoing ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope)
    ) {
      return yield* failure("该文件传输已过期或不属于当前设备。");
    }
    if (record.disposition === "saved") return { _tag: "direct", state: "saved" } as const;
    if (record.disposition || record.sha256) return { _tag: "direct", state: "closed" } as const;
    const marker = recordPath(directory, input.id);
    if (input._tag !== "directAnswer") return signalDirectHandoff(marker, input, outgoing, now);
    return yield* storage(async () => {
      if (activeWrites.has(marker)) throw failure("文件正在写入，请稍后重试。");
      activeWrites.add(marker);
      try {
        const current = await readRecord(directory, input.id);
        if (current?.disposition || current?.sha256)
          return { _tag: "direct", state: "closed" } as const;
        if (!current || current.expiresAt <= now) throw failure("该文件传输已过期。");
        const reply = signalDirectHandoff(marker, input, outgoing, now);
        if (
          reply.state === "active" &&
          activeDirectHandoff(marker, now)?.answer &&
          !current.directNegotiated
        ) {
          await writeRecord(directory, { ...current, directNegotiated: true });
        }
        return reply;
      } finally {
        activeWrites.delete(marker);
      }
    });
  }
  if (input._tag === "reportInstall") {
    yield* storage(async () => {
      const marker = recordPath(directory, input.id);
      if (activeWrites.has(marker)) throw failure("回执正在写入，请稍后重试。");
      activeWrites.add(marker);
      try {
        const record = await readRecord(directory, input.id);
        const receiver = sessions.find((device) => device.sessionId === session.sessionId);
        if (
          !record ||
          record.expiresAt <= now ||
          !receiver ||
          !eligible(receiver) ||
          record.sourceUrl !== undefined ||
          record.recipient !== session.sessionId ||
          record.disposition !== "saved" ||
          record.sha256 !== input.sha256 ||
          !record.name.toLowerCase().endsWith(".apk") ||
          (input.installation.status === "failed" && !record.installRequested)
        ) {
          throw failure("只有保存并校验此 APK 的接收设备可以上报安装结果。");
        }
        if (record.installation?.status === "verified") {
          const previous = record.installation;
          const incoming = input.installation;
          if (
            incoming.status === "verified" &&
            (previous.packageName !== incoming.packageName ||
              previous.version !== incoming.version ||
              previous.versionCode !== incoming.versionCode)
          )
            throw failure("该 APK 已有核验过的安装结果。");
          return;
        }
        if (record.installation?.status !== input.installation.status) {
          await writeRecord(directory, { ...record, installation: input.installation });
        }
      } finally {
        activeWrites.delete(marker);
      }
    });
    return { _tag: "finished", disposition: "saved" } satisfies FileHandoffReply;
  }
  if (input._tag === "cancel" || input._tag === "confirmSaved") {
    const disposition = input._tag === "cancel" ? "cancelled" : "saved";
    yield* storage(async () => {
      const marker = recordPath(directory, input.id);
      if (activeWrites.has(marker)) throw failure("文件正在写入，请稍后重试。");
      activeWrites.add(marker);
      try {
        const record = await readRecord(directory, input.id);
        if (!record || record.expiresAt <= now) throw failure("该文件传输已过期。");
        if (input._tag === "cancel") {
          if (record.serverStaged && record.claimed && !record.sourceUrl) {
            throw failure("接收设备已开始领取，等待实际保存回执。");
          }
          if (
            !(
              session.scopes.includes(AuthOrchestrationOperateScope) &&
              record.sender === session.sessionId
            ) &&
            !(
              record.sourceUrl &&
              record.recipient === session.sessionId &&
              session.scopes.includes(AuthOrchestrationReadScope)
            )
          ) {
            throw failure("只有发送设备可以取消传输。");
          }
        } else if (
          record.recipient !== session.sessionId ||
          (record.deliveryRevision !== undefined && !record.claimed) ||
          record.sizeBytes !== input.sizeBytes ||
          (record.sha256 !== input.sha256 &&
            !(record.directNegotiated && record.expectedSha256 === input.sha256))
        ) {
          throw failure("接收设备、文件大小或 SHA-256 与传输记录不符。");
        }
        if (record.disposition !== disposition) {
          if (record.disposition) throw failure("该文件传输已结束。");
          // 先保存终态再删除字节。重复回执可以继续清理中断前留下的副本。
          await writeRecord(directory, {
            ...record,
            sha256:
              disposition === "saved" && input._tag === "confirmSaved"
                ? input.sha256
                : record.sha256,
            disposition,
            ...(input._tag === "confirmSaved" && input.savedPath !== undefined
              ? { savedPath: input.savedPath }
              : {}),
          });
          closeDirectHandoff(marker);
        }
        if (record.serverStaged && record.autoReceive) {
          await removeFromFileHandoffInbox(
            root,
            record.recipient,
            NodePath.basename(directory),
            record.id,
          );
        }
        await NodeFSP.rm(contentsPath(directory, input.id), { force: true });
      } finally {
        activeWrites.delete(marker);
      }
    });
    return { _tag: "finished", disposition } satisfies FileHandoffReply;
  }

  const receiver = sessions.find((device) => device.sessionId === session.sessionId);
  if (!receiver || !eligible(receiver)) return yield* failure("接收设备的授权已失效，请重新选择。");
  const record =
    input._tag === "approveUrl"
      ? yield* approveUrlDownload(directory, input.id, session.sessionId, now)
      : yield* storage(() => readRecord(directory, input.id));
  if (
    !record ||
    record.recipient !== session.sessionId ||
    !record.sha256 ||
    record.disposition !== undefined ||
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
  const directory = NodePath.join(yield* configuration, threadKey);
  const record = yield* storage(() => readRecord(directory, id));
  if (!record || record.disposition || record.expiresAt <= now) return null;
  const signer = yield* AssetSigner.AssetSigner;
  const payload = `handoff.${mode}.${threadKey}.${id}.${expiry}`;
  const verified = yield* signer
    .verify(
      mode === "receive" && record.deliveryRevision
        ? `${payload}.${record.deliveryRevision}`
        : payload,
      signature,
    )
    .pipe(Effect.mapError(() => failure("无法验证文件传输链接。")));
  if (!verified) return null;
  if (mode === "upload") closeDirectHandoff(recordPath(directory, id));
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

export const claimThreadFileHandoff = Effect.fn("FileHandoff.claimThreadFile")(function* (
  transfer: NonNullable<Effect.Success<ReturnType<typeof resolveFileHandoff>>>,
) {
  const { directory, record } = transfer;
  if (!record.serverStaged) return true;
  const now = yield* Clock.currentTimeMillis;
  return yield* storage(async () => {
    const marker = recordPath(directory, record.id);
    if (activeWrites.has(marker)) return false;
    activeWrites.add(marker);
    try {
      const current = await readRecord(directory, record.id);
      if (
        !current ||
        current.disposition ||
        current.expiresAt <= now ||
        current.recipient !== record.recipient ||
        current.deliveryRevision !== record.deliveryRevision
      ) {
        return false;
      }
      if (!current.claimed) await writeRecord(directory, { ...current, claimed: true });
      return true;
    } finally {
      activeWrites.delete(marker);
    }
  });
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
        if (!current || current.disposition || current.expiresAt <= now) {
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
              const file = await NodeFSP.open(path, "a", 0o600);
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
