// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import {
  COMPANION_MAX_IMAGE_BYTES,
  ThreadId,
  type AndroidCaptureAction,
  type AndroidCaptureFailure,
  type AndroidCaptureInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { archivedCapturePath, captureArchiveDirectory } from "./captureArchive.ts";
import { CompanionError, decodePng } from "./store.ts";

const RECEIVED = "手机已收到请求，等待本机处理。";
const RECORDING = "手机已开始录屏。";
const REQUEST_TTL = 45_000;
// 后台检查的运行时机由 Android 决定，等待本机确认的请求需要独立的有效期。
const BACKGROUND_REQUEST_TTL = 10 * 60_000;
const BACKGROUND_DEVICE_TTL = 2 * 60 * 60_000;
const CAPTURE_TTL = 90_000;
const HEARTBEAT_TTL = 20_000;
const HISTORY_TTL = 2 * 86_400_000;
type Action = typeof AndroidCaptureAction.Type;
type Failure = typeof AndroidCaptureFailure.Type;
type Delivery = Extract<typeof AndroidCaptureInput.Type, { _tag: "listen" }>["delivery"];
type Status = "queued" | "running" | "done" | "failed" | "canceled";

type CaptureRow = {
  id: string;
  thread_id: string;
  device_id: string;
  device_name: string;
  request_id: string;
  action: Action;
  seconds: number;
  expires_at: number;
  updated_at: number;
  status: Status;
  message: string;
  digest: string | null;
};

const failureMessages: Record<Failure, string> = {
  denied: "手机用户拒绝了本次屏幕捕获。",
  locked: "手机锁屏，已结束本次屏幕捕获。",
  revoked: "Android 已撤销本次屏幕捕获授权。",
  canceled: "本次屏幕捕获已取消。",
  failed: "手机未能完成本次屏幕捕获。",
};

function decodeMp4(base64: string) {
  const data = Buffer.from(base64, "base64");
  const invalid = new CompanionError(415, "Android recording must be a complete MP4.");
  if (data.length > COMPANION_MAX_IMAGE_BYTES || data.toString("base64") !== base64) throw invalid;
  const types = new Set<string>();
  let offset = 0;
  let boxes = 0;
  while (offset + 8 <= data.length && ++boxes <= 32) {
    const shortSize = data.readUInt32BE(offset);
    const remaining = data.length - offset;
    // Android 的 MPEG4Writer 即使只录几秒，也可能给 mdat 使用 64 位长度。
    const header = shortSize === 1 ? 16 : 8;
    if (remaining < header) throw invalid;
    const wideSize = shortSize === 1 ? data.readBigUInt64BE(offset + 8) : null;
    if (wideSize !== null && wideSize > BigInt(remaining)) throw invalid;
    const size = wideSize !== null ? Number(wideSize) : shortSize || remaining;
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (size < header || size > remaining || (offset === 0 && type !== "ftyp")) {
      throw invalid;
    }
    if (type === "mdat" && size <= header) throw invalid;
    types.add(type);
    offset += size;
  }
  if (offset !== data.length || !types.has("moov") || !types.has("mdat")) throw invalid;
  return data;
}

export function isAndroidCaptureDevice(id: string) {
  return id.startsWith("android:");
}

export function createAndroidCaptureStore(stateDir: string, now = Date.now) {
  const directory = NodePath.join(stateDir, "android-capture");
  NodeFS.mkdirSync(directory, { mode: 0o700, recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "tasks.sqlite"), {
    allowExtension: false,
  });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 2500;
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      seconds INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      digest TEXT,
      UNIQUE(thread_id, request_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS android_captures_by_device ON tasks(device_id, status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS android_capture_running ON tasks(device_id)
      WHERE status = 'running';
  `);
  // 当前进程记录前台与后台的接收期限。重启后客户端会重新报告。
  const devices = new Map<
    string,
    { name: string; foregroundUntil: number; backgroundUntil: number }
  >();

  function sweep() {
    const time = now();
    db.prepare(`
      UPDATE tasks SET status = 'failed', message = 'Android 屏幕捕获请求已过期。', updated_at = ?
      WHERE expires_at <= ? AND status IN ('queued', 'running')
    `).run(time, time);
    db.prepare(`
      DELETE FROM tasks WHERE updated_at <= ? AND status NOT IN ('queued', 'running')
    `).run(time - HISTORY_TTL);
    for (const [id, device] of devices) {
      if (Math.max(device.foregroundUntil, device.backgroundUntil) <= time) devices.delete(id);
    }
    return time;
  }
  const byId = db.prepare("SELECT * FROM tasks WHERE id = ?");
  const read = (id: string) => byId.get(id) as CaptureRow | undefined;
  const owned = (deviceId: string, id: string) => {
    const task = read(id);
    if (task?.device_id !== deviceId) throw new CompanionError(404, "Android capture not found.");
    return task;
  };
  const inThread = (threadId: string, id: string) => {
    const task = read(id);
    if (task?.thread_id !== threadId) throw new CompanionError(404, "Android capture not found.");
    return task;
  };
  const update = db.prepare(
    "UPDATE tasks SET status = ?, message = ?, updated_at = ? WHERE id = ?",
  );
  const job = (task: CaptureRow, time: number) => ({
    id: task.id,
    progressReceipts: true as const,
    threadId: ThreadId.make(task.thread_id),
    action: task.action,
    durationSeconds: task.seconds,
    expiresAt: task.expires_at,
    expiresInMs: task.expires_at - time,
  });
  function taskView(task: CaptureRow) {
    const archive =
      task.status === "done" &&
      archivedCapturePath(
        captureArchiveDirectory(stateDir, ThreadId.make(task.thread_id)),
        task.id,
        task.action === "screenshot" ? "png" : "mp4",
      );
    return {
      id: task.id,
      action: task.action,
      status: task.status,
      updatedAt: new Date(task.updated_at).toISOString(),
      message: task.message,
      deviceName: task.device_name,
      ...(archive && task.action === "screenshot" ? { imagePath: archive } : {}),
      ...(archive && task.action === "record-screen" ? { recordingPath: archive } : {}),
    };
  }

  return {
    close: () => db.close(),
    list() {
      const time = sweep();
      return [...devices.entries()].map(([deviceId, device]) => ({
        deviceId,
        name: device.name,
        online: device.foregroundUntil > time,
        ...(device.backgroundUntil > time ? { backgroundReady: true as const } : {}),
        platform: "android" as const,
      }));
    },
    listen(deviceId: string, name: string, delivery?: Delivery) {
      const time = sweep();
      if (delivery === "unavailable") {
        devices.delete(deviceId);
        // 两项授权均关闭时立即结束该配对设备的请求，让原会话收到结果。
        db.prepare(`
          UPDATE tasks SET status = 'failed', message = ?, updated_at = ?
          WHERE device_id = ? AND status IN ('queued', 'running')
        `).run(failureMessages.denied, time, deviceId);
        return { _tag: "pending" as const, job: null };
      } else if (delivery !== "background" && (devices.size < 128 || devices.has(deviceId))) {
        devices.set(deviceId, {
          name,
          foregroundUntil: time + HEARTBEAT_TTL,
          backgroundUntil: delivery === "background-ready" ? time + BACKGROUND_DEVICE_TTL : 0,
        });
      }
      const task = db
        .prepare(`
        SELECT * FROM tasks WHERE device_id = ? AND status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM tasks WHERE device_id = ? AND status = 'running')
        ORDER BY updated_at, id LIMIT 1
      `)
        .get(deviceId, deviceId) as CaptureRow | undefined;
      return {
        _tag: "pending" as const,
        job: task ? job(task, time) : null,
        ...(delivery === "background-ready" && devices.has(deviceId)
          ? { backgroundReady: true as const }
          : {}),
      };
    },
    enqueue(
      threadId: string,
      deviceId: string,
      action: Action,
      requestId: string,
      seconds: number,
    ) {
      const time = sweep();
      const existing = db
        .prepare("SELECT * FROM tasks WHERE thread_id = ? AND request_id = ?")
        .get(threadId, requestId) as CaptureRow | undefined;
      if (existing) {
        if (
          existing.device_id !== deviceId ||
          existing.action !== action ||
          existing.seconds !== seconds
        ) {
          throw new CompanionError(409, "The request identifier has already been used.");
        }
        return taskView(existing);
      }
      const device = devices.get(deviceId);
      if (!device)
        throw new CompanionError(409, "请在目标手机打开已配对的 T3 App，刷新请求接收状态。");
      const pending = Number(
        db
          .prepare(`
        SELECT COUNT(*) AS count FROM tasks WHERE device_id = ? AND status IN ('queued', 'running')
      `)
          .get(deviceId)?.count ?? 0,
      );
      if (pending !== 0) throw new CompanionError(409, "目标手机已有一项屏幕捕获请求。");
      const id = NodeCrypto.randomUUID();
      db.prepare(`
        INSERT INTO tasks (id, thread_id, device_id, device_name, request_id, action, seconds,
          expires_at, updated_at, status, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', '已排队，等待手机接收。')
      `).run(
        id,
        threadId,
        deviceId,
        device.name,
        requestId,
        action,
        seconds,
        time + (device.backgroundUntil > time ? BACKGROUND_REQUEST_TTL : REQUEST_TTL),
        time,
      );
      return taskView(inThread(threadId, id));
    },
    progress(deviceId: string, id: string, stage: "received" | "recording") {
      const time = sweep();
      const task = owned(deviceId, id);
      const receiving = stage === "received" && task.status === "queued";
      const recording =
        stage === "recording" && task.status === "running" && task.action === "record-screen";
      const message = receiving ? RECEIVED : recording ? RECORDING : undefined;
      // 手机重连和事件延迟均可能重送回执。终态和原有到期时间应保留。
      if (message && task.message !== message) {
        db.prepare("UPDATE tasks SET message = ?, updated_at = ? WHERE id = ? AND status = ?").run(
          message,
          time,
          id,
          task.status,
        );
      }
    },
    approve(deviceId: string, id: string) {
      const time = sweep();
      const task = owned(deviceId, id);
      // 对同一明确选择的重试返回同一任务。失效或他机任务不能进入采集。
      if (task.status === "queued") {
        db.prepare(`
          UPDATE tasks SET status = 'running', message = '等待 Android 系统屏幕捕获授权。',
            updated_at = ?, expires_at = ? WHERE id = ? AND status = 'queued'
        `).run(time, time + CAPTURE_TTL, id);
      }
      return this.status(deviceId, id);
    },
    status(deviceId: string, id: string) {
      const time = sweep();
      const task = owned(deviceId, id);
      return task.status === "running"
        ? { _tag: "active" as const, job: job(task, time) }
        : { _tag: "inactive" as const };
    },
    reject(deviceId: string, id: string, reason: Failure) {
      const time = sweep();
      const task = owned(deviceId, id);
      if (task.status === "queued" || task.status === "running") {
        update.run("failed", failureMessages[reason], time, id);
      }
    },
    complete(deviceId: string, id: string, media: string) {
      const time = sweep();
      const task = owned(deviceId, id);
      if (task.status !== "running" && task.status !== "done") {
        throw new CompanionError(409, "Android capture is no longer active.");
      }
      const data = task.action === "screenshot" ? decodePng(media) : decodeMp4(media);
      const digest = NodeCrypto.createHash("sha256").update(data).digest("hex");
      if (task.status === "done") {
        if (task.digest === digest) return;
        throw new CompanionError(409, "Android capture already finished.");
      }
      const archive = captureArchiveDirectory(stateDir, ThreadId.make(task.thread_id));
      const file = archivedCapturePath(archive, id, task.action === "screenshot" ? "png" : "mp4")!;
      NodeFS.mkdirSync(archive, { mode: 0o700, recursive: true });
      // 临时文件完整写入后才出现正式文件名。服务重启后可复用同一份字节补记回执。
      const temporary = NodePath.join(archive, `.${id}.${NodeCrypto.randomUUID()}.part`);
      try {
        NodeFS.writeFileSync(temporary, data, { flag: "wx", mode: 0o600 });
        try {
          NodeFS.linkSync(temporary, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (
            NodeFS.statSync(file).size !== data.length ||
            !NodeFS.readFileSync(file).equals(data)
          ) {
            throw new CompanionError(409, "Existing Android capture differs from the upload.");
          }
        }
        db.prepare(`
          UPDATE tasks SET status = 'done', message = '手机已回传屏幕捕获结果。',
            updated_at = ?, digest = ? WHERE id = ? AND status = 'running'
        `).run(time, digest, id);
      } finally {
        NodeFS.rmSync(temporary, { force: true });
      }
    },
    result(threadId: string, id: string) {
      sweep();
      return taskView(inThread(threadId, id));
    },
    cancel(threadId: string, id: string) {
      const time = sweep();
      const task = inThread(threadId, id);
      if (task.status === "queued" || task.status === "running") {
        update.run("canceled", "已从原会话取消 Android 屏幕捕获。", time, id);
      }
      return taskView(inThread(threadId, id));
    },
  };
}

const stores = new Map<string, ReturnType<typeof createAndroidCaptureStore>>();
export function getAndroidCaptureStore(stateDir: string) {
  const existing = stores.get(stateDir);
  if (existing) return existing;
  const store = createAndroidCaptureStore(stateDir);
  stores.set(stateDir, store);
  return store;
}
