// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import {
  COMPANION_MAX_IMAGE_BASE64_LENGTH,
  COMPANION_MAX_IMAGE_BYTES,
  type CompanionDevice,
  type CompanionResultInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeZlib from "node:zlib";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PAIRING_TTL = 5 * MINUTE;
const QUEUED_TTL = 5 * MINUTE;
const RUNNING_TTL = 2 * MINUTE;
const ONLINE_TTL = 15_000;
const HISTORY_TTL = 2 * DAY;
const IMAGE_TTL = DAY;
const MAX_DEVICES = 32;
const MAX_CODES = 16;
const MAX_PENDING_PER_DEVICE = 16;
const MAX_TASKS = 512;
const MAX_IMAGES = 16;
const MAX_IMAGE_PIXELS = 32 * 1024 * 1024;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_FORMAT = /^[2-9A-HJ-NP-Z]{10}$/;
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
const IMAGE_NAME_FORMAT = /^[0-9a-f-]{36}\.png$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const actions = ["screenshot", "open-t3", "open-notepad", "close-window"] as const;
type Action = (typeof actions)[number];
type TaskStatus = CompanionDevice["recentTasks"][number]["status"];
type Strings = Readonly<Record<string, string>>;
type Completion = typeof CompanionResultInput.Type;

interface Job {
  readonly id: string;
  readonly action: Action;
  readonly threadId: string;
  readonly params: Strings;
}

interface Task {
  readonly id: string;
  readonly action: Action;
  readonly status: TaskStatus;
  readonly updatedAt: string;
  readonly message: string;
  readonly deviceName: string;
  readonly imagePath?: string;
}

interface TaskRow {
  readonly id: string;
  readonly thread_id: string;
  readonly device_id: string;
  readonly device_name: string;
  readonly action: Action;
  readonly params: string;
  readonly status: TaskStatus;
  readonly updated_at: number;
  readonly message: string;
  readonly image_name: string | null;
  readonly result_hash: string | null;
}

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly info: string;
  readonly last_seen: number;
}

// 同步存储异常由 HTTP 和 MCP 入口转换为各自的响应格式。
// @effect-diagnostics-next-line extendsNativeError:off
export class CompanionError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "CompanionError";
  }
}

const hash = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const timestamp = (time: number) => new Date(time).toISOString();
const isActive = (status: TaskStatus) => status === "queued" || status === "running";

function label(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new CompanionError(400, "Invalid Windows companion value.");
  }
  return trimmed;
}

function encodeStrings(data: Strings): string {
  const entries = Object.entries(data).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    entries.length > 16 ||
    entries.some(
      ([key, value]) => !label(key, 64) || typeof value !== "string" || value.length > 512,
    )
  ) {
    throw new CompanionError(400, "Invalid Windows companion fields.");
  }
  return JSON.stringify(Object.fromEntries(entries));
}

function decodePng(source: string): Buffer {
  if (source.length > COMPANION_MAX_IMAGE_BASE64_LENGTH) {
    throw new CompanionError(413, "Screenshot exceeds 5 MiB.");
  }
  const image = Buffer.from(source, "base64");
  if (image.length > COMPANION_MAX_IMAGE_BYTES) {
    throw new CompanionError(413, "Screenshot exceeds 5 MiB.");
  }
  const invalid = new CompanionError(415, "Screenshot must be a complete PNG.");
  if (source !== image.toString("base64") || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw invalid;
  }

  // 去除不参与解码的附加元数据，并校验保留的块与像素尺寸。
  const chunks = [PNG_SIGNATURE];
  let offset = 8;
  let hasData = false;
  let seenDataEnd = false;
  let chunkCount = 0;
  while (offset + 12 <= image.length) {
    if (++chunkCount > 4096) throw invalid;
    const size = image.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    const next = dataEnd + 4;
    if (next > image.length) throw invalid;
    const type = image.toString("latin1", offset + 4, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) throw invalid;
    if (NodeZlib.crc32(image.subarray(offset + 4, dataEnd)) !== image.readUInt32BE(dataEnd)) {
      throw invalid;
    }
    if (offset === 8) {
      if (type !== "IHDR" || size !== 13) throw invalid;
      const width = image.readUInt32BE(dataStart);
      const height = image.readUInt32BE(dataStart + 4);
      const bitDepths = new Map([
        [0, [1, 2, 4, 8, 16]],
        [2, [8, 16]],
        [3, [1, 2, 4, 8]],
        [4, [8, 16]],
        [6, [8, 16]],
      ]);
      if (
        !bitDepths.get(image.readUInt8(dataStart + 9))?.includes(image.readUInt8(dataStart + 8)) ||
        image.readUInt8(dataStart + 10) !== 0 ||
        image.readUInt8(dataStart + 11) !== 0 ||
        image.readUInt8(dataStart + 12) > 1
      )
        throw invalid;
      if (
        width < 1 ||
        height < 1 ||
        width > 8192 ||
        height > 8192 ||
        width * height > MAX_IMAGE_PIXELS
      )
        throw invalid;
    } else if (type === "IHDR") {
      throw invalid;
    }
    if (type === "IEND") {
      if (!hasData || size !== 0 || next !== image.length) throw invalid;
      chunks.push(image.subarray(offset, next));
      return Buffer.concat(chunks);
    }
    if (type === "IDAT") {
      if (seenDataEnd) throw invalid;
      if (size > 0) hasData = true;
    } else if (hasData) {
      seenDataEnd = true;
    }
    if (type === "IHDR" || type === "IDAT" || type === "PLTE" || type === "tRNS") {
      chunks.push(image.subarray(offset, next));
    } else if (type[0] === type[0]?.toUpperCase()) {
      throw invalid;
    }
    offset = next;
  }
  throw invalid;
}

export function createCompanionStore(stateDir: string, now = Date.now) {
  const directory = NodePath.resolve(stateDir, "windows-companion");
  const screenshots = NodePath.join(directory, "screenshots");
  NodeFS.mkdirSync(screenshots, { recursive: true, mode: 0o700 });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "devices.sqlite"), {
    allowExtension: false,
  });
  db.exec(`
    PRAGMA busy_timeout = 2500;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS codes (
      digest TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token_digest TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      info TEXT NOT NULL,
      last_seen INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tasks (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      request_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      image_name TEXT,
      result_hash TEXT,
      UNIQUE(thread_id, request_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS tasks_by_device ON tasks(device_id, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_device ON tasks(device_id) WHERE status = 'running';
  `);

  let nextCleanup = 0;
  function transaction<T>(operation: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function cleanup(time: number): void {
    db.prepare(`
      UPDATE tasks SET status = 'failed', message = 'The Windows request expired.', updated_at = ?
      WHERE status IN ('queued', 'running') AND expires_at <= ?
    `).run(time, time);
    if (time < nextCleanup) return;
    db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(time);
    db.prepare(
      "DELETE FROM tasks WHERE status NOT IN ('queued', 'running') AND updated_at <= ?",
    ).run(time - HISTORY_TTL);
    db.prepare(`
      UPDATE tasks SET image_name = NULL
      WHERE image_name IS NOT NULL AND updated_at <= ?
    `).run(time - IMAGE_TTL);
    nextCleanup = time + MINUTE;
  }

  function removeUnreferencedImages(): void {
    const names = new Set(
      db
        .prepare("SELECT image_name FROM tasks WHERE image_name IS NOT NULL")
        .all()
        .map((row) => String(row.image_name)),
    );
    for (const imageName of NodeFS.readdirSync(screenshots)) {
      if (IMAGE_NAME_FORMAT.test(imageName) && !names.has(imageName)) {
        NodeFS.unlinkSync(NodePath.join(screenshots, imageName));
      }
    }
  }

  function maintenance(time: number): void {
    const sweep = time >= nextCleanup;
    transaction(() => cleanup(time));
    if (sweep) transaction(removeUnreferencedImages);
  }

  function getDevice(token: string): DeviceRow {
    const unauthorized = new CompanionError(401, "Invalid Windows companion token.");
    if (!TOKEN_FORMAT.test(token)) throw unauthorized;
    const row = db
      .prepare("SELECT id, name, info, last_seen FROM devices WHERE token_digest = ?")
      .get(hash(token)) as DeviceRow | undefined;
    if (row === undefined) throw unauthorized;
    return row;
  }

  function taskView(task: TaskRow): Task {
    return {
      id: task.id,
      action: task.action,
      status: task.status,
      updatedAt: timestamp(task.updated_at),
      message: task.message,
      deviceName: task.device_name,
      ...(task.image_name !== null && IMAGE_NAME_FORMAT.test(task.image_name)
        ? { imagePath: NodePath.join(screenshots, task.image_name) }
        : {}),
    };
  }

  function scopedTask(threadId: string, id: string): TaskRow {
    const row = db
      .prepare("SELECT * FROM tasks WHERE thread_id = ? AND id = ?")
      .get(threadId, id) as TaskRow | undefined;
    if (row === undefined) throw new CompanionError(404, "Windows request not found.");
    return row;
  }

  function removeDevice(deviceId: string): void {
    if (db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId).changes === 0) {
      throw new CompanionError(404, "Windows companion not found.");
    }
    db.prepare(`
      UPDATE tasks SET status = 'canceled', message = 'The Windows companion was unpaired.', updated_at = ?
      WHERE device_id = ? AND status IN ('queued', 'running')
    `).run(now(), deviceId);
  }

  function count(table: "devices" | "codes" | "tasks"): number {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0);
  }

  return {
    close: () => db.close(),

    pair(): { code: string; expiresAt: string } {
      const time = now();
      maintenance(time);
      return transaction(() => {
        db.prepare("DELETE FROM codes WHERE expires_at <= ?").run(time);
        if (count("codes") >= MAX_CODES || count("devices") >= MAX_DEVICES) {
          throw new CompanionError(429, "Windows companion pairing capacity reached.");
        }
        let code: string;
        let inserted: number | bigint;
        const expiresAt = time + PAIRING_TTL;
        do {
          code = Array.from(
            { length: 10 },
            () => CODE_ALPHABET[NodeCrypto.randomInt(CODE_ALPHABET.length)],
          ).join("");
          inserted = db
            .prepare("INSERT OR IGNORE INTO codes VALUES (?, ?)")
            .run(hash(code), expiresAt).changes;
        } while (inserted === 0);
        return { code, expiresAt: timestamp(expiresAt) };
      });
    },

    enroll(code: string, name: string, info: Strings): { deviceId: string; token: string } {
      const normalizedCode = code.trim().toUpperCase();
      const invalid = new CompanionError(401, "Invalid or expired Windows companion pairing code.");
      if (!CODE_FORMAT.test(normalizedCode)) throw invalid;
      const time = now();
      const deviceId = NodeCrypto.randomUUID();
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      return transaction(() => {
        if (
          db
            .prepare("DELETE FROM codes WHERE digest = ? AND expires_at > ?")
            .run(hash(normalizedCode), time).changes === 0
        ) {
          throw invalid;
        }
        if (count("devices") >= MAX_DEVICES) {
          throw new CompanionError(429, "Windows companion device capacity reached.");
        }
        db.prepare("INSERT INTO devices VALUES (?, ?, ?, ?, ?)").run(
          deviceId,
          hash(token),
          label(name, 128),
          encodeStrings(info),
          time,
        );
        return { deviceId, token };
      });
    },

    authorize(token: string): { deviceId: string; name: string } {
      const device = getDevice(token);
      return { deviceId: device.id, name: device.name };
    },

    poll(token: string, _name: string, info: Strings): { name: string; job: Job | null } {
      getDevice(token);
      const time = now();
      maintenance(time);
      return transaction(() => {
        const device = getDevice(token);
        // 管理员修改的名称由服务端持有，心跳只更新设备信息和在线时间。
        db.prepare("UPDATE devices SET info = ?, last_seen = ? WHERE id = ?").run(
          encodeStrings(info),
          time,
          device.id,
        );
        if (
          db
            .prepare("SELECT 1 FROM tasks WHERE device_id = ? AND status = 'running'")
            .get(device.id)
        )
          return { name: device.name, job: null };
        const task = db
          .prepare(`
          SELECT * FROM tasks WHERE device_id = ? AND status = 'queued' ORDER BY sequence LIMIT 1
        `)
          .get(device.id) as TaskRow | undefined;
        if (task === undefined) return { name: device.name, job: null };
        // 已领取但未收到回执的任务在超时后结案，避免重做桌面操作。
        db.prepare(`
          UPDATE tasks SET status = 'running', message = 'Waiting for the Windows device.',
          updated_at = ?, expires_at = ?, device_name = ? WHERE id = ?
        `).run(time, time + RUNNING_TTL, device.name, task.id);
        return {
          name: device.name,
          job: {
            id: task.id,
            action: task.action,
            threadId: task.thread_id,
            params: JSON.parse(task.params) as Strings,
          },
        };
      });
    },

    complete(token: string, input: Completion): void {
      getDevice(token);
      if (input.status !== "done" && input.status !== "failed") {
        throw new CompanionError(400, "Invalid Windows companion task status.");
      }
      if (input.message.length > 4096) {
        throw new CompanionError(400, "Windows companion task message is too long.");
      }
      const time = now();
      maintenance(time);
      let written: string | undefined;
      let shouldSweep = false;
      try {
        transaction(() => {
          const device = getDevice(token);
          const task = db
            .prepare("SELECT * FROM tasks WHERE device_id = ? AND id = ?")
            .get(device.id, input.id) as TaskRow | undefined;
          if (task === undefined) throw new CompanionError(404, "Windows request not found.");
          if (
            input.imageBase64 !== undefined &&
            (task.action !== "screenshot" || input.status !== "done")
          ) {
            throw new CompanionError(400, "Only a successful screenshot task may submit an image.");
          }
          if (
            input.status === "done" &&
            task.action === "screenshot" &&
            input.imageBase64 === undefined
          ) {
            throw new CompanionError(400, "A successful screenshot requires an image.");
          }
          if (task.status !== "running" && task.result_hash === null) {
            throw new CompanionError(409, "Windows request is no longer running.");
          }
          const image = input.imageBase64 === undefined ? undefined : decodePng(input.imageBase64);
          const resultHash = hash(
            JSON.stringify([input.status, input.message, image === undefined ? null : hash(image)]),
          );
          if (task.result_hash === resultHash) return;
          if (task.status !== "running") {
            throw new CompanionError(409, "Windows request already has a different result.");
          }

          const imageName = image === undefined ? null : NodeCrypto.randomUUID() + ".png";
          if (image !== undefined && imageName !== null) {
            const imagePath = NodePath.join(screenshots, imageName);
            const file = NodeFS.openSync(imagePath, "wx", 0o600);
            written = imagePath;
            try {
              NodeFS.writeFileSync(file, image);
            } finally {
              NodeFS.closeSync(file);
            }
            shouldSweep = true;
          }
          db.prepare(`
            UPDATE tasks SET status = ?, message = ?, image_name = ?, result_hash = ?, updated_at = ? WHERE id = ?
          `).run(input.status, input.message, imageName, resultHash, time, task.id);
          if (shouldSweep) {
            db.prepare(`
              UPDATE tasks SET image_name = NULL WHERE id IN (
                SELECT id FROM tasks WHERE image_name IS NOT NULL
                ORDER BY updated_at DESC, sequence DESC LIMIT -1 OFFSET ?
              )
            `).run(MAX_IMAGES);
          }
        });
      } catch (error) {
        if (written !== undefined) NodeFS.unlinkSync(written);
        throw error;
      }
      if (shouldSweep) transaction(removeUnreferencedImages);
    },

    list(): readonly CompanionDevice[] {
      const time = now();
      maintenance(time);
      const devices = db
        .prepare("SELECT id, name, info, last_seen FROM devices ORDER BY name, id")
        .all() as unknown as DeviceRow[];
      const history = db.prepare(`
        SELECT id, action, status, updated_at FROM tasks WHERE device_id = ?
        ORDER BY updated_at DESC, sequence DESC LIMIT 10
      `);
      return devices.map((device) => ({
        deviceId: device.id,
        name: device.name,
        info: JSON.parse(device.info) as Strings,
        lastSeen: timestamp(device.last_seen),
        online: time - device.last_seen < ONLINE_TTL,
        recentTasks: (history.all(device.id) as unknown as TaskRow[]).map((task) => ({
          id: task.id,
          action: task.action,
          status: task.status,
          updatedAt: timestamp(task.updated_at),
        })),
      }));
    },

    rename(deviceId: string, name: string): void {
      if (
        db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(label(name, 128), deviceId)
          .changes === 0
      ) {
        throw new CompanionError(404, "Windows companion not found.");
      }
    },

    revoke(deviceId: string): void {
      transaction(() => removeDevice(deviceId));
    },

    unbind(token: string): void {
      transaction(() => removeDevice(getDevice(token).id));
    },

    enqueue(
      threadId: string,
      deviceId: string,
      action: string,
      clientRequestId: string,
      params: Strings = {},
    ): Task {
      if (!actions.includes(action as Action)) {
        throw new CompanionError(400, "Unsupported Windows companion action.");
      }
      const thread = label(threadId, 512);
      const request = label(clientRequestId, 128);
      const encodedParams = encodeStrings(params);
      const time = now();
      maintenance(time);
      return transaction(() => {
        const existing = db
          .prepare("SELECT * FROM tasks WHERE thread_id = ? AND request_id = ?")
          .get(thread, request) as TaskRow | undefined;
        if (existing !== undefined) {
          if (
            existing.device_id !== deviceId ||
            existing.action !== action ||
            existing.params !== encodedParams
          ) {
            throw new CompanionError(409, "The request identifier has already been used.");
          }
          return taskView(existing);
        }
        const device = db.prepare("SELECT name FROM devices WHERE id = ?").get(deviceId);
        if (device === undefined) throw new CompanionError(404, "Windows companion not found.");
        const pending = db
          .prepare(`
          SELECT COUNT(*) AS count FROM tasks WHERE device_id = ? AND status IN ('queued', 'running')
        `)
          .get(deviceId)?.count;
        if (Number(pending) >= MAX_PENDING_PER_DEVICE || count("tasks") >= MAX_TASKS) {
          throw new CompanionError(429, "Windows companion task capacity reached.");
        }
        const id = NodeCrypto.randomUUID();
        db.prepare(`
          INSERT INTO tasks(id, thread_id, device_id, device_name, request_id, action, params, status, message,
            updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'Waiting for the Windows device.', ?, ?)
        `).run(
          id,
          thread,
          deviceId,
          String(device.name),
          request,
          action,
          encodedParams,
          time,
          time + QUEUED_TTL,
        );
        return taskView(scopedTask(thread, id));
      });
    },

    result(threadId: string, id: string): Task {
      maintenance(now());
      return taskView(scopedTask(threadId, id));
    },

    cancel(threadId: string, id: string): Task {
      const time = now();
      maintenance(time);
      return transaction(() => {
        const task = scopedTask(threadId, id);
        if (!isActive(task.status)) return taskView(task);
        // 领取后设备可能已开始执行，本地批准和暂停由 Windows 用户控制。
        if (task.status === "running") {
          throw new CompanionError(409, "The Windows device has already claimed this request.");
        }
        db.prepare(`
          UPDATE tasks SET status = 'canceled', message = 'The Windows request was canceled.', updated_at = ?
          WHERE id = ?
        `).run(time, id);
        return taskView(scopedTask(threadId, id));
      });
    },
  };
}

const stores = new Map<string, ReturnType<typeof createCompanionStore>>();

export function getCompanionStore(stateDir: string) {
  const key = NodePath.resolve(stateDir);
  const previous = stores.get(key);
  if (previous !== undefined) return previous;
  const store = createCompanionStore(key);
  stores.set(key, store);
  return store;
}
