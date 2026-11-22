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
