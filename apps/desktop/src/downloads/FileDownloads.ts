// @effect-diagnostics nodeBuiltinImport:off - Electron downloads use native paths and save dialogs.
// @effect-diagnostics globalTimers:off - Bounded Electron event registration timeout; no idle timer.
// Native downloads run only after an explicit renderer request.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Electron from "electron";
import {
  FILE_HANDOFF_ROUTE_PREFIX,
  type DesktopAutomaticFileDownload,
  type DesktopFileDownloadEvent,
} from "@t3tools/contracts";
import { downloadKey, downloadToFile } from "./ResumableDownload.ts";

const active = new Map<string, { cancel: () => void; senderId: number }>();
const builtinDestinations = new Set<string>();
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
    // Windows filenames cannot contain control bytes.
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 180);
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? `download-${name || "file"}`
    : name;
}

function startBuiltinDownload(
  sender: Electron.WebContents,
  id: string,
  url: string,
  fileName: string,
  path: string,
  automatic?: Pick<DesktopAutomaticFileDownload, "sizeBytes" | "sha256">,
) {
  const destinationKey = NodePath.resolve(path).toLowerCase();
  if (builtinDestinations.has(destinationKey)) {
    throw new Error("已有文件正在下载到此位置。");
  }
  const controller = new AbortController();
  builtinDestinations.add(destinationKey);
  active.set(id, { cancel: () => controller.abort(), senderId: sender.id });
  let receivedBytes = 0;
  let totalBytes = 0;
  let previousProgress = -1;
  const source = new URL(url);
  const fileHandoff = source.pathname.startsWith(FILE_HANDOFF_ROUTE_PREFIX + "/");
  const send = (state: DesktopFileDownloadEvent["state"]) => {
    if (!sender.isDestroyed())
      sender.send("desktop:file-download-event", {
        id,
        fileName,
        state,
        receivedBytes,
        totalBytes,
        ...(fileHandoff && state === "completed" ? { savedPath: path } : {}),
      } satisfies DesktopFileDownloadEvent);
  };
  // Asset URLs rotate per request. The strong ETag identifies the file version within its origin.
  send("progressing");
  const fetch = (input: string, options: RequestInit) => sender.session.fetch(input, options);
  const transfer = async () => {
    let checksums: readonly { algorithm: "sha256"; expectedHex: string }[] | undefined;
    if (fileHandoff) {
      const head = await fetch(url, { method: "HEAD", signal: controller.signal });
      const expectedHex = /^"sha256-([0-9a-f]{64})"$/.exec(head.headers.get("etag") ?? "")?.[1];
      if (!head.ok || !expectedHex || (automatic && automatic.sha256 !== expectedHex))
        throw new Error("下载文件缺少与传输记录一致的 SHA-256。");
      checksums = [{ algorithm: "sha256", expectedHex }];
    }
    await downloadToFile({
      fetch,
      ...(checksums ? { checksums } : {}),
      ...(automatic ? { expectedSizeBytes: automatic.sizeBytes, exclusiveDestination: true } : {}),
      url,
      destination: path,
      stagingDirectory: NodePath.join(
        NodePath.dirname(path),
        `.t3-download-${downloadKey(destinationKey).slice(0, 32)}`,
      ),
      source: source.origin,
      signal: controller.signal,
      onProgress: (progress) => {
        receivedBytes = progress.receivedBytes;
        totalBytes = progress.totalBytes;
        const current =
          totalBytes > 0
            ? Math.floor((100 * receivedBytes) / totalBytes)
            : Math.floor(receivedBytes / 1048576);
        if (current === previousProgress) return;
        previousProgress = current;
        send("progressing");
      },
    });
  };
  const completed = transfer()
    .then(
      () => {
        send("completed");
        return true;
      },
      () => {
        send(controller.signal.aborted ? "cancelled" : "interrupted");
        return false;
      },
    )
    .finally(() => {
      builtinDestinations.delete(destinationKey);
      active.delete(id);
    });
  return { method: "builtin" as const, id, completed };
}

const incomingHandoffs = new Map<string, Promise<{ savedPath: string }>>();

async function automaticDestination(
  fileName: string,
  { transferId, sizeBytes, sha256 }: DesktopAutomaticFileDownload,
) {
  const directory = await downloadDirectory();
  await NodeFSP.mkdir(directory, { recursive: true });
  const { name, ext } = NodePath.parse(fileName);
  for (let attempt = 0; ; attempt++) {
    const suffix =
      attempt === 1 ? ` (${transferId.slice(-8)})` : ` (${transferId.slice(-8)}-${attempt})`;
    const candidate = NodePath.join(directory, attempt === 0 ? fileName : `${name}${suffix}${ext}`);
    if (builtinDestinations.has(NodePath.resolve(candidate).toLowerCase())) continue;
    let stat;
    try {
      stat = await NodeFSP.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { path: candidate, verified: false };
    }
    if (stat.isFile() && stat.size === sizeBytes) {
      // 回执发送前若桌面退出，重启后可以从默认位置复核已经写好的文件。
      const hash = NodeCrypto.createHash("sha256");
      try {
        for await (const chunk of NodeFS.createReadStream(candidate)) hash.update(chunk);
        if (hash.digest("hex") === sha256) return { path: candidate, verified: true };
      } catch {
        // 同名文件可能正被其他程序使用，继续保留它并选择另一个文件名。
      }
    }
  }
}

export async function downloadHandoffFile(
  input: DesktopAutomaticFileDownload,
  senderId: number | undefined,
): Promise<{ savedPath: string }> {
  const url = new URL(validateDownloadUrl(input.url));
  const token = url.pathname.slice(FILE_HANDOFF_ROUTE_PREFIX.length + 1);
  if (
    !url.pathname.startsWith(FILE_HANDOFF_ROUTE_PREFIX + "/") ||
    !/^handoff\.receive\.[0-9a-f]{64}\.[0-9a-f-]{36}\.[0-9]{13}\.[a-zA-Z0-9_-]+$/u.test(token) ||
    token.split(".")[3] !== input.transferId ||
    url.search ||
    url.hash
  )
    throw new Error("文件传输地址无效。");
  const sender = senderId === undefined ? undefined : Electron.webContents.fromId(senderId);
  if (!sender || sender.isDestroyed()) throw new Error("下载窗口已关闭，请重试。");
  const key = JSON.stringify([url.origin, input.transferId, input.sha256, input.sizeBytes]);
  const existing = incomingHandoffs.get(key);
  if (existing) return existing;

  const fileName = safeDownloadName(input.fileName);
  const launch = starting.then(async () => {
    const { path, verified } = await automaticDestination(fileName, input);
    if (verified) return { path, task: null };
    const task = startBuiltinDownload(
      sender,
      NodeCrypto.randomUUID(),
      url.href,
      fileName,
      path,
      input,
    );
    return { path, task };
  });
  starting = launch.catch(() => undefined);
  const operation = launch.then(async ({ path, task }) => {
    if (task && !(await task.completed)) throw new Error("文件领取或校验中断，请重试。");
    return { savedPath: path };
  });
  incomingHandoffs.set(key, operation);
  void operation.then(
    () => {
      if (incomingHandoffs.size > 1024) {
        const oldest = incomingHandoffs.keys().next().value;
        if (oldest !== undefined) incomingHandoffs.delete(oldest);
      }
    },
    () => incomingHandoffs.delete(key),
  );
  return operation;
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
  if (platform === "win32" || new URL(url).pathname.startsWith(FILE_HANDOFF_ROUTE_PREFIX + "/")) {
    const task = startBuiltinDownload(sender, id, url, fileName, path);
    return { method: task.method, id: task.id };
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
      active.set(id, { cancel: () => item.cancel(), senderId: sender.id });
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
  if (task && task.senderId === senderId) task.cancel();
}
