// @effect-diagnostics nodeBuiltinImport:off -- 使用与中转目录一致的线程散列，避免将会话标识作为磁盘路径。
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";

export function captureArchiveDirectory(stateDir: string, threadId: ThreadId) {
  const threadKey = createHash("sha256").update(threadId).digest("hex");
  return join(stateDir, "windows-companion", "captures", threadKey);
}

export function archivedCapturePath(
  directory: string,
  id: string,
  extension: "avi" | "mp4" | "png",
) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(id)
    ? join(directory, `${id}.${extension}`)
    : null;
}

export const archiveCapture = Effect.fn("CompanionCapture.archive")(function* (
  threadId: ThreadId,
  id: string,
  originalPath: string,
  extension: "avi" | "mp4" | "png",
) {
  const fs = yield* FileSystem.FileSystem;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const directory = captureArchiveDirectory(stateDir, threadId);
  const destination = archivedCapturePath(directory, id, extension);
  if (!destination) return originalPath;
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  // 截图和录屏已由受控端任务校验，保留独立目录项让中转清理可以照常执行。
  yield* fs
    .link(originalPath, destination)
    .pipe(Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.void));
  return destination;
});
