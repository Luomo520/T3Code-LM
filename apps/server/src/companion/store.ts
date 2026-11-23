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
const CAPTURE_QUEUED_TTL = 30_000;
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
const MEDIA_NAME_FORMAT = /^[0-9a-f-]{36}\.(png|avi|bin)$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const actions = [
  "screenshot",
  "record-screen",
  "open-t3",
  "open-notepad",
  "close-window",
  "send-file",
  "receive-file",
  "write-notepad",
  "read-notepad",
] as const;
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
  readonly recordingPath?: string;
  readonly captureScope?: NonNullable<Completion["captureScope"]>;
  readonly stopRequested?: true;
  readonly transferredFile?: {
    readonly path: string;
    readonly name: string;
    readonly sha256: string;
  };
  readonly savedFile?: NonNullable<Completion["savedFile"]>;
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
  readonly transfer_receipt: string | null;
  readonly stop_requested_at: number | null;
  readonly capture_scope: NonNullable<Completion["captureScope"]> | null;
}

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly info: string;
  readonly last_seen: number;
  readonly details_updated_at: number | null;
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

function decodeRecording(source: string): Buffer {
  if (source.length > COMPANION_MAX_IMAGE_BASE64_LENGTH) {
    throw new CompanionError(413, "Recording exceeds 5 MiB.");
  }
  const bytes = Buffer.from(source, "base64");
  if (bytes.length > COMPANION_MAX_IMAGE_BYTES) {
    throw new CompanionError(413, "Recording exceeds 5 MiB.");
  }
  if (
    bytes.length < 224 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 12) !== "AVI " ||
    bytes.toString("ascii", 16, 20) !== "hdrl"
  ) {
    throw new CompanionError(415, "Invalid Windows companion AVI recording.");
  }
  return bytes;
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

function supportsCaptureOptions(params: Strings, info: Strings): boolean {
  return (
    (params.captureKind === undefined && params.durationSeconds === undefined) ||
    info.captureTargetV1 === "true"
  );
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
      last_seen INTEGER NOT NULL,
      details_updated_at INTEGER
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
      transfer_receipt TEXT,
      stop_requested_at INTEGER,
      capture_scope TEXT,
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
      WHERE (status IN ('queued', 'running') AND expires_at <= ?)
        OR (status = 'queued' AND action IN ('screenshot', 'record-screen') AND updated_at <= ?)
    `).run(time, time, time - CAPTURE_QUEUED_TTL);
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
      if (MEDIA_NAME_FORMAT.test(imageName) && !names.has(imageName)) {
        NodeFS.unlinkSync(NodePath.join(screenshots, imageName));
      }
    }
  }

  transaction(() => {
    const columns = db.prepare("PRAGMA table_info(devices)").all();
    if (!columns.some((column) => column.name === "details_updated_at")) {
      db.exec("ALTER TABLE devices ADD COLUMN details_updated_at INTEGER");
    }
    const taskColumns = db.prepare("PRAGMA table_info(tasks)").all();
    if (!taskColumns.some((column) => column.name === "transfer_receipt")) {
      db.exec("ALTER TABLE tasks ADD COLUMN transfer_receipt TEXT");
    }
    if (!taskColumns.some((column) => column.name === "stop_requested_at")) {
      db.exec("ALTER TABLE tasks ADD COLUMN stop_requested_at INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "capture_scope")) {
      db.exec("ALTER TABLE tasks ADD COLUMN capture_scope TEXT");
    }
  });

  function maintenance(time: number): void {
    const sweep = time >= nextCleanup;
    transaction(() => cleanup(time));
    if (sweep) transaction(removeUnreferencedImages);
  }

  function getDevice(token: string): DeviceRow {
    const unauthorized = new CompanionError(401, "Invalid Windows companion token.");
    if (!TOKEN_FORMAT.test(token)) throw unauthorized;
    const row = db
      .prepare(
        "SELECT id, name, info, last_seen, details_updated_at FROM devices WHERE token_digest = ?",
      )
      .get(hash(token)) as DeviceRow | undefined;
    if (row === undefined) throw unauthorized;
    return row;
  }

  function taskView(task: TaskRow): Task {
    const receipt =
      task.transfer_receipt === null
        ? null
        : (JSON.parse(task.transfer_receipt) as {
            readonly name?: string;
            readonly sha256: string;
            readonly path?: string;
          });
    return {
      id: task.id,
      action: task.action,
      status: task.status,
      updatedAt: timestamp(task.updated_at),
      message: task.message,
      deviceName: task.device_name,
      ...(task.capture_scope === null ? {} : { captureScope: task.capture_scope }),
      ...(task.status === "running" && task.stop_requested_at !== null
        ? { stopRequested: true }
        : {}),
      ...(task.image_name !== null && MEDIA_NAME_FORMAT.test(task.image_name)
        ? task.action === "record-screen" && task.image_name.endsWith(".avi")
          ? { recordingPath: NodePath.join(screenshots, task.image_name) }
          : task.action === "screenshot" && task.image_name.endsWith(".png")
            ? { imagePath: NodePath.join(screenshots, task.image_name) }
            : task.action === "send-file" && task.image_name.endsWith(".bin") && receipt?.name
              ? {
                  transferredFile: {
                    path: NodePath.join(screenshots, task.image_name),
                    name: receipt.name,
                    sha256: receipt.sha256,
                  },
                }
              : {}
        : {}),
      ...(task.action === "receive-file" && receipt?.path
        ? { savedFile: { path: receipt.path, sha256: receipt.sha256 } }
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
        db.prepare(
          "INSERT INTO devices (id, token_digest, name, info, last_seen, details_updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(deviceId, hash(token), label(name, 128), encodeStrings(info), time, time);
        return { deviceId, token };
      });
    },

    authorize(token: string): { deviceId: string; name: string } {
      const device = getDevice(token);
      return { deviceId: device.id, name: device.name };
    },

    poll(
      token: string,
      _name: string,
      info: Strings,
      watchRecordingId?: string,
    ): { readonly name: string; readonly job: Job | null; readonly stopRequested?: boolean } {
      const device = getDevice(token);
      const time = now();
      maintenance(time);
      if (watchRecordingId !== undefined) {
        const row = db
          .prepare(`
          SELECT stop_requested_at FROM tasks
          WHERE id = ? AND device_id = ? AND action = 'record-screen' AND status = 'running'
        `)
          .get(watchRecordingId, device.id);
        return { name: device.name, job: null, stopRequested: row?.stop_requested_at != null };
      }
      return transaction(() => {
        const device = getDevice(token);
        // 管理员修改的名称由服务端持有，心跳只更新设备信息和在线时间。
        db.prepare(
          "UPDATE devices SET info = ?, last_seen = ?, details_updated_at = ? WHERE id = ?",
        ).run(encodeStrings(info), time, time, device.id);
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
        const params = JSON.parse(task.params) as Strings;
        if (!supportsCaptureOptions(params, info)) {
          db.prepare(`
            UPDATE tasks SET status = 'failed', message = ?, updated_at = ? WHERE id = ?
          `).run(
            "The Windows companion no longer supports the requested capture options.",
            time,
            task.id,
          );
          return { name: device.name, job: null };
        }
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
            params,
          },
        };
      });
    },

    checkDevice(
      token: string,
      info: Strings,
      renamedTo?: string,
    ): { readonly name: string; readonly detailsUpdatedAt: string } {
      const time = now();
      return transaction(() => {
        const device = getDevice(token);
        const name = renamedTo === undefined ? device.name : label(renamedTo, 128);
        // 受控端暂停时也可刷新资料，领取队列的在线时间仍由 poll 维护。
        db.prepare(
          "UPDATE devices SET name = ?, info = ?, details_updated_at = ? WHERE id = ?",
        ).run(name, encodeStrings(info), time, device.id);
        return { name, detailsUpdatedAt: timestamp(time) };
      });
    },

    receiveTransfer(token: string, id: string) {
      const time = now();
      const device = getDevice(token);
      maintenance(time);
      const task = db
        .prepare("SELECT * FROM tasks WHERE id = ? AND device_id = ?")
        .get(id, device.id) as TaskRow | undefined;
      if (!task || task.action !== "receive-file" || task.status !== "running") {
        throw new CompanionError(404, "No active file transfer for this Windows companion.");
      }
      return JSON.parse(task.params) as Strings;
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
            input.captureScope !== undefined &&
            (input.status !== "done" ||
              (task.action !== "screenshot" && task.action !== "record-screen"))
          ) {
            throw new CompanionError(400, "Only a completed capture may report its capture scope.");
          }
          const captureKind = (JSON.parse(task.params) as Strings).captureKind;
          if (
            input.status === "done" &&
            captureKind !== undefined &&
            input.captureScope !== captureKind
          ) {
            throw new CompanionError(
              400,
              "The recorded scope differs from the requested capture kind.",
            );
          }
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
          if (
            input.recordingBase64 !== undefined &&
            (task.action !== "record-screen" || input.status !== "done")
          ) {
            throw new CompanionError(400, "Only a successful recording may submit a video.");
          }
          if (
            input.status === "done" &&
            task.action === "record-screen" &&
            input.recordingBase64 === undefined
          ) {
            throw new CompanionError(400, "A successful recording requires a video.");
          }
          if (
            (input.file !== undefined ||
              (input.status === "done" && task.action === "send-file")) &&
            (task.action !== "send-file" || input.status !== "done" || input.file === undefined)
          ) {
            throw new CompanionError(400, "A completed device upload requires a file.");
          }
          if (
            (input.savedFile !== undefined ||
              (input.status === "done" && task.action === "receive-file")) &&
            (task.action !== "receive-file" ||
              input.status !== "done" ||
              input.savedFile === undefined ||
              input.savedFile.sha256 !== (JSON.parse(task.params) as Strings).sha256)
          ) {
            throw new CompanionError(
              400,
              "The file confirmation does not match the requested transfer.",
            );
          }
          if (task.status !== "running" && task.result_hash === null) {
            throw new CompanionError(409, "Windows request is no longer running.");
          }
          const recording =
            input.recordingBase64 === undefined
              ? undefined
              : decodeRecording(input.recordingBase64);
          const transferred =
            input.file === undefined ? undefined : Buffer.from(input.file.data, "base64");
          if (
            transferred !== undefined &&
            (transferred.length > COMPANION_MAX_IMAGE_BYTES ||
              hash(transferred) !== input.file?.sha256)
          ) {
            throw new CompanionError(422, "Windows companion file size or SHA-256 is invalid.");
          }
          const media =
            transferred ??
            recording ??
            (input.imageBase64 === undefined ? undefined : decodePng(input.imageBase64));
          const receipt =
            input.file !== undefined
              ? {
                  name: label(input.file.name, 240).replace(/[\\/]/gu, "_"),
                  sha256: input.file.sha256,
                }
              : (input.savedFile ?? null);
          const resultHash = hash(
            JSON.stringify([
              input.status,
              input.message,
              media === undefined ? null : hash(media),
              ...(receipt === null ? [] : [receipt]),
              ...(input.captureScope === undefined ? [] : [input.captureScope]),
            ]),
          );
          if (task.result_hash === resultHash) return;
          if (task.status !== "running") {
            throw new CompanionError(409, "Windows request already has a different result.");
          }

          const imageName =
            media === undefined
              ? null
              : NodeCrypto.randomUUID() + (transferred ? ".bin" : recording ? ".avi" : ".png");
          if (media !== undefined && imageName !== null) {
            const imagePath = NodePath.join(screenshots, imageName);
            const file = NodeFS.openSync(imagePath, "wx", 0o600);
            written = imagePath;
            try {
              NodeFS.writeFileSync(file, media);
            } finally {
              NodeFS.closeSync(file);
            }
            shouldSweep = true;
          }
          db.prepare(`
            UPDATE tasks SET status = ?, message = ?, image_name = ?, result_hash = ?, transfer_receipt = ?, capture_scope = ?, updated_at = ? WHERE id = ?
          `).run(
            input.status,
            input.message,
            imageName,
            resultHash,
            receipt === null ? null : JSON.stringify(receipt),
            input.captureScope ?? null,
            time,
            task.id,
          );
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
        .prepare(
          "SELECT id, name, info, last_seen, details_updated_at FROM devices ORDER BY name, id",
        )
        .all() as unknown as DeviceRow[];
      const history = db.prepare(`
        SELECT id, action, status, updated_at,
          CASE WHEN action = 'receive-file' AND status = 'done'
            THEN json_extract(transfer_receipt, '$.path') END AS saved_path
        FROM tasks WHERE device_id = ?
        ORDER BY updated_at DESC, sequence DESC LIMIT 10
      `);
      return devices.map((device) => ({
        deviceId: device.id,
        name: device.name,
        info: JSON.parse(device.info) as Strings,
        lastSeen: timestamp(device.last_seen),
        detailsUpdatedAt: timestamp(device.details_updated_at ?? device.last_seen),
        online: time - device.last_seen < ONLINE_TTL,
        recentTasks: (
          history.all(device.id) as unknown as (Pick<
            TaskRow,
            "id" | "action" | "status" | "updated_at"
          > & { saved_path: string | null })[]
        ).map((task) => ({
          id: task.id,
          action: task.action,
          status: task.status,
          updatedAt: timestamp(task.updated_at),
          ...(task.saved_path ? { savedPath: task.saved_path } : {}),
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
        const device = db.prepare("SELECT name, info FROM devices WHERE id = ?").get(deviceId);
        if (device === undefined) throw new CompanionError(404, "Windows companion not found.");
        if (!supportsCaptureOptions(params, JSON.parse(String(device.info)) as Strings)) {
          throw new CompanionError(409, "This Windows companion does not support capture options.");
        }
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
          time +
            (action === "screenshot" || action === "record-screen"
              ? CAPTURE_QUEUED_TTL
              : QUEUED_TTL),
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
        if (task.status === "running") {
          if (task.action !== "record-screen") {
            throw new CompanionError(409, "The Windows device has already claimed this request.");
          }
          if (task.stop_requested_at !== null) return taskView(task);
          const device = db.prepare("SELECT info FROM devices WHERE id = ?").get(task.device_id);
          if (!device || (JSON.parse(String(device.info)) as Strings).recordingStop !== "true") {
            throw new CompanionError(
              409,
              "This Windows companion cannot stop a running recording remotely. Stop it on Windows.",
            );
          }
          // 设备收到停止请求后沿用本机停止流程，已录制片段仍可正常回传。
          db.prepare(`
            UPDATE tasks SET stop_requested_at = ?, updated_at = ?, message = 'Waiting for Windows to stop recording.'
            WHERE id = ?
          `).run(time, time, id);
          return taskView(scopedTask(threadId, id));
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
