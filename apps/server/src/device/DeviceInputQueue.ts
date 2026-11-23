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
  activationVersion: number;
  readonly localApp?: true;
};

export const deviceInputKey = (hostId: string, deviceId: string) =>
  JSON.stringify([hostId, deviceId]);

export function makeDeviceInputQueue() {
  const devices = new Map<string, Entry[]>();
  const dockActions = new Map<string, { interrupted: boolean }>();
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
    localApp?: true,
  ): DeviceInputQueueReply {
    for (const deviceKey of devices.keys()) expire(deviceKey, now);
    const entries = devices.get(key) ?? [];
    let index = entries.findIndex(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.threadId === input.threadId &&
        entry.panelId === input.panelId &&
        entry.localApp === localApp,
    );
    const fresh = input.action === "join" && index < 0 && input.lease === undefined;
    if (fresh) {
      const entry: Entry = {
        sessionId,
        threadId: input.threadId,
        panelId: input.panelId,
        lease: NodeCrypto.randomUUID(),
        deadline: now + LEASE_MS,
        active: false,
        activationVersion: 0,
        ...(localApp ? { localApp } : {}),
      };
      const dockAction = dockActions.get(key);
      if (dockAction) dockAction.interrupted = true;
      if (localApp) {
        // 本机优先。若原队首正在重读屏幕，交还后也须从头检查。
        const head = entries[0];
        if (head?.active) {
          entries.shift();
        } else if (head) {
          head.activationVersion++;
        }
        entries.unshift(entry);
        index = 0;
      } else {
        entries.push(entry);
        index = entries.length - 1;
      }
      devices.set(key, entries);
    }
    let current = entries[index];
    if (current && input.action === "release" && current.lease === input.lease) {
      entries.splice(index, 1);
      if (entries.length === 0) devices.delete(key);
      current = undefined;
    }
    if (current && !fresh && input.lease !== current.lease) {
      current = undefined;
    }
    if (current) {
      if (input.action === "join" || current.lease === input.lease) {
        current.deadline = now + LEASE_MS;
      }
      if (index === 0 && (localApp || (input.action === "activate" && !dockActions.has(key)))) {
        current.active = true;
      }
    }
    return {
      state: current ? (index > 0 ? "waiting" : current.active ? "active" : "ready") : "idle",
      ownerThreadId: entries[0]?.localApp ? null : (entries[0]?.threadId ?? null),
      ...(entries[0]?.localApp ? { ownerLocalApp: true as const } : {}),
      ahead: Math.max(0, index),
      ...(current ? { lease: current.lease } : {}),
    };
  }

  return {
    update,
    beginActivation(
      key: string,
      sessionId: AuthSessionId,
      input: DeviceInputQueueInput,
      now: number,
    ) {
      expire(key, now);
      const first = devices.get(key)?.[0];
      if (
        !first ||
        first.active ||
        first.localApp ||
        dockActions.has(key) ||
        first.lease !== input.lease ||
        first.sessionId !== sessionId ||
        first.threadId !== input.threadId ||
        first.panelId !== input.panelId
      ) {
        return null;
      }
      const version = ++first.activationVersion;
      return (checkedAt: number) =>
        devices.get(key)?.[0] === first &&
        first.deadline > checkedAt &&
        first.activationVersion === version;
    },
    reserveDockAction(key: string, now: number) {
      expire(key, now);
      if (devices.has(key) || dockActions.has(key)) return null;
      const action = { interrupted: false };
      dockActions.set(key, action);
      return {
        canStart: () => dockActions.get(key) === action && !action.interrupted,
        release: () => {
          if (dockActions.get(key) === action) dockActions.delete(key);
        },
      };
    },
    allows(key: string, sessionId: AuthSessionId, lease: string, now: number) {
      const first = devices.get(key)?.[0];
      return (
        first?.active === true &&
        !first.localApp &&
        first.deadline > now &&
        first.sessionId === sessionId &&
        first.lease === lease
      );
    },
    closeApp(key: string) {
      const entries = devices.get(key)?.filter((entry) => !entry.localApp);
      if (entries?.length) devices.set(key, entries);
      else devices.delete(key);
    },
    closeThread(key: string, threadId: ThreadId) {
      const entries = devices.get(key)?.filter((entry) => entry.threadId !== threadId);
      if (entries?.length) devices.set(key, entries);
      else devices.delete(key);
    },
  };
}
