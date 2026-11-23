// @effect-diagnostics nodeBuiltinImport:off -- 租约仅由服务端随机生成。
import * as NodeCrypto from "node:crypto";
import type {
  AuthSessionId,
  DeviceInputQueueInput,
  DeviceInputQueueReply,
  ThreadId,
} from "@t3tools/contracts";

const LEASE_MS = 12_000;
type Owner = {
  readonly sessionId: AuthSessionId;
  readonly threadId: ThreadId;
  readonly panelId: string;
};
type Entry = Owner & {
  readonly lease: string;
  deadline: number;
  active: boolean;
};

export const deviceInputKey = (hostId: string, deviceId: string) =>
  JSON.stringify([hostId, deviceId]);

export function makeDeviceInputQueue() {
  const devices = new Map<string, Entry[]>();
  const expire = (key: string, now: number) => {
    const queue = devices.get(key)?.filter((entry) => entry.deadline > now) ?? [];
    if (queue.length === 0) devices.delete(key);
    else devices.set(key, queue);
  };

  function update(
    key: string,
    sessionId: AuthSessionId,
    input: DeviceInputQueueInput,
    now: number,
  ): DeviceInputQueueReply {
    for (const deviceKey of devices.keys()) expire(deviceKey, now);
    const entries = devices.get(key) ?? [];
    let index = entries.findIndex(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.threadId === input.threadId &&
        entry.panelId === input.panelId,
    );
    if (input.action === "join" && index < 0) {
      entries.push({
        sessionId,
        threadId: input.threadId,
        panelId: input.panelId,
        lease: NodeCrypto.randomUUID(),
        deadline: now + LEASE_MS,
        active: false,
      });
      devices.set(key, entries);
      index = entries.length - 1;
    }
    let current = entries[index];
    if (current && input.action === "release" && current.lease === input.lease) {
      entries.splice(index, 1);
      if (entries.length === 0) devices.delete(key);
      current = undefined;
    }
    if (current && input.action === "join" && current.active && input.lease !== current.lease) {
      // 失去客户端租约后重新接手必须重新自检，同时作废旧令牌。
      current = { ...current, lease: NodeCrypto.randomUUID(), active: false };
      entries[index] = current;
    } else if (current && input.action !== "join" && input.lease !== current.lease) {
      current = undefined;
    }
    if (current) {
      if (input.action === "join" || current.lease === input.lease) {
        current.deadline = now + LEASE_MS;
      }
      if (index === 0 && input.action === "activate" && current.lease === input.lease) {
        current.active = true;
      }
    }
    return {
      state: current ? (index > 0 ? "waiting" : current.active ? "active" : "ready") : "idle",
      ownerThreadId: entries[0]?.threadId ?? null,
      ahead: Math.max(0, index),
      ...(current ? { lease: current.lease } : {}),
    };
  }

  return {
    update,
    allows(key: string, sessionId: AuthSessionId, lease: string, now: number) {
      const first = devices.get(key)?.[0];
      return (
        first?.active === true &&
        first.deadline > now &&
        first.sessionId === sessionId &&
        first.lease === lease
      );
    },
    closeThread(key: string, threadId: ThreadId) {
      const entries = devices.get(key)?.filter((entry) => entry.threadId !== threadId);
      if (entries?.length) devices.set(key, entries);
      else devices.delete(key);
    },
  };
}
