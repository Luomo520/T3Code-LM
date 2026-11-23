import { AuthSessionId, ThreadId, type DeviceInputQueueInput } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deviceInputKey, makeDeviceInputQueue } from "./DeviceInputQueue.ts";

const host = "local";
const device = "usb";
const key = deviceInputKey(host, device);
const left = AuthSessionId.make("pc");
const right = AuthSessionId.make("android");
const request = (
  id: DemoActor,
  action: DeviceInputQueueInput["action"],
  lease?: string,
): DeviceInputQueueInput => ({
  hostId: host,
  deviceId: device,
  threadId: ThreadId.make(id),
  panelId: id,
  action,
  ...(lease ? { lease } : {}),
});
type DemoActor = "one" | "two" | "three";

describe("foreground physical device input", () => {
  it("keeps viewers outside FIFO and lets a queued owner cancel", () => {
    const queue = makeDeviceInputQueue();
    expect(queue.update(key, right, request("three", "status"), 0).state).toBe("idle");
    const first = queue.update(key, left, request("one", "join"), 0);
    const second = queue.update(key, right, request("two", "join"), 1);
    const third = queue.update(key, right, request("three", "join"), 2);
    expect(second).toMatchObject({ state: "waiting", ahead: 1, ownerThreadId: "one" });
    expect(third).toMatchObject({ state: "waiting", ahead: 2 });
    expect(queue.update(key, left, request("one", "join"), 3).lease).toBeUndefined();
    expect(queue.update(key, left, request("one", "join", first.lease), 3).lease).toBe(first.lease);
    expect(queue.update(key, right, request("two", "join"), 3).lease).toBeUndefined();
    expect(queue.update(key, right, request("three", "activate", third.lease), 4).state).toBe(
      "waiting",
    );
    expect(queue.allows(key, right, third.lease!, 4)).toBe(false);
    queue.update(key, right, request("two", "release", second.lease), 5);
    expect(queue.update(key, right, request("three", "status", third.lease), 6).ahead).toBe(1);
  });

  it("expires disconnected owners, keeps devices independent and rejects stale writes", () => {
    const queue = makeDeviceInputQueue();
    const otherDevice = deviceInputKey(host, "another");
    const first = queue.update(key, left, request("one", "join"), 0);
    const second = queue.update(key, right, request("two", "join"), 1000);
    const parallel = queue.update(otherDevice, right, request("three", "join"), 1000);
    expect(queue.allows(key, left, first.lease!, 1)).toBe(false);
    queue.update(key, left, request("one", "activate", first.lease), 1000);
    queue.update(otherDevice, right, request("three", "activate", parallel.lease), 1000);
    expect(queue.allows(key, left, first.lease!, 2000)).toBe(true);
    expect(queue.allows(key, right, first.lease!, 2000)).toBe(false);
    expect(queue.allows(otherDevice, right, parallel.lease!, 2000)).toBe(true);
    queue.update(key, right, request("two", "status", second.lease), 12000);
    const next = queue.update(key, right, request("two", "status", second.lease), 13001);
    expect(next.state).toBe("ready");
    expect(queue.allows(key, left, first.lease!, 13001)).toBe(false);
    expect(queue.allows(key, right, second.lease!, 13001)).toBe(false);
    queue.update(key, right, request("two", "activate", second.lease), 13002);
    expect(queue.allows(key, right, second.lease!, 13003)).toBe(true);
    expect(queue.update(key, right, request("two", "status"), 13004).state).toBe("idle");
    expect(queue.update(key, right, request("two", "join"), 13004).lease).toBeUndefined();
    expect(queue.allows(key, right, second.lease!, 13005)).toBe(true);
    queue.closeThread(key, ThreadId.make("two"));
    const restarted = queue.update(key, right, request("two", "join"), 13004);
    queue.update(key, right, request("two", "release", second.lease), 13005);
    expect(queue.update(key, right, request("two", "status", restarted.lease), 13006).state).toBe(
      "ready",
    );
    expect(restarted.lease).not.toBe(second.lease);
  });
});

it("does not disclose the owner token and gives manual input precedence over a Dock action", () => {
  const queue = makeDeviceInputQueue();
  const auto = queue.reserveDockAction(key, 0)!;
  const first = queue.update(key, left, request("one", "join"), 1);
  expect(auto.canStart()).toBe(false);
  expect(queue.update(key, left, request("one", "activate", first.lease), 2).state).toBe("ready");
  auto.release();
  expect(queue.update(key, left, request("one", "activate", first.lease), 3).state).toBe("active");
  expect(queue.reserveDockAction(key, 4)).toBeNull();
  expect(queue.update(key, right, request("one", "status"), 5).lease).toBeUndefined();
  expect(
    queue.update(key, left, { ...request("two", "status", first.lease), panelId: "one" }, 5).lease,
  ).toBeUndefined();
  expect(queue.update(key, left, request("one", "join", "wrong"), 5).lease).toBeUndefined();
  expect(queue.update(key, left, request("one", "status", first.lease), 6).state).toBe("active");
});
