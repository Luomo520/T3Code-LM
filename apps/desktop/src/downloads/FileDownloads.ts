// @effect-diagnostics nodeBuiltinImport:off - Native IDM spawn events and Electron downloads use Node APIs.
// @effect-diagnostics globalTimers:off - Bounded Electron event registration timeout; no idle timer.
// Native downloads run only after an explicit renderer request.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Electron from "electron";
import type { DesktopFileDownloadEvent } from "@t3tools/contracts";

const active = new Map<string, { item: Electron.DownloadItem; senderId: number }>();
let starting: Promise<unknown> = Promise.resolve();
let lastDirectory: string | undefined;
async function downloadDirectory(): Promise<string> {
  if (lastDirectory) return lastDirectory;
  try {
    const saved: unknown = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(Electron.app.getPath("userData"), "file-downloads.json"),
        "utf8",
      ),
    );
    if (
      typeof saved === "object" &&
      saved !== null &&
      "directory" in saved &&
      typeof saved.directory === "string"
    )
      lastDirectory = saved.directory;
  } catch {
    /* A first download uses the system Downloads folder. */
  }
  return lastDirectory ?? Electron.app.getPath("downloads");
}

export function validateDownloadUrl(raw: string): string {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/api/assets/")
  )
    throw new Error("下载地址无效，请重新点击文件下载。");
  return url.href;
}

export function safeDownloadName(raw: string): string {
  const name = raw
    // eslint-disable-next-line no-control-regex -- Windows filenames cannot contain control bytes.
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 180);
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? `download-${name || "file"}`
    : name;
}

async function findIdm(platform: string): Promise<string | null> {
  if (platform !== "win32") return null;
  const candidates: string[] = [];
  for (const hive of ["HKCU", "HKLM"]) {
    for (const view of ["/reg:64", "/reg:32"]) {
      const output = await new Promise<string>((resolve) =>
        NodeChildProcess.execFile(
          "reg.exe",
          [
            "query",
            `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\IDMan.exe`,
            "/ve",
            view,
          ],
          { windowsHide: true },
          (error, stdout) => resolve(error ? "" : stdout),
        ),
      );
      const match = /REG_SZ\s+(.+)$/im.exec(output);
      if (match?.[1]) candidates.push(match[1].trim().replace(/^"|"$/g, ""));
    }
  }
  for (const root of [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ]) {
    if (root) candidates.push(NodePath.join(root, "Internet Download Manager", "IDMan.exe"));
  }
  for (const candidate of candidates) {
    try {
      await NodeFSP.access(candidate);
      return candidate;
    } catch {
      /* Try the next installed location. */
    }
  }
  return null;
}

export function downloadFile(
  input: { url: string; fileName: string },
  senderId: number | undefined,
  platform: string,
) {
  const result = starting.then(() => performDownload(input, senderId, platform));
  starting = result.catch(() => undefined);
  return result;
}

async function performDownload(
  input: { url: string; fileName: string },
  senderId: number | undefined,
  platform: string,
) {
  const url = validateDownloadUrl(input.url);
  const fileName = safeDownloadName(input.fileName);
  const idm = await findIdm(platform);
  if (idm) {
    const started = await new Promise<boolean>((resolve) => {
      const child = NodeChildProcess.spawn(idm, ["/d", url, "/f", fileName], {
        shell: false,
        detached: true,
        windowsHide: false,
        stdio: "ignore",
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    });
    if (started) return { method: "idm" as const };
  }
  const sender = senderId === undefined ? undefined : Electron.webContents.fromId(senderId);
  if (!sender || sender.isDestroyed()) throw new Error("下载窗口已关闭，请重试。");
  const owner = Electron.BrowserWindow.fromWebContents(sender);
  const options: Electron.SaveDialogOptions = {
    title: "下载文件",
    defaultPath: NodePath.join(await downloadDirectory(), fileName),
  };
  const destination = owner
    ? await Electron.dialog.showSaveDialog(owner, options)
    : await Electron.dialog.showSaveDialog(options);
  if (destination.canceled || !destination.filePath) return { method: "cancelled" as const };
  const id = NodeCrypto.randomUUID();
  const path = destination.filePath;
  lastDirectory = NodePath.dirname(path);
  try {
    await NodeFSP.writeFile(
      NodePath.join(Electron.app.getPath("userData"), "file-downloads.json"),
      JSON.stringify({ directory: lastDirectory }),
    );
  } catch {
    /* The selection remains available for this app session. */
  }
  await new Promise<void>((resolve, reject) => {
    const session = sender.session;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("下载未能启动，请重试。"));
    }, 30000);
    const cleanup = () => {
      clearTimeout(timer);
      session.removeListener("will-download", onDownload);
    };
    const onDownload = (
      _event: Electron.Event,
      item: Electron.DownloadItem,
      source: Electron.WebContents,
    ) => {
      if (source?.id !== senderId || item.getURLChain()[0] !== url) return;
      cleanup();
      item.setSavePath(path);
      active.set(id, { item, senderId: sender.id });
      let previousProgress = -1;
      const send = (state: DesktopFileDownloadEvent["state"]) => {
        if (!sender.isDestroyed())
          sender.send("desktop:file-download-event", {
            id,
            fileName,
            state,
            receivedBytes: item.getReceivedBytes(),
            totalBytes: item.getTotalBytes(),
          } satisfies DesktopFileDownloadEvent);
      };
      item.on("updated", () => {
        const progress =
          item.getTotalBytes() > 0
            ? Math.floor((item.getReceivedBytes() / item.getTotalBytes()) * 100)
            : Math.floor(item.getReceivedBytes() / 1048576);
        if (progress !== previousProgress) {
          previousProgress = progress;
          send("progressing");
        }
      });
      item.once("done", (_event, state) => {
        active.delete(id);
        send(state);
      });
      resolve();
    };
    session.on("will-download", onDownload);
    try {
      sender.downloadURL(url);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
  return { method: "electron" as const, id };
}

export function cancelFileDownload(id: string, senderId?: number): void {
  const task = active.get(id);
  if (task && task.senderId === senderId) task.item.cancel();
}
