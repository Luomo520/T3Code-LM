// @effect-diagnostics nodeBuiltinImport:off - Windows 交换目录以系统文件句柄固定路径。
import { createRequire } from "node:module";
import type { ExchangeTarget } from "./config.ts";
import {
  sourceRetained,
  type ExchangeFile,
  type LocalExchangeDirectory,
} from "./LocalExchangeDirectory.ts";

const requireForFfi = createRequire(import.meta.url);

// CreateFile 和 SetFileInformationByHandle 的参数来自 Win32 ABI。
const LIST_DIRECTORY_AND_READ_ATTRIBUTES = 0x81;
const GENERIC_READ = 0x80000000;
const GENERIC_READ_WRITE_DELETE = 0xc0010000;
const SHARE_READ = 1;
const OPEN_EXISTING = 3;
const CREATE_NEW = 1;
const FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FLAG_BACKUP_SEMANTICS = 0x02000000;
const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_REPARSE_POINT = 0x400;
const FILE_BASIC_INFO = 0;
const FILE_RENAME_INFORMATION = 10;
const FILE_DISPOSITION_INFO = 4;

function loadApi() {
  const { DataType, load, open } = requireForFfi("ffi-rs") as typeof import("ffi-rs");
  const library = "t3-exchange-kernel32";
  const nt = "t3-exchange-ntdll";
  open({ library, path: "kernel32.dll" });
  open({ library: nt, path: "ntdll.dll" });

  const fromWin32Error = (message: string, errno?: number) =>
    Object.assign(new Error(errno ? `${message} (Win32 ${errno})` : message), {
      code: errno === 80 || errno === 183 ? "EEXIST" : "EIO",
    });

  const openPath = (path: string, access: number, share: number, create: number, flags: number) => {
    const result = load({
      library,
      funcName: "CreateFileW",
      retType: DataType.BigInt,
      paramsType: [
        DataType.WString,
        DataType.U32,
        DataType.U32,
        DataType.BigInt,
        DataType.U32,
        DataType.U32,
        DataType.BigInt,
      ],
      paramsValue: [path, access, share, 0n, create, flags, 0n],
      errno: true as const,
    });
    const handle = BigInt(result.value.toString());
    if (handle === -1n)
      throw fromWin32Error("The Windows exchange path could not be opened.", result.errnoCode);
    return handle;
  };

  const close = (handle: bigint) => {
    load({
      library,
      funcName: "CloseHandle",
      retType: DataType.I32,
      paramsType: [DataType.BigInt],
      paramsValue: [handle],
    });
  };

  const flushFile = async (handle: bigint) => {
    const result = await load({
      library,
      funcName: "FlushFileBuffers",
      retType: DataType.I32,
      paramsType: [DataType.BigInt],
      paramsValue: [handle],
      errno: true as const,
      runInNewThread: true as const,
    });
    if (result.value === 0)
      throw fromWin32Error("The Windows exchange file could not be flushed.", result.errnoCode);
  };

  const query = (handle: bigint) => {
    // BY_HANDLE_FILE_INFORMATION 由 DWORD 和 FILETIME 组成，64 位 Windows 布局为 52 字节。
    const info = Buffer.alloc(52);
    const result = load({
      library,
      funcName: "GetFileInformationByHandle",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.U8Array],
      paramsValue: [handle, info],
      errno: true as const,
    });
    if (result.value === 0)
      throw fromWin32Error("The Windows exchange file could not be inspected.", result.errnoCode);
    return {
      attributes: info.readUInt32LE(0),
      size: info.readUInt32LE(32) * 0x100000000 + info.readUInt32LE(36),
      nlink: info.readUInt32LE(40),
    };
  };

  const volumePath = (root: bigint) => {
    // 由已打开的卷根解析卷 GUID。后续查找沿用固定卷，避免盘符重新映射。
    const buffer = Buffer.alloc(1024);
    const capacity = buffer.length / 2;
    const length = load({
      library,
      funcName: "GetFinalPathNameByHandleW",
      retType: DataType.U32,
      paramsType: [DataType.BigInt, DataType.U8Array, DataType.U32, DataType.U32],
      paramsValue: [root, buffer, capacity, 1],
    });
    if (length === 0 || length >= capacity) {
      throw new Error("The Windows exchange drive must resolve to a local volume.");
    }
    const path = buffer.subarray(0, length * 2).toString("utf16le");
    if (!/^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/iu.test(path)) {
      throw new Error("The Windows exchange drive must resolve to a local volume root.");
    }
    return path;
  };

  const timestamps = (handle: bigint) => {
    const info = Buffer.alloc(40);
    const result = load({
      library,
      funcName: "GetFileInformationByHandleEx",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.I32, DataType.U8Array, DataType.U32],
      paramsValue: [handle, FILE_BASIC_INFO, info, info.length],
      errno: true as const,
    });
    if (result.value === 0)
      throw fromWin32Error(
        "The Windows exchange file timestamps could not be inspected.",
        result.errnoCode,
      );
    const milliseconds = (offset: number) =>
      Number(info.readBigInt64LE(offset) - 116444736000000000n) / 10_000;
    return { mtimeMs: milliseconds(16), ctimeMs: milliseconds(24) };
  };

  const setInfo = (handle: bigint, kind: number, info: Buffer) => {
    const result = load({
      library,
      funcName: "SetFileInformationByHandle",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.I32, DataType.U8Array, DataType.U32],
      paramsValue: [handle, kind, info, info.length],
      errno: true as const,
    });
    if (result.value === 0)
      throw fromWin32Error("The Windows exchange file could not be updated.", result.errnoCode);
  };

  const renameInDirectory = (handle: bigint, destination: string) => {
    // 相同目录内只传文件名，NtSetInformationFile 不需要按路径重新打开目标目录。
    const fileName = Buffer.from(destination, "utf16le");
    const info = Buffer.alloc(Math.max(24, 20 + fileName.length));
    info.writeUInt32LE(fileName.length, 16);
    fileName.copy(info, 20);
    const status = load({
      library: nt,
      funcName: "NtSetInformationFile",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.U8Array, DataType.U8Array, DataType.U32, DataType.I32],
      paramsValue: [handle, Buffer.alloc(16), info, info.length, FILE_RENAME_INFORMATION],
    });
    if (status < 0) {
      const errno = load({
        library: nt,
        funcName: "RtlNtStatusToDosError",
        retType: DataType.U32,
        paramsType: [DataType.I32],
        paramsValue: [status],
      });
      throw fromWin32Error("The Windows exchange file could not be published.", errno);
    }
  };

  const transfer = async (
    kind: "ReadFile" | "WriteFile",
    handle: bigint,
    data: Buffer,
    offset: number,
  ) => {
    const seek = load({
      library,
      funcName: "SetFilePointerEx",
      retType: DataType.I32,
      paramsType: [DataType.BigInt, DataType.BigInt, DataType.BigInt, DataType.U32],
      paramsValue: [handle, BigInt(offset), 0n, 0],
      errno: true as const,
    });
    if (seek.value === 0)
      throw fromWin32Error("The Windows exchange file offset could not be set.", seek.errnoCode);

    const out = Buffer.alloc(4);
    const result = await load({
      library,
      funcName: kind,
      retType: DataType.I32,
      paramsType: [
        DataType.BigInt,
        DataType.U8Array,
        DataType.U32,
        DataType.U8Array,
        DataType.BigInt,
      ],
      paramsValue: [handle, data, data.length, out, 0n],
      errno: true as const,
      runInNewThread: true as const,
    });
    if (result.value === 0)
      throw fromWin32Error(
        "The Windows exchange file data could not be transferred.",
        result.errnoCode,
      );
    return out.readUInt32LE(0);
  };

  return {
    openPath,
    close,
    flushFile,
    query,
    volumePath,
    timestamps,
    setInfo,
    renameInDirectory,
    transfer,
  };
}

let api: ReturnType<typeof loadApi> | undefined;

export async function openWindowsExchangeDirectory(
  target: ExchangeTarget,
): Promise<LocalExchangeDirectory> {
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("Windows file exchange requires a 64-bit server.");
  }
  const win32 = (api ??= loadApi());
  const root = target.workspaceRoot.replaceAll("/", "\\");
  const volume = root.slice(0, 3);
  const parents: bigint[] = [];
  const close = async () => {
    for (const handle of parents.reverse()) win32.close(handle);
    parents.length = 0;
  };
  let directoryPath = `\\\\?\\${volume}`;

  function pinDirectory(path: string) {
    // 持有所有祖先的句柄，拒绝并发删除、重命名及改写重解析信息。
    const handle = win32.openPath(
      path,
      LIST_DIRECTORY_AND_READ_ATTRIBUTES,
      SHARE_READ,
      OPEN_EXISTING,
      FLAG_BACKUP_SEMANTICS | FLAG_OPEN_REPARSE_POINT,
    );
    parents.push(handle);
    const { attributes } = win32.query(handle);
    if (!(attributes & ATTRIBUTE_DIRECTORY) || attributes & ATTRIBUTE_REPARSE_POINT) {
      throw new Error("Windows exchange directories must be directories without reparse points.");
    }
    return handle;
  }

  try {
    directoryPath = win32.volumePath(pinDirectory(directoryPath));
    const parts = [...root.slice(3).split("\\").filter(Boolean), target.localDirectory];
    for (const component of parts) {
      if (!directoryPath.endsWith("\\")) directoryPath += "\\";
      directoryPath += component;
      pinDirectory(directoryPath);
    }
  } catch (error) {
    await close();
    throw error;
  }

  const path = (name: string) => `${directoryPath}\\${name}`;
  const makeFile = (handle: bigint): ExchangeFile => ({
    stat: async () => {
      const { size, nlink, attributes } = win32.query(handle);
      return {
        size,
        nlink,
        ...win32.timestamps(handle),
        isFile: () => (attributes & (ATTRIBUTE_DIRECTORY | ATTRIBUTE_REPARSE_POINT)) === 0,
      };
    },
    read: async (buffer, start, length, offset) => ({
      bytesRead: await win32.transfer(
        "ReadFile",
        handle,
        buffer.subarray(start, start + length),
        offset,
      ),
    }),
    write: async (buffer, start, length, offset) => ({
      bytesWritten: await win32.transfer(
        "WriteFile",
        handle,
        buffer.subarray(start, start + length),
        offset,
      ),
    }),
    sync: () => win32.flushFile(handle),
    close: async () => win32.close(handle),
  });

  return {
    source: async (name, move) => {
      const openSource = (access: number) =>
        win32.openPath(path(name), access, SHARE_READ, OPEN_EXISTING, FLAG_OPEN_REPARSE_POINT);
      let handle: bigint;
      let canDelete = move === true;
      try {
        handle = openSource(canDelete ? GENERIC_READ + 0x10000 : GENERIC_READ);
      } catch (error) {
        if (!canDelete) throw error;
        canDelete = false;
        handle = openSource(GENERIC_READ);
      }
      const file = makeFile(handle);
      return {
        ...file,
        removeAfterVerification: async (_, unchanged) => {
          if (!canDelete || !(await unchanged(file))) {
            return sourceRetained("The local source changed or cannot be deleted.");
          }
          // 删除依据已打开的文件句柄。句柄在校验至删除之间拒绝共享写入和重命名。
          win32.setInfo(handle, FILE_DISPOSITION_INFO, Buffer.of(1));
          return { status: "removed" };
        },
      };
    },
    stage: async (name) => {
      const handle = win32.openPath(
        path(name),
        GENERIC_READ_WRITE_DELETE,
        0,
        CREATE_NEW,
        FLAG_OPEN_REPARSE_POINT,
      );
      let published = false;
      return {
        file: makeFile(handle),
        publish: async (destination) => {
          win32.renameInDirectory(handle, destination);
          published = true;
        },
        close: async () => {
          try {
            if (!published) win32.setInfo(handle, FILE_DISPOSITION_INFO, Buffer.of(1));
          } finally {
            win32.close(handle);
          }
        },
      };
    },
    close,
  };
}
