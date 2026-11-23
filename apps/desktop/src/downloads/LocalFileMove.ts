// @effect-diagnostics nodeBuiltinImport:off - 桌面原生文件移动需要保留文件句柄并调用 Windows API。
import type { FileHandoffMoveResult } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeUtil from "node:util";
import { BrowserWindow, dialog, type WebContents } from "electron";

const run = NodeUtil.promisify(NodeChildProcess.execFile);

type Selection = {
  readonly token: string;
  readonly path: string;
  readonly handle: NodeFSP.FileHandle;
  readonly identity: string;
  readonly sha256: string;
  readonly sizeBytes: number;
};
const selections = new WeakMap<WebContents, Selection>();
const watchedWindows = new WeakSet<WebContents>();

const windowsFileMove = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

public static class T3SelectedFile {
  const uint GenericRead = 0x80000000U;
  const uint Delete = 0x00010000U;
  const uint ShareRead = 1;
  const uint OpenExisting = 3;
  const uint OpenReparsePoint = 0x00200000U;
  const uint DirectoryOrReparsePoint = 0x410U;
  const int FileBasicInfoClass = 0;
  const int FileDispositionInfoExClass = 21;
  const uint DeleteWithPosixSemantics = 0x3;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
  static extern uint GetDriveTypeW(string rootPath);
  [StructLayout(LayoutKind.Sequential)]
  struct Info {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct BasicInfo {
    public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
    public uint Attributes;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out BasicInfo info, uint size);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref uint info, uint size);

  public static string Check(string path, string expectedIdentity, string expectedHash) {
    bool remove = !String.IsNullOrEmpty(expectedIdentity);
    uint drive = GetDriveTypeW(Path.GetPathRoot(path));
    if (drive != 2 && drive != 3) return "retained";
    uint access = GenericRead | (remove ? Delete : 0);
    // 只允许其他读取者打开，校验与删除使用同一文件对象。
    using (var handle = CreateFileW(@"\\?\" + path, access, ShareRead, IntPtr.Zero, OpenExisting, OpenReparsePoint, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (remove && (error == 2 || error == 3)) return "changed";
        return "retained";
      }
      Info info;
      BasicInfo basic;
      if (!GetFileInformationByHandle(handle, out info) ||
          !GetFileInformationByHandleEx(handle, FileBasicInfoClass, out basic, (uint)Marshal.SizeOf(typeof(BasicInfo))))
        return "retained";
      if ((info.Attributes & DirectoryOrReparsePoint) != 0 || (info.IndexHigh == 0 && info.IndexLow == 0))
        return remove ? "changed" : "retained";

      string identity = String.Join(":", info.Volume, info.IndexHigh, info.IndexLow, basic.CreationTime,
        basic.LastWriteTime, basic.ChangeTime, info.SizeHigh, info.SizeLow);
      if (remove && identity != expectedIdentity) return "changed";
      using (var stream = new FileStream(handle, FileAccess.Read))
      using (var sha256 = SHA256.Create()) {
        string hash = BitConverter.ToString(sha256.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
        if (!remove) return identity + "|" + hash;
        if (hash != expectedHash) return "changed";
        uint flags = DeleteWithPosixSemantics;
        return SetFileInformationByHandle(handle, FileDispositionInfoExClass, ref flags, 4) ? "removed" : "retained";
      }
    }
  }
}
'@
[T3SelectedFile]::Check($env:T3_MOVE_FILE_PATH, $env:T3_MOVE_FILE_ID, $env:T3_MOVE_FILE_SHA)
`;

async function inspectWindowsFile(path: string, identity = "", sha256 = "") {
  const systemRoot = NodeProcess.env.SystemRoot;
  if (!systemRoot) return "retained";
  const powershell = NodePath.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const { stdout } = await run(
    powershell,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(windowsFileMove, "utf16le").toString("base64"),
    ],
    {
      env: {
        ...NodeProcess.env,
        T3_MOVE_FILE_PATH: path,
        T3_MOVE_FILE_ID: identity,
        T3_MOVE_FILE_SHA: sha256,
      },
      windowsHide: true,
    },
  );
  return stdout.trim();
}

export async function pickLocalFileMove(sender: WebContents) {
  const window = BrowserWindow.fromWebContents(sender);
  if (NodeProcess.platform !== "win32" || !window?.isFocused()) return null;
  const result = await dialog.showOpenDialog(window, {
    title: "选择要移动的本机文件",
    properties: ["openFile", "dontAddToRecent"],
  });
  const path = result.filePaths[0];
  if (result.canceled || !path || sender.isDestroyed()) return null;
  if (!/^[a-z]:\\/iu.test(path)) throw new Error("请选择 Windows 本机磁盘上的文件。");
  const snapshot = await inspectWindowsFile(path).catch(() => "");
  const [identity, sha256] = snapshot.split("|");
  if (!identity || !sha256) throw new Error("无法核对所选文件，请检查文件是否在使用中。");
  const handle = await NodeFSP.open(path, "r");
  let accepted = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("请选择普通文件。");
    if (sender.isDestroyed()) return null;
    const previous = selections.get(sender);
    const selection = {
      token: NodeCrypto.randomUUID(),
      path,
      handle,
      identity,
      sha256,
      sizeBytes: stat.size,
    };
    selections.set(sender, selection);
    accepted = true;
    if (!watchedWindows.has(sender)) {
      watchedWindows.add(sender);
      sender.once("destroyed", () => {
        const selected = selections.get(sender);
        if (selected) void discardLocalFileMove(sender, selected.token).catch(() => {});
      });
    }
    if (previous) void previous.handle.close().catch(() => {});
    return { token: selection.token, name: NodePath.win32.basename(path), sizeBytes: stat.size };
  } finally {
    if (!accepted) await handle.close();
  }
}

export async function readLocalFileMove(
  sender: WebContents,
  token: string,
  offset: number,
  length: number,
) {
  const selected = selections.get(sender);
  if (selected?.token !== token || offset + length > selected.sizeBytes) {
    throw new Error("所选文件已失效，请重新选择。");
  }
  const chunk = new Uint8Array(length);
  const { bytesRead } = await selected.handle.read(chunk, 0, length, offset);
  return chunk.subarray(0, bytesRead);
}

export async function discardLocalFileMove(sender: WebContents, token: string) {
  const selected = selections.get(sender);
  if (selected?.token !== token) return;
  selections.delete(sender);
  await selected.handle.close();
}

export async function finishLocalFileMove(
  sender: WebContents,
  token: string,
  sha256: string,
): Promise<FileHandoffMoveResult> {
  const selected = selections.get(sender);
  if (selected?.token !== token) return "retained";
  await discardLocalFileMove(sender, token);
  if (selected.sha256 !== sha256) return "changed";
  try {
    const result = await inspectWindowsFile(selected.path, selected.identity, selected.sha256);
    return result === "removed" || result === "changed" ? result : "retained";
  } catch {
    return "retained";
  }
}
