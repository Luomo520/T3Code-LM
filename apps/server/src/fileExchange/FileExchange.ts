// @effect-diagnostics nodeBuiltinImport:off - 传输需要原生无链接打开、目录句柄和双向进程管道。
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  isExchangeName,
  MAX_FILE_BYTES,
  readTargets,
  sha256Pattern,
  type ExchangeTarget,
} from "./config.ts";
import { inspectLinuxDevice, type LinuxDeviceCheck } from "./LinuxDeviceStatus.ts";
import { sshConnectionArgs } from "./sshConnection.ts";
import { SftpSession } from "./SftpSession.ts";

const transferTimeoutMs = 120_000;
const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
const fileFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW;
const stagingFlags =
  NodeFS.constants.O_RDWR |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_NOFOLLOW;

interface ExchangeInput {
  readonly deviceId: string;
  readonly workspaceRoot: string;
  readonly direction: "send" | "receive";
  readonly localName: string;
  readonly remoteName?: string;
  readonly expectedSha256?: string;
}

export class FileExchangeError extends Schema.TaggedError<
  FileExchangeError,
  { readonly brand: unique symbol }
>()("FileExchangeError", { message: Schema.String }) {}

async function openExchangeDirectory(target: ExchangeTarget) {
  // 逐级从已打开的父目录查找，拒绝任一级符号链接或并发路径替换。
  let directory = await NodeFSP.open("/", directoryFlags);
  try {
    const components = [...target.workspaceRoot.slice(1).split("/"), target.localDirectory];
    for (const component of components) {
      const next = await NodeFSP.open(`/proc/self/fd/${directory.fd}/${component}`, directoryFlags);
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}

async function readLocalFile(file: NodeFSP.FileHandle) {
  const stats = await file.stat();
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new FileExchangeError({
      message: "The local source must be a regular file with one filesystem link.",
    });
  }
  if (stats.size > MAX_FILE_BYTES) {
    throw new FileExchangeError({ message: "The source file is larger than 8 MiB." });
  }
  const contents = Buffer.allocUnsafe(stats.size);
  let offset = 0;
  while (offset < contents.length) {
    const { bytesRead } = await file.read(contents, offset, contents.length - offset, offset);
    if (bytesRead === 0)
      throw new FileExchangeError({ message: "The local source changed during transfer." });
    offset += bytesRead;
  }
  if ((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) {
    throw new FileExchangeError({ message: "The local source changed during transfer." });
  }
  const finalStats = await file.stat();
  if (stats.mtimeMs !== finalStats.mtimeMs || stats.ctimeMs !== finalStats.ctimeMs) {
    throw new FileExchangeError({ message: "The local source changed during transfer." });
  }
  return contents;
}

function digest(contents: Buffer) {
  return NodeCrypto.createHash("sha256").update(contents).digest("hex");
}

function assertDigest(actual: string, expected: string | undefined) {
  if (expected !== undefined && actual !== expected.toLowerCase()) {
    throw new FileExchangeError({
      message: "The SHA-256 checksum does not match. No destination file was published.",
    });
  }
}

async function sendFile(
  session: SftpSession,
  localPath: string,
  remotePath: string,
  remoteTemp: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
) {
  const source = await NodeFSP.open(localPath, fileFlags);
  try {
    const contents = await readLocalFile(source);
    const sha256 = digest(contents);
    assertDigest(sha256, expectedSha256);
    await session.writeFile(remoteTemp, contents);
    assertDigest(digest(await session.readFile(remoteTemp, MAX_FILE_BYTES)), sha256);
    try {
      signal.throwIfAborted();
      await session.link(remoteTemp, remotePath);
    } catch {
      throw new FileExchangeError({
        message:
          "The destination could not be created. Check whether the remote file already exists or the connection was interrupted.",
      });
    }
    return { sizeBytes: contents.length, sha256 };
  } finally {
    await source.close();
  }
}

async function receiveFile(
  session: SftpSession,
  localPath: string,
  localTemp: string,
  remotePath: string,
  remoteTemp: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
) {
  // SFTP v3 的 OPEN 会跟随链接。先将目录项硬链接进私有目录，再对该目录项检查类型。
  await session.assertRegularFile(remotePath, MAX_FILE_BYTES);
  await session.link(remotePath, remoteTemp);
  await session.assertRegularFile(remoteTemp, MAX_FILE_BYTES);
  const contents = await session.readFile(remoteTemp, MAX_FILE_BYTES);
  const sha256 = digest(contents);
  assertDigest(sha256, expectedSha256);
  const staging = await NodeFSP.open(localTemp, stagingFlags, 0o600);
  try {
    await staging.writeFile(contents);
    await staging.sync();
    assertDigest(digest(await readLocalFile(staging)), sha256);
    signal.throwIfAborted();
    try {
      await NodeFSP.link(localTemp, localPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new FileExchangeError({ message: "The local destination already exists." });
      }
      throw error;
    }
  } finally {
    await staging.close().finally(() => NodeFSP.unlink(localTemp).catch(() => {}));
  }
  return { sizeBytes: contents.length, sha256 };
}

async function transfer(
  target: ExchangeTarget,
  input: ExchangeInput,
  startSession: (
    alias: string,
    signal: AbortSignal,
  ) => NodeChildProcess.ChildProcessWithoutNullStreams,
  signal: AbortSignal,
) {
  const remoteName = input.remoteName ?? input.localName;
  const directory = await openExchangeDirectory(target);
  try {
    signal.throwIfAborted();
    const child = startSession(target.sshAlias, signal);
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stderr.resume();
    // 连接超时或调用取消时关闭整个 SFTP 子系统，避免余留进程。
    const stopChild = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stopChild, { once: true });
    if (signal.aborted) stopChild();
    try {
      const session = new SftpSession(child);
      await session.initialize();
      if ((await session.realpath(target.remoteDirectory)) !== target.remoteDirectory) {
        throw new FileExchangeError({
          message: "The configured remote directory must be its canonical SFTP path.",
        });
      }
      const temporaryName = `.t3-file-exchange-${NodeCrypto.randomUUID()}`;
      const remoteStage = `${target.remoteDirectory}/${temporaryName}`;
      const remoteTemp = `${remoteStage}/file`;
      const remotePath = `${target.remoteDirectory}/${remoteName}`;
      const localBase = `/proc/self/fd/${directory.fd}`;
      const localPath = `${localBase}/${input.localName}`;
      await session.mkdir(remoteStage);
      try {
        const receipt =
          input.direction === "send"
            ? await sendFile(
                session,
                localPath,
                remotePath,
                remoteTemp,
                input.expectedSha256,
                signal,
              )
            : await receiveFile(
                session,
                localPath,
                `${localBase}/${temporaryName}`,
                remotePath,
                remoteTemp,
                input.expectedSha256,
                signal,
              );
        return {
          deviceId: target.deviceId,
          direction: input.direction,
          workspacePath: `${target.localDirectory}/${input.localName}`,
          remoteName,
          ...receipt,
        };
      } finally {
        await session.remove(remoteTemp).catch(() => {});
        await session.rmdir(remoteStage).catch(() => {});
      }
    } finally {
      signal.removeEventListener("abort", stopChild);
      child.stdin.end();
      stopChild();
      await closed;
    }
  } finally {
    await directory.close();
  }
}

const make = Effect.fn("FileExchange.make")(function* (
  getTargets: () => ReadonlyArray<ExchangeTarget>,
  startSession: (
    alias: string,
    signal: AbortSignal,
  ) => NodeChildProcess.ChildProcessWithoutNullStreams,
) {
  const concurrentConnections = yield* Semaphore.make(2);
  const getTarget = (input: Pick<ExchangeInput, "deviceId" | "workspaceRoot">) =>
    getTargets().find(
      (candidate) =>
        candidate.deviceId === input.deviceId && candidate.workspaceRoot === input.workspaceRoot,
    );
  const withConnection = <A>(
    execute: (signal: AbortSignal) => Promise<A>,
    failureMessage: string,
  ) =>
    concurrentConnections
      .withPermitsIfAvailable(1)(
        Effect.tryPromise({
          try: execute,
          catch: (error) =>
            Schema.is(FileExchangeError)(error)
              ? error
              : new FileExchangeError({ message: failureMessage }),
        }),
      )
      .pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new FileExchangeError({
                  message:
                    "The Linux device service is busy. Retry when another operation has finished.",
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
  return {
    transfer: Effect.fn("FileExchange.transfer")(function* (input: ExchangeInput) {
      if (
        !isExchangeName(input.localName) ||
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
      return yield* withConnection(
        (signal) =>
          transfer(
            target,
            input,
            startSession,
            AbortSignal.any([signal, AbortSignal.timeout(transferTimeoutMs)]),
          ),
        "File exchange failed. Check that both exchange directories and the SFTP connection are available, and check the destination before retrying.",
      );
    }),
    inspect: Effect.fn("FileExchange.inspect")(function* (
      input: Pick<ExchangeInput, "deviceId" | "workspaceRoot"> & {
        readonly check: LinuxDeviceCheck;
      },
    ) {
      const alias = getTarget(input)?.diagnosticsSshAlias;
      if (alias === undefined) {
        return yield* new FileExchangeError({
          message: "This Linux device has no SSH diagnostics configured for the calling workspace.",
        });
      }
      return yield* withConnection(
        (signal) => inspectLinuxDevice(alias, input.check, signal),
        "The Linux device status could not be read. Check the configured diagnostic SSH connection.",
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
  make(readTargets, (alias, signal) =>
    NodeChildProcess.spawn("ssh", ["-s", ...sshConnectionArgs(alias), "sftp"], { signal }),
  ),
);

// 使用测试的 OpenSSH SFTP 子系统进程，不需要真实设备、端口和认证信息。
export const layerForSftpTest = (targets: ReadonlyArray<ExchangeTarget>, serverBinary: string) =>
  Layer.effect(
    FileExchange,
    make(
      () => targets,
      (_alias, signal) => NodeChildProcess.spawn(serverBinary, [], { signal }),
    ),
  );
