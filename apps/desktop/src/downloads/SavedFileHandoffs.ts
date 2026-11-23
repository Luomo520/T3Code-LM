// @effect-diagnostics nodeBuiltinImport:off - 仅记录和定位本机下载器已保存的文件。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Electron from "electron";
import {
  FILE_HANDOFF_ROUTE_PREFIX,
  type DesktopSavedFileHandoff,
  type DesktopSavedFileHandoffStatus,
} from "@t3tools/contracts";

const receiveRoute = new RegExp(
  `^${FILE_HANDOFF_ROUTE_PREFIX}/handoff\\.receive\\.([a-f0-9]{64})\\.([a-f0-9-]{36})\\.[0-9]{13}\\.[a-zA-Z0-9_-]+$`,
  "u",
);

export function receivedHandoffKey(url: URL) {
  if (url.search || url.hash) return null;
  const match = receiveRoute.exec(url.pathname);
  return match?.[1] && match[2] ? { threadKey: match[1], transferId: match[2] } : null;
}

function recordPath(key: NonNullable<ReturnType<typeof receivedHandoffKey>>) {
  return NodePath.join(
    Electron.app.getPath("userData"),
    "saved-file-handoffs",
    `${key.threadKey}.${key.transferId}.json`,
  );
}

function fileIdentity(stat: Awaited<ReturnType<typeof NodeFSP.lstat>>) {
  return [stat.dev, stat.ino, stat.size, stat.birthtimeMs, stat.mtimeMs].join(":");
}

export async function recordSavedFileHandoff(
  key: NonNullable<ReturnType<typeof receivedHandoffKey>>,
  path: string,
) {
  const record = recordPath(key);
  const stat = await NodeFSP.lstat(path);
  if (!stat.isFile()) return;
  await NodeFSP.mkdir(NodePath.dirname(record), { recursive: true, mode: 0o700 });
  const temporary = `${record}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify({ path, identity: fileIdentity(stat) }), {
      mode: 0o600,
      flag: "wx",
    });
    await NodeFSP.rename(temporary, record);
  } finally {
    await NodeFSP.unlink(temporary).catch(() => undefined);
  }
}

export async function locateSavedFileHandoff(
  input: DesktopSavedFileHandoff,
): Promise<DesktopSavedFileHandoffStatus> {
  if (!/^[a-f0-9-]{36}$/u.test(input.transferId)) return "unknown";
  const threadKey = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex");
  const record = recordPath({ threadKey, transferId: input.transferId });
  let metadata: unknown;
  try {
    metadata = JSON.parse(await NodeFSP.readFile(record, "utf8"));
  } catch (cause) {
    if (cause instanceof SyntaxError || (cause as NodeJS.ErrnoException).code === "ENOENT")
      return "unknown";
    throw cause;
  }
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    !("path" in metadata) ||
    typeof metadata.path !== "string" ||
    !NodePath.isAbsolute(metadata.path) ||
    !("identity" in metadata) ||
    typeof metadata.identity !== "string"
  )
    return "unknown";

  const stat = await NodeFSP.lstat(metadata.path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return null;
    throw cause;
  });
  if (!stat?.isFile() || fileIdentity(stat) !== metadata.identity) return "missing";
  if (input.reveal) Electron.shell.showItemInFolder(metadata.path);
  return "available";
}
