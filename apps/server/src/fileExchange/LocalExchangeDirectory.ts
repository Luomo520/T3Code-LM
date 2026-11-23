// @effect-diagnostics nodeBuiltinImport:off - Linux 交换目录以逐级打开的文件句柄固定路径。
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import type { ExchangeTarget } from "./config.ts";

export interface ExchangeFileStats {
  readonly size: number;
  readonly nlink: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  isFile(): boolean;
}

export interface ExchangeFile {
  stat(): Promise<ExchangeFileStats>;
  read(
    buffer: Buffer,
    start: number,
    length: number,
    offset: number,
  ): Promise<{ bytesRead: number }>;
  write(
    buffer: Buffer,
    start: number,
    length: number,
    offset: number,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export type SourceDisposition =
  | { readonly status: "removed" }
  | { readonly status: "retained"; readonly message: string; readonly recoveryPath?: string };

export const sourceRetained = (message: string, recoveryPath?: string): SourceDisposition => ({
  status: "retained",
  message,
  ...(recoveryPath === undefined ? {} : { recoveryPath }),
});

export interface ExchangeSource extends ExchangeFile {
  removeAfterVerification(
    temporaryName: string,
    unchanged: (file: ExchangeFile) => Promise<boolean>,
  ): Promise<SourceDisposition>;
}

export interface ExchangeStage {
  readonly file: ExchangeFile;
  publish(name: string): Promise<void>;
  close(): Promise<void>;
}

export interface LocalExchangeDirectory {
  source(name: string, move?: boolean): Promise<ExchangeSource>;
  stage(temporaryName: string): Promise<ExchangeStage>;
  close(): Promise<void>;
}

const directoryFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
const sourceFlags =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW;
const stagingFlags =
  NodeFS.constants.O_RDWR |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_NOFOLLOW;

export async function openLinuxExchangeDirectory(
  target: ExchangeTarget,
): Promise<LocalExchangeDirectory> {
  // 每一步都从已打开的父目录查找，避免路径被重定向到交换目录以外。
  let directory = await NodeFSP.open("/", directoryFlags);
  try {
    const components = [...target.workspaceRoot.slice(1).split("/"), target.localDirectory];
    for (const component of components) {
      const next = await NodeFSP.open(`/proc/self/fd/${directory.fd}/${component}`, directoryFlags);
      await directory.close();
      directory = next;
    }
  } catch (error) {
    await directory.close();
    throw error;
  }

  const path = (name: string) => `/proc/self/fd/${directory.fd}/${name}`;
  return {
    source: async (name) => {
      const sourcePath = path(name);
      const source = await NodeFSP.open(sourcePath, sourceFlags);
      const sameFile = (expected: NodeFS.BigIntStats, actual: typeof expected) =>
        actual.isFile() && expected.dev === actual.dev && expected.ino === actual.ino;
      return Object.assign(source, {
        removeAfterVerification: async (
          temporaryName: string,
          unchanged: (file: ExchangeFile) => Promise<boolean>,
        ) => {
          const selected = await source.stat({ bigint: true });
          if (
            !sameFile(selected, await NodeFSP.lstat(sourcePath, { bigint: true })) ||
            !(await unchanged(source))
          ) {
            return sourceRetained("The local source changed after the destination was saved.");
          }

          const capture = path(temporaryName);
          const captured = `${capture}/source`;
          let capturedSource = false;
          await NodeFSP.mkdir(capture, { mode: 0o700 });
          try {
            // 先原子捕获当前目录项。发现竞争替换后，通过硬链接恢复原名，避免覆盖并发写入。
            await NodeFSP.rename(sourcePath, captured);
            capturedSource = true;
            if (
              sameFile(selected, await NodeFSP.lstat(captured, { bigint: true })) &&
              (await unchanged(source))
            ) {
              await NodeFSP.unlink(captured);
              capturedSource = false;
              return { status: "removed" } as const;
            }
          } catch (error) {
            if (!capturedSource) throw error;
          } finally {
            if (!capturedSource) await NodeFSP.rmdir(capture).catch(() => {});
          }
          try {
            await NodeFSP.link(captured, sourcePath);
            await NodeFSP.unlink(captured);
            await NodeFSP.rmdir(capture).catch(() => {});
            return sourceRetained(
              "The local source changed or could not be removed. It was restored at its original name.",
            );
          } catch {
            return sourceRetained(
              "The local source was preserved in the recovery directory. Check its original name before restoring it.",
              `${target.localDirectory}/${temporaryName}/source`,
            );
          }
        },
      });
    },
    stage: async (name) => {
      const stagingPath = path(name);
      const file = await NodeFSP.open(stagingPath, stagingFlags, 0o600);
      return {
        file,
        publish: (destination) => NodeFSP.link(stagingPath, path(destination)),
        close: () => file.close().finally(() => NodeFSP.unlink(stagingPath).catch(() => {})),
      };
    },
    close: () => directory.close(),
  };
}
