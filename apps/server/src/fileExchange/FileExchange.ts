// @effect-diagnostics nodeBuiltinImport:off - 传输需要原生无链接打开、目录句柄和双向进程管道。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  exchangeWorkspaceKey,
  isExchangeName,
  isWindowsExchangeName,
  MAX_FILE_BYTES,
  readTargets,
  sha256Pattern,
  type ExchangeTarget,
} from "./config.ts";
import { inspectLinuxDevice, type LinuxDeviceCheck } from "./LinuxDeviceStatus.ts";
import { resolveSshCommand } from "@t3tools/ssh/command";
import {
  openLinuxExchangeDirectory,
  sourceRetained,
  type SourceDisposition,
  type ExchangeFile,
  type ExchangeFileStats,
  type LocalExchangeDirectory,
} from "./LocalExchangeDirectory.ts";
import { openWindowsExchangeDirectory } from "./WindowsExchangeDirectory.ts";
import { sshConnectionArgs } from "./sshConnection.ts";
import { makeSshTargetQueue } from "./SshTargetQueue.ts";
import { sftpChunkBytes, SftpConnectionError, SftpSession } from "./SftpSession.ts";

const transferTimeoutMs = 30 * 60_000;
const reconnectAttempts = 2;
const isSftpConnectionError = Schema.is(SftpConnectionError);
interface ExchangeInput {
  readonly deviceId: string;
  readonly workspaceRoot: string;
  readonly direction: "send" | "receive";
  readonly mode?: "copy" | "move";
  readonly localName: string;
  readonly remoteName?: string;
  readonly expectedSha256?: string;
}

interface TransferReceipt {
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sourceDisposition?: SourceDisposition;
}

export class FileExchangeError extends Schema.TaggedError<
  FileExchangeError,
  { readonly brand: unique symbol }
>()("FileExchangeError", { message: Schema.String }) {}

async function localFileStats(file: ExchangeFile) {
  const stats = await file.stat();
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new FileExchangeError({
      message: "The local source must be a regular file with one filesystem link.",
    });
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new FileExchangeError({ message: "The source file is larger than 1 GiB." });
  }
  return stats;
}

async function readLocalChunk(file: ExchangeFile, buffer: Buffer, size: number, offset: number) {
  const requested = Math.min(buffer.length, size - offset);
  if (requested === 0) return null;
  const { bytesRead } = await file.read(buffer, 0, requested, offset);
  if (bytesRead === 0) {
    throw new FileExchangeError({ message: "The local source changed during transfer." });
  }
  return buffer.subarray(0, bytesRead);
}

async function writeLocalChunk(file: ExchangeFile, data: Buffer, offset: number) {
  let written = 0;
  while (written < data.length) {
    const { bytesWritten } = await file.write(
      data,
      written,
      data.length - written,
      offset + written,
    );
    if (bytesWritten === 0) throw new Error("The local staging file could not be written.");
    written += bytesWritten;
  }
}

async function hashLocalFile(file: ExchangeFile, stats: ExchangeFileStats, signal: AbortSignal) {
  const digest = NodeCrypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(sftpChunkBytes);
  for (let offset = 0; offset < stats.size;) {
    signal.throwIfAborted();
    const chunk = await readLocalChunk(file, buffer, stats.size, offset);
    if (chunk === null) break;
    digest.update(chunk);
    offset += chunk.length;
  }
  await assertLocalSourceUnchanged(file, stats);
  return digest.digest("hex");
}

async function assertLocalSourceUnchanged(file: ExchangeFile, before: ExchangeFileStats) {
  const after = await localFileStats(file);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new FileExchangeError({ message: "The local source changed during transfer." });
  }
}

function assertDigest(actual: string, expected: string | undefined) {
  if (expected !== undefined && actual !== expected.toLowerCase()) {
    throw new FileExchangeError({
      message: "The SHA-256 checksum does not match. No destination file was published.",
    });
  }
}

type StartSession = (
  alias: string,
  signal: AbortSignal,
) => NodeChildProcess.ChildProcessWithoutNullStreams;
type RunSftp = <A>(operation: (session: SftpSession) => Promise<A>) => Promise<A>;

function connectSftp(target: ExchangeTarget, startSession: StartSession, signal: AbortSignal) {
  let current: { session: SftpSession; close: () => Promise<void> } | undefined;
  let remainingReconnects = reconnectAttempts;

  async function close() {
    const connection = current;
    current = undefined;
    await connection?.close();
  }

  const run: RunSftp = async (operation) => {
    for (;;) {
      signal.throwIfAborted();
      try {
        if (current === undefined) {
          const child = startSession(target.sshAlias, signal);
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.on("error", () => {});
          child.stdin.on("error", () => {});
          child.stderr.resume();
          // 取消时关闭整个 SFTP 子系统，避免阻塞的读写保留子进程。
          const stop = () => child.kill("SIGKILL");
          signal.addEventListener("abort", stop, { once: true });
          if (signal.aborted) stop();
          const session = new SftpSession(child);
          current = {
            session,
            close: async () => {
              signal.removeEventListener("abort", stop);
              child.stdin.end();
              stop();
              await closed;
            },
          };
          await session.initialize();
          if ((await session.realpath(target.remoteDirectory)) !== target.remoteDirectory) {
            throw new FileExchangeError({
              message: "The configured remote directory must be its canonical SFTP path.",
            });
          }
        }
        return await operation(current.session);
      } catch (error) {
        if (!isSftpConnectionError(error)) throw error;
        await close();
        if (remainingReconnects <= 0) throw error;
        remainingReconnects--;
      }
    }
  };

  return { run, close };
}

async function readRemoteFile(
  run: RunSftp,
  path: string,
  onChunk: (chunk: Buffer, offset: number) => Promise<void> | void,
  expectedSize?: number,
) {
  let offset = 0;
  let snapshot: Awaited<ReturnType<SftpSession["regularFile"]>> | undefined;
  const digest = NodeCrypto.createHash("sha256");
  await run(async (session) => {
    const before = await session.regularFile(path, MAX_FILE_BYTES);
    snapshot ??= before;
    if (
      before.size !== (expectedSize ?? snapshot.size) ||
      before.modifiedAt !== snapshot.modifiedAt
    ) {
      throw new FileExchangeError({ message: "The remote source changed during transfer." });
    }
    await session.readChunks(path, before.size, offset, async (chunk) => {
      await onChunk(chunk, offset);
      digest.update(chunk);
      offset += chunk.length;
    });
    const after = await session.regularFile(path, MAX_FILE_BYTES);
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.modifiedAt !== before.modifiedAt
    ) {
      throw new FileExchangeError({ message: "The remote source changed during transfer." });
    }
  });
  return { sizeBytes: offset, sha256: digest.digest("hex") };
}

async function sameRemoteFile(
  session: SftpSession,
  selected: string,
  candidate: string,
  stage: string,
) {
  const probe = `${stage}/identity-${NodeCrypto.randomUUID()}`;
  const comparison = `${probe}-candidate`;
  try {
    await session.link(selected, probe);
    await session.link(candidate, comparison);
    // POSIX 改名的两端是同一个 inode 时两个目录项都会保留。这里只操作新增的探针链接。
    await session.atomicRename(probe, comparison);
    return await session.exists(probe);
  } finally {
    await session.remove(probe).catch(() => {});
    await session.remove(comparison).catch(() => {});
  }
}

async function removeRemoteSource(
  run: RunSftp,
  source: string,
  selected: string,
  stage: string,
  expected: { readonly sizeBytes: number; readonly sha256: string },
): Promise<SourceDisposition> {
  const captured = `${stage}/source`;
  const retained = () => sourceRetained("The remote source changed or cannot be deleted.");
  let captureRequested = false;
  try {
    const same = await run(
      async (session) =>
        session.supportsPosixRename && (await sameRemoteFile(session, selected, source, stage)),
    );
    if (!same) return retained();
    const original = await readRemoteFile(run, selected, () => {}, expected.sizeBytes);
    if (original.sha256 !== expected.sha256) return retained();
    await run(async (session) => {
      // 回执丢失时转入恢复流程，避免重放改名并捕获后来写入原路径的文件。
      if (captureRequested) throw new Error("The source capture result is unknown.");
      captureRequested = true;
      await session.atomicRename(source, captured);
    });

    if (await run((session) => sameRemoteFile(session, selected, captured, stage))) {
      const actual = await readRemoteFile(run, captured, () => {}, expected.sizeBytes);
      if (actual.sha256 === expected.sha256) {
        await run(async (session) => {
          if (await session.exists(captured)) await session.remove(captured);
        });
        return { status: "removed" };
      }
    }
  } catch {
    if (!captureRequested) return retained();
  }

  try {
    return await run(async (session) => {
      if (!(await session.exists(captured))) return retained();
      // 只在原名空闲时恢复。否则保留捕获的内容，供用户核对。
      await session.link(captured, source);
      await session.remove(captured);
      return sourceRetained(
        "The remote source changed or could not be removed. It was restored at its original name.",
      );
    });
  } catch {
    return sourceRetained(
      "The remote source may be in the recovery directory. Check its original name before restoring it.",
      captured,
    );
  }
}

async function sendFile(
  run: RunSftp,
  directory: LocalExchangeDirectory,
  localName: string,
  remotePath: string,
  remoteTemp: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
  move: boolean,
  temporaryName: string,
): Promise<TransferReceipt> {
  const source = await directory.source(localName, move);
  try {
    const stats = await localFileStats(source);
    const sha256 = await hashLocalFile(source, stats, signal);
    assertDigest(sha256, expectedSha256);
    const buffer = Buffer.allocUnsafe(sftpChunkBytes);
    let sent = 0;
    await run(async (session) => {
      const staging = await session.existingRegularFile(remoteTemp, MAX_FILE_BYTES);
      if ((staging?.size ?? 0) < sent || (staging?.size ?? 0) > stats.size) {
        throw new FileExchangeError({
          message: "The remote staging file changed during transfer.",
        });
      }
      await session.writeChunks(
        remoteTemp,
        sent,
        staging === null,
        (offset) => readLocalChunk(source, buffer, stats.size, offset),
        (offset) => {
          sent = offset;
        },
      );
    });
    await assertLocalSourceUnchanged(source, stats);
    assertDigest((await readRemoteFile(run, remoteTemp, () => {}, stats.size)).sha256, sha256);
    // 发布是独占硬链接。连接如果在回执到达前中断，应核对目的文件，不能覆盖。
    await run(async (session) => {
      signal.throwIfAborted();
      try {
        await session.link(remoteTemp, remotePath);
      } catch {
        throw new FileExchangeError({
          message:
            "The destination could not be created. Check whether the remote file already exists or the connection was interrupted.",
        });
      }
    });
    const receipt = { sizeBytes: sent, sha256 };
    if (!move) return receipt;
    const sourceDisposition = await source
      .removeAfterVerification(
        temporaryName,
        async (file) => sha256 === (await hashLocalFile(file, await localFileStats(file), signal)),
      )
      .catch(() => sourceRetained("The local source could not be removed."));
    return { ...receipt, sourceDisposition };
  } finally {
    await source.close();
  }
}

async function receiveFile(
  run: RunSftp,
  directory: LocalExchangeDirectory,
  localName: string,
  temporaryName: string,
  remotePath: string,
  remoteTemp: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
  move: boolean,
  remoteStage: string,
): Promise<TransferReceipt> {
  // SFTP v3 的 OPEN 会跟随链接。先将目录项硬链接进私有目录，再对该目录项检查类型。
  await run(async (session) => {
    if ((await session.existingRegularFile(remoteTemp, MAX_FILE_BYTES)) !== null) return;
    await session.regularFile(remotePath, MAX_FILE_BYTES);
    await session.link(remotePath, remoteTemp);
    await session.regularFile(remoteTemp, MAX_FILE_BYTES);
  });
  const staging = await directory.stage(temporaryName);
  try {
    const receipt = await readRemoteFile(run, remoteTemp, (chunk, offset) =>
      writeLocalChunk(staging.file, chunk, offset),
    );
    assertDigest(receipt.sha256, expectedSha256);
    await staging.file.sync();
    assertDigest(
      await hashLocalFile(staging.file, await localFileStats(staging.file), signal),
      receipt.sha256,
    );
    signal.throwIfAborted();
    try {
      await staging.publish(localName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FileExchangeError({ message: "The local destination already exists." });
      }
      throw error;
    }
    if (!move) return receipt;
    const sourceDisposition = await removeRemoteSource(
      run,
      remotePath,
      remoteTemp,
      remoteStage,
      receipt,
    );
    return { ...receipt, sourceDisposition };
  } finally {
    await staging.close();
  }
}

async function transfer(
  target: ExchangeTarget,
  input: ExchangeInput,
  startSession: StartSession,
  signal: AbortSignal,
  platform: NodeJS.Platform,
) {
  const remoteName = input.remoteName ?? input.localName;
  const directory = await (platform === "win32"
    ? openWindowsExchangeDirectory(target)
    : openLinuxExchangeDirectory(target));
  const connection = connectSftp(target, startSession, signal);
  const temporaryName = `.t3-file-exchange-${NodeCrypto.randomUUID()}`;
  const remoteStage = `${target.remoteDirectory}/${temporaryName}`;
  const remoteTemp = `${remoteStage}/file`;
  const remotePath = `${target.remoteDirectory}/${remoteName}`;
  let stageCreated = false;
  try {
    await connection.run((session) => session.mkdir(remoteStage));
    stageCreated = true;
    const receipt =
      input.direction === "send"
        ? await sendFile(
            connection.run,
            directory,
            input.localName,
            remotePath,
            remoteTemp,
            input.expectedSha256,
            signal,
            input.mode === "move",
            temporaryName,
          )
        : await receiveFile(
            connection.run,
            directory,
            input.localName,
            temporaryName,
            remotePath,
            remoteTemp,
            input.expectedSha256,
            signal,
            input.mode === "move",
            remoteStage,
          );
    return {
      deviceId: target.deviceId,
      direction: input.direction,
      workspacePath: `${target.localDirectory}/${input.localName}`,
      remoteName,
      ...receipt,
    };
  } finally {
    if (stageCreated) {
      await connection
        .run(async (session) => {
          await session.remove(remoteTemp).catch(() => {});
          await session.rmdir(remoteStage);
        })
        .catch(() => {});
    }
    await connection.close().finally(() => directory.close());
  }
}

const make = Effect.fn("FileExchange.make")(function* (
  getTargets: () => ReadonlyArray<ExchangeTarget>,
  startSession: StartSession,
) {
  const platform = yield* HostProcess.Platform;
  const workspaceKey = (path: string) => exchangeWorkspaceKey(path, platform);
  const queue = yield* Effect.sync(makeSshTargetQueue);
  const diagnostics = new Map<
    string,
    {
      readonly result: Awaited<ReturnType<typeof inspectLinuxDevice>>;
      readonly checkedAt: string;
    }
  >();
  const getTarget = (input: Pick<ExchangeInput, "deviceId" | "workspaceRoot">) =>
    getTargets().find(
      (candidate) =>
        candidate.deviceId === input.deviceId &&
        workspaceKey(candidate.workspaceRoot) === workspaceKey(input.workspaceRoot),
    );
  const withConnection = <A>(
    execute: (signal: AbortSignal) => Promise<A>,
    failureMessage: string,
  ) =>
    Effect.suspend(() => {
      let pending: Promise<A> | undefined;
      return Effect.tryPromise({
        try: (signal) => (pending = execute(signal)),
        catch: (error) =>
          isExchangeError(error) ? error : new FileExchangeError({ message: failureMessage }),
      }).pipe(
        // 中断后等待子进程和临时文件清理，再允许同一设备接受下一项。
        Effect.onInterrupt(() =>
          pending === undefined
            ? Effect.void
            : Effect.promise(() =>
                pending!.then(
                  () => undefined,
                  () => undefined,
                ),
              ),
        ),
      );
    });
  const isExchangeError = Schema.is(FileExchangeError);
  const queueFull = new FileExchangeError({
    message: "This Linux device has 16 waiting operations.",
  });
  return {
    listDevices: Effect.sync(() => {
      const list = new Map<
        string,
        {
          readonly deviceId: string;
          readonly sftpAliases: Set<string>;
          readonly diagnosticAliases: Set<string>;
        }
      >();
      for (const target of getTargets()) {
        const known = list.get(target.deviceId) ?? {
          deviceId: target.deviceId,
          sftpAliases: new Set<string>(),
          diagnosticAliases: new Set<string>(),
        };
        known.sftpAliases.add(target.sshAlias);
        if (target.diagnosticsSshAlias !== undefined)
          known.diagnosticAliases.add(target.diagnosticsSshAlias);
        list.set(target.deviceId, known);
      }
      return [...list.values()].map(({ deviceId, sftpAliases, diagnosticAliases }) => {
        const latest = [...diagnosticAliases]
          .flatMap((alias) => {
            const reading = diagnostics.get(alias);
            return reading === undefined ? [] : [reading];
          })
          .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0];
        return {
          deviceId,
          sftpAliases: [...sftpAliases],
          diagnosticAliases: [...diagnosticAliases],
          ...queue.status(deviceId),
          ...(latest === undefined ? {} : { lastDiagnostic: latest }),
        };
      });
    }),
    transfer: Effect.fn("FileExchange.transfer")(function* <E = never, R = never>(
      input: ExchangeInput,
      beforeRun: Effect.Effect<void, E, R> = Effect.void,
    ) {
      if (
        !(platform === "win32"
          ? isWindowsExchangeName(input.localName)
          : isExchangeName(input.localName)) ||
        (input.remoteName !== undefined && !isExchangeName(input.remoteName))
      ) {
        return yield* new FileExchangeError({
          message: "Use a single visible file name in each exchange directory.",
        });
      }
      if (input.expectedSha256 !== undefined && !sha256Pattern.test(input.expectedSha256)) {
        return yield* new FileExchangeError({
          message: "The expected SHA-256 must contain 64 hexadecimal digits.",
        });
      }
      const target = getTarget(input);
      if (target === undefined) {
        return yield* new FileExchangeError({
          message:
            "This Linux SFTP device has no exchange directory configured for the calling workspace.",
        });
      }
      return yield* queue.run(
        target.deviceId,
        input.direction === "send" ? "sftp-send" : "sftp-receive",
        beforeRun.pipe(
          Effect.andThen(
            withConnection(
              (signal) =>
                transfer(
                  target,
                  input,
                  startSession,
                  AbortSignal.any([signal, AbortSignal.timeout(transferTimeoutMs)]),
                  platform,
                ),
              "File exchange failed. Check that both exchange directories and the SFTP connection are available, and check the destination before retrying.",
            ),
          ),
        ),
        queueFull,
      );
    }),
    inspect: Effect.fn("FileExchange.inspect")(function* <E = never, R = never>(
      input: Pick<ExchangeInput, "deviceId" | "workspaceRoot"> & {
        readonly check: LinuxDeviceCheck;
      },
      beforeRun: Effect.Effect<void, E, R> = Effect.void,
    ) {
      const target = getTarget(input);
      const alias = target?.diagnosticsSshAlias;
      if (target === undefined || alias === undefined) {
        return yield* new FileExchangeError({
          message: "This Linux device has no SSH diagnostics configured for the calling workspace.",
        });
      }
      return yield* queue.run(
        target.deviceId,
        "ssh-diagnostics",
        beforeRun.pipe(
          Effect.andThen(
            withConnection(
              (signal) => inspectLinuxDevice(alias, input.check, signal),
              "The Linux device status could not be read. Check the configured diagnostic SSH connection.",
            ),
          ),
          Effect.tap((result) =>
            DateTime.now.pipe(
              Effect.map((time) =>
                diagnostics.set(alias, { result, checkedAt: DateTime.formatIso(time) }),
              ),
            ),
          ),
        ),
        queueFull,
      );
    }),
  };
});

export class FileExchange extends Context.Service<
  FileExchange,
  Effect.Success<ReturnType<typeof make>>
>()("t3/fileExchange/FileExchange") {}

export const layer = Layer.effect(
  FileExchange,
  Effect.gen(function* () {
    const ssh = yield* resolveSshCommand;
    return yield* make(readTargets, (alias, signal) =>
      NodeChildProcess.spawn(ssh, ["-s", ...sshConnectionArgs(alias), "sftp"], {
        signal,
        windowsHide: true,
      }),
    );
  }),
);

// 使用测试的 OpenSSH SFTP 子系统进程，不需要真实设备、端口和认证信息。
export const layerForSftpTest = (
  targets: ReadonlyArray<ExchangeTarget>,
  serverBinary: string,
  onSession?: (child: NodeChildProcess.ChildProcessWithoutNullStreams) => void,
) =>
  Layer.effect(
    FileExchange,
    make(
      () => targets,
      (_alias, signal) => {
        const child = NodeChildProcess.spawn(serverBinary, [], { signal });
        onSession?.(child);
        return child;
      },
    ),
  );
