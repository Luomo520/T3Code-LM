// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import { COMPANION_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

import { createCompanionStore } from "./store.ts";

function setup() {
  let time = Date.UTC(2026, 10, 23);
  const path = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-companion-test-"));
  const clock = () => time;
  const store = createCompanionStore(path, clock);
  onTestFinished(() => {
    store.close();
    NodeFS.rmSync(path, { recursive: true, force: true });
  });
  return {
    path,
    clock,
    store,
    advance: (ms: number) => {
      time += ms;
    },
    enroll: (name: string) => store.enroll(store.pair().code, name, {}),
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(NodeZlib.crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function screenshot(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", NodeZlib.deflateSync(Buffer.from([0, 255, 127, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("Windows companion store", () => {
  it("consumes pairing codes once across connections and persists only hashed credentials", () => {
    const { clock, path, store, advance } = setup();
    const expired = store.pair();
    advance(5 * 60_000);
    expect(() => store.enroll(expired.code, "Expired", {})).toThrow(
      expect.objectContaining({ status: 401 }),
    );
    const invitation = store.pair();
    expect(invitation.expiresAt).toBe(new Date(clock() + 5 * 60_000).toISOString());
    const device = store.enroll(invitation.code.toLowerCase(), "PC", { os: "Windows" });
    const reopened = createCompanionStore(path, clock);
    try {
      expect(() => reopened.enroll(invitation.code, "Other PC", {})).toThrow(
        expect.objectContaining({ status: 401 }),
      );
      expect(reopened.authorize(device.token)).toEqual({ deviceId: device.deviceId, name: "PC" });
      expect(reopened.list()).toEqual([
        {
          deviceId: device.deviceId,
          name: "PC",
          info: { os: "Windows" },
          lastSeen: new Date(clock()).toISOString(),
          detailsUpdatedAt: new Date(clock()).toISOString(),
          online: true,
          recentTasks: [],
        },
      ]);
      const wal = NodeFS.readFileSync(
        NodePath.join(path, "windows-companion", "devices.sqlite-wal"),
      );
      expect(wal.includes(invitation.code)).toBe(false);
      expect(wal.includes(device.token)).toBe(false);
      reopened.rename(device.deviceId, "管理员命名");
      advance(16_000);
      expect(reopened.list()[0]).toMatchObject({ name: "管理员命名", online: false });
      expect(reopened.poll(device.token, "旧客户端名", { os: "Windows 11" })).toEqual({
        name: "管理员命名",
        job: null,
      });
      expect(reopened.list()[0]).toMatchObject({
        name: "管理员命名",
        online: true,
        info: { os: "Windows 11" },
      });
      reopened.unbind(device.token);
      expect(() => store.authorize(device.token)).toThrow(expect.objectContaining({ status: 401 }));
    } finally {
      reopened.close();
    }
  });

  it("refreshes an offline device's details and syncs its own name without claiming queued work", () => {
    const { clock, store, enroll, advance } = setup();
    const device = enroll("PC");
    const other = enroll("Other PC");
    const lastSeen = new Date(clock()).toISOString();
    const job = store.enqueue("thread", device.deviceId, "open-notepad", "work");
    advance(16_000);
    store.rename(device.deviceId, "管理员名称");
    const info = { gpu: "Test Graphics", memory: "32 GiB", network1: "LAN · IP 192.0.2.1" };
    const detailsUpdatedAt = new Date(clock()).toISOString();
    expect(store.checkDevice(device.token, info)).toEqual({ name: "管理员名称", detailsUpdatedAt });
    expect(store.checkDevice(device.token, info, "本机名称")).toEqual({
      name: "本机名称",
      detailsUpdatedAt,
    });
    expect(store.list().find((entry) => entry.deviceId === device.deviceId)).toMatchObject({
      name: "本机名称",
      info,
      lastSeen,
      detailsUpdatedAt,
      online: false,
    });
    expect(store.authorize(other.token).name).toBe("Other PC");
    expect(store.result("thread", job.id)).toMatchObject({ status: "queued" });
    expect(store.poll(device.token, "旧名称", info)).toMatchObject({
      name: "本机名称",
      job: { id: job.id },
    });
    store.revoke(device.deviceId);
    expect(() => store.checkDevice(device.token, info)).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("keeps capture options and results tied to capable paired devices and the original thread", () => {
    const { store, enroll } = setup();
    const legacy = enroll("Legacy PC");
    const info = { captureTargetV1: "true" };
    const device = store.enroll(store.pair().code, "PC", info);
    const params = { captureKind: "window", durationSeconds: "4" };
    expect(() =>
      store.enqueue("thread", legacy.deviceId, "record-screen", "legacy", params),
    ).toThrow(expect.objectContaining({ status: 409 }));
    const outdated = store.enqueue("thread", device.deviceId, "record-screen", "outdated", params);
    expect(store.poll(device.token, "PC", {}).job).toBeNull();
    expect(store.result("thread", outdated.id).status).toBe("failed");
    store.poll(device.token, "PC", info);
    const task = store.enqueue("thread", device.deviceId, "screenshot", "capture", {
      captureKind: "window",
    });
    expect(store.poll(device.token, "PC", info).job?.params).toEqual({ captureKind: "window" });
    const completion = {
      id: task.id,
      status: "done",
      message: "captured",
      imageBase64: screenshot().toString("base64"),
    } as const;
    expect(() => store.complete(device.token, { ...completion, captureScope: "display" })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    store.complete(device.token, { ...completion, captureScope: "window" });
    store.complete(device.token, { ...completion, captureScope: "window" });
    expect(store.result("thread", task.id)).toMatchObject({
      captureScope: "window",
      status: "done",
    });
    expect(() => store.result("another-thread", task.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  it("binds Windows file transfers to the claimed job, SHA-256 and original thread", () => {
    const { store, enroll } = setup();
    const device = enroll("PC");
    const other = enroll("Other PC");
    const data = Buffer.from("hello").toString("base64");
    const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const outbound = store.enqueue("thread", device.deviceId, "receive-file", "outbound", {
      attachmentId: "selected-thread-file",
      fileName: "hello.txt",
      sha256,
    });
    expect(() => store.receiveTransfer(device.token, outbound.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.poll(device.token, "PC", {}).job).toMatchObject({ id: outbound.id });
    expect(() => store.receiveTransfer(other.token, outbound.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.receiveTransfer(device.token, outbound.id)).toMatchObject({ sha256 });
    const savedFile = { path: "C:/Downloads/hello.txt", sha256 };
    expect(() =>
      store.complete(device.token, {
        id: outbound.id,
        status: "done",
        message: "saved",
        savedFile: { ...savedFile, sha256: "wrong" },
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
    store.complete(device.token, { id: outbound.id, status: "done", message: "saved", savedFile });
    expect(store.result("thread", outbound.id)).toMatchObject({ status: "done", savedFile });
    const history = store.list().find((entry) => entry.deviceId === device.deviceId)?.recentTasks;
    expect(history?.find((task) => task.id === outbound.id)).toMatchObject({
      savedPath: savedFile.path,
    });

    const inbound = store.enqueue("thread", device.deviceId, "send-file", "inbound");
    expect(store.poll(device.token, "PC", {}).job).toMatchObject({ id: inbound.id });
    const file = { name: "hello.txt", data, sha256 };
    expect(() =>
      store.complete(device.token, {
        id: inbound.id,
        status: "done",
        message: "received",
        file: { ...file, data: "d3Jvbmc=" },
      }),
    ).toThrow(expect.objectContaining({ status: 422 }));
    const complete = { id: inbound.id, status: "done", message: "received", file } as const;
    store.complete(device.token, complete);
    store.complete(device.token, complete);
    expect(() => store.result("other-thread", inbound.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    const received = store.result("thread", inbound.id);
    expect(received.transferredFile).toMatchObject({ name: "hello.txt", sha256 });
    expect(NodeFS.readFileSync(received.transferredFile!.path, "utf-8")).toBe("hello");
  });

  it("stops only the calling thread's running recording and preserves the result", () => {
    const { enroll, store } = setup();
    const device = enroll("PC");
    const other = enroll("Other");
    const task = store.enqueue("owner", device.deviceId, "record-screen", "capture");
    const pending = store.enqueue("other", device.deviceId, "receive-file", "next");
    expect(store.poll(device.token, "PC", { recordingStop: "true" }).job?.id).toBe(task.id);
    expect(() => store.cancel("other", task.id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(store.poll(device.token, "PC", {}, task.id)).toMatchObject({
      job: null,
      stopRequested: false,
    });
    const stopping = store.cancel("owner", task.id);
    expect(stopping).toMatchObject({ status: "running", stopRequested: true });
    expect(store.cancel("owner", task.id)).toEqual(stopping);
    expect(store.poll(other.token, "Other", {}, task.id)).toMatchObject({
      job: null,
      stopRequested: false,
    });
    expect(store.poll(device.token, "PC", {}, task.id)).toMatchObject({
      job: null,
      stopRequested: true,
    });

    const recording = Buffer.alloc(224);
    recording.write("RIFF");
    recording.writeUInt32LE(recording.length - 8, 4);
    recording.write("AVI LIST", 8);
    recording.write("hdrl", 16);
    store.complete(device.token, {
      id: task.id,
      status: "done",
      message: "Saved on stop.",
      recordingBase64: recording.toString("base64"),
    });
    expect(store.cancel("owner", task.id)).toEqual(store.result("owner", task.id));
    expect(store.result("owner", task.id)).toMatchObject({
      status: "done",
      recordingPath: expect.any(String),
    });
    expect(store.poll(device.token, "PC", {}, task.id)).toMatchObject({
      job: null,
      stopRequested: false,
    });
    expect(store.result("other", pending.id).status).toBe("queued");
    expect(store.poll(device.token, "PC", { recordingStop: "true" }).job?.id).toBe(pending.id);
    expect(() => store.cancel("other", pending.id)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("keeps old Windows companions compatible with claimed recordings", () => {
    const { store, enroll } = setup();
    const device = enroll("Legacy PC");
    const task = store.enqueue("thread", device.deviceId, "record-screen", "legacy-capture");
    expect(store.poll(device.token, "Legacy PC", {}).job?.id).toBe(task.id);
    expect(() => store.cancel("thread", task.id)).toThrow(
      expect.objectContaining({
        status: 409,
        message: expect.stringContaining("Stop it on Windows"),
      }),
    );
    expect(store.result("thread", task.id)).toMatchObject({ status: "running" });
  });

  it("expires queued screenshots before they can run on a late reconnect", () => {
    const { store, enroll, advance } = setup();
    const device = enroll("PC");
    const shot = store.enqueue("thread", device.deviceId, "screenshot", "shot");
    const normal = store.enqueue("thread", device.deviceId, "open-notepad", "notepad");
    advance(30_000);

    expect(store.poll(device.token, "PC", {}).job).toMatchObject({ id: normal.id });
    expect(store.result("thread", shot.id)).toMatchObject({ status: "failed" });
    const retried = store.enqueue("thread", device.deviceId, "screenshot", "shot");
    expect(retried).toMatchObject({ id: shot.id, status: "failed" });
  });

  it("claims each device queue in FIFO order without accepting another thread or device", () => {
    const { store, enroll } = setup();
    const firstDevice = enroll("PC 1");
    const secondDevice = enroll("PC 2");
    const first = store.enqueue("thread-1", firstDevice.deviceId, "open-t3", "one");
    const second = store.enqueue("thread-2", firstDevice.deviceId, "close-window", "two");
    const separate = store.enqueue("thread-2", secondDevice.deviceId, "open-notepad", "one");
    expect(store.enqueue("thread-1", firstDevice.deviceId, "open-t3", "one")).toEqual(first);
    expect(() => store.enqueue("thread-1", secondDevice.deviceId, "open-t3", "one")).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => store.enqueue("thread-1", firstDevice.deviceId, "shell", "three")).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    expect(() => store.result("thread-2", first.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => store.cancel("thread-1", second.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );

    expect(store.poll(firstDevice.token, "PC 1", {}).job).toEqual({
      id: first.id,
      action: "open-t3",
      threadId: "thread-1",
      params: {},
    });
    expect(store.poll(firstDevice.token, "PC 1", {}).job).toBeNull();
    expect(store.poll(secondDevice.token, "PC 2", {}).job).toMatchObject({ id: separate.id });
    const completion = { id: first.id, status: "done", message: "已打开" } as const;
    expect(() => store.complete(secondDevice.token, completion)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => store.cancel("thread-1", first.id)).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    store.complete(firstDevice.token, completion);
    store.complete(firstDevice.token, completion);
    expect(() => store.complete(firstDevice.token, { ...completion, message: "替换结果" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(store.poll(firstDevice.token, "PC 1", {}).job).toMatchObject({ id: second.id });
    const pending = store.enqueue("thread-1", firstDevice.deviceId, "open-t3", "pending");
    expect(store.cancel("thread-1", pending.id)).toMatchObject({ status: "canceled" });
    store.revoke(firstDevice.deviceId);
    expect(store.result("thread-2", second.id)).toMatchObject({ status: "canceled" });
    expect(() => store.poll(firstDevice.token, "PC 1", {}).job).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it("accepts only a valid bounded PNG reply to the device's claimed screenshot task", () => {
    const { store, enroll, advance } = setup();
    const device = enroll("PC");
    const normal = store.enqueue("thread", device.deviceId, "open-t3", "open");
    store.poll(device.token, "PC", {});
    const png = screenshot();
    const imageBase64 = png.toString("base64");
    expect(() =>
      store.complete(device.token, {
        id: normal.id,
        status: "done",
        message: "x",
        imageBase64,
      }),
    ).toThrow(expect.objectContaining({ status: 400 }));
    store.complete(device.token, { id: normal.id, status: "done", message: "opened" });

    const job = store.enqueue("thread", device.deviceId, "screenshot", "image");
    const reply = { id: job.id, status: "done", message: "captured" } as const;
    expect(() => store.complete(device.token, { ...reply, imageBase64 })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    store.rename(device.deviceId, "新设备名");
    store.poll(device.token, "PC", {});
    expect(() => store.complete(device.token, reply)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    for (const bad of [
      png.subarray(0, -1),
      Buffer.concat([png, Buffer.of(0)]),
      Buffer.from("JPEG"),
    ]) {
      expect(() =>
        store.complete(device.token, { ...reply, imageBase64: bad.toString("base64") }),
      ).toThrow(expect.objectContaining({ status: 415 }));
    }
    expect(() =>
      store.complete(device.token, {
        ...reply,
        imageBase64: Buffer.alloc(COMPANION_MAX_IMAGE_BYTES + 1).toString("base64"),
      }),
    ).toThrow(expect.objectContaining({ status: 413 }));
    store.complete(device.token, { ...reply, imageBase64 });
    const result = store.result("thread", job.id);
    expect(result).toMatchObject({ status: "done", deviceName: "新设备名" });
    const imagePath = result.imagePath!;
    expect(NodeFS.readFileSync(imagePath)).toEqual(png);
    expect(() => store.result("other-thread", job.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
    advance(24 * 60 * 60_000 + 1);
    expect(store.result("thread", job.id).imagePath).toBeUndefined();
    expect(NodeFS.existsSync(imagePath)).toBe(false);
    store.complete(device.token, { ...reply, imageBase64 });
    expect(store.result("thread", job.id).imagePath).toBeUndefined();
  });

  it("expires queued and claimed jobs and bounds pending work per device", () => {
    const { store, enroll, advance } = setup();
    const device = enroll("PC");
    const first = store.enqueue("thread", device.deviceId, "open-notepad", "first");
    store.poll(device.token, "PC", {});
    const pending = Array.from({ length: 15 }, (_, index) =>
      store.enqueue("thread", device.deviceId, "close-window", `wait-${index}`),
    );
    expect(() => store.enqueue("thread", device.deviceId, "open-notepad", "overflow")).toThrow(
      expect.objectContaining({ status: 429 }),
    );
    advance(2 * 60_000);
    expect(store.poll(device.token, "PC", {}).job).toMatchObject({ id: pending[0]?.id });
    expect(store.result("thread", first.id)).toMatchObject({ status: "failed" });
    expect(() =>
      store.complete(device.token, {
        id: first.id,
        status: "done",
        message: "late",
      }),
    ).toThrow(expect.objectContaining({ status: 409 }));
    advance(3 * 60_000);
    expect(store.poll(device.token, "PC", {}).job).toBeNull();
    expect(store.result("thread", pending[14]!.id)).toMatchObject({ status: "failed" });
    expect(store.list()[0]?.recentTasks).toHaveLength(10);
    advance(2 * 24 * 60 * 60_000 + 60_000);
    expect(() => store.result("thread", first.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});
