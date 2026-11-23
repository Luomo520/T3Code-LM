// @effect-diagnostics nodeBuiltinImport:off -- 此目录与传输记录共用文件系统和原子重命名。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const entryNamePattern = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.json$/;
const decodeEntry = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: ThreadId,
      id: Schema.String.check(
        Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
      ),
      expiresAt: Schema.Int,
    }),
  ),
);
export type FileHandoffInboxEntry = ReturnType<typeof decodeEntry>;

function isMissing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function directoryFor(root: string, recipient: string) {
  const key = NodeCrypto.createHash("sha256").update(recipient).digest("hex");
  return NodePath.join(root, "inbox", key);
}

function entryName(threadKey: string, id: string) {
  return `${threadKey}.${id}.json`;
}

export async function indexFileHandoff(
  root: string,
  recipient: string,
  threadKey: string,
  entry: FileHandoffInboxEntry,
) {
  const directory = directoryFor(root, recipient);
  const temporary = NodePath.join(directory, `${NodeCrypto.randomUUID()}.tmp`);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await NodeFSP.writeFile(temporary, JSON.stringify(entry), {
      flag: "wx",
      flush: true,
      mode: 0o600,
    });
    await NodeFSP.rename(temporary, NodePath.join(directory, entryName(threadKey, entry.id)));
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export async function removeFromFileHandoffInbox(
  root: string,
  recipient: string,
  threadKey: string,
  id: string,
) {
  await NodeFSP.rm(NodePath.join(directoryFor(root, recipient), entryName(threadKey, id)), {
    force: true,
  });
}

export async function indexedFileHandoffs(root: string, recipient: string, now: number) {
  const directory = directoryFor(root, recipient);
  const names = await NodeFSP.readdir(directory).catch((error) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const entries: FileHandoffInboxEntry[] = [];
  for (const name of names) {
    if (!entryNamePattern.test(name)) continue;
    const path = NodePath.join(directory, name);
    const raw = await NodeFSP.readFile(path, "utf8").catch((error) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (!raw) continue;
    let entry: FileHandoffInboxEntry;
    try {
      entry = decodeEntry(raw);
    } catch {
      continue;
    }
    if (entry.expiresAt <= now) {
      await NodeFSP.rm(path, { force: true });
      continue;
    }
    entries.push(entry);
  }
  return entries.sort(
    (left, right) =>
      left.expiresAt - right.expiresAt ||
      left.threadId.localeCompare(right.threadId) ||
      left.id.localeCompare(right.id),
  );
}
