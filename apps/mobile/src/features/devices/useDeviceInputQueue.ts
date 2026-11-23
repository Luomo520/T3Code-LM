import type {
  DeviceInputQueueInput,
  DeviceInputQueueReply,
  DeviceSummary,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { uuidv4 } from "../../lib/uuid";
import { deviceEnvironment } from "../../state/device";
import * as Cause from "effect/Cause";
import { useAtomCommand } from "../../state/use-atom-command";

const EMPTY: DeviceInputQueueReply = { state: "idle", ownerThreadId: null, ahead: 0 };

export function useDeviceInputQueue(options: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly device: Pick<DeviceSummary, "hostId" | "id">;
  readonly enabled: boolean;
}) {
  const command = useAtomCommand(deviceEnvironment.inputQueue, { reportFailure: false });
  const [panelId] = useState(uuidv4);
  const [view, setView] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [leaseNotice, setLeaseNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lease = useRef<string | null>(null);
  const generation = useRef(0);
  const renewing = useRef(false);
  const request = (action: DeviceInputQueueInput["action"], token: string | null) =>
    command({
      environmentId: options.environmentId,
      input: {
        deviceId: options.device.id,
        hostId: options.device.hostId,
        threadId: options.threadId,
        panelId,
        action,
        ...(token === null ? {} : { lease: token }),
      },
    });

  async function refresh(action: "status" | "join" | "activate") {
    const version = generation.current;
    const requestedLease = lease.current;
    const result = await request(action, requestedLease);
    if (generation.current !== version) {
      if (action === "join" && result._tag === "Success" && result.value.lease) {
        await request("release", result.value.lease);
      }
      return;
    }
    if (result._tag === "Success") {
      if (requestedLease !== null && result.value.lease === undefined) {
        setLeaseNotice(
          result.value.ownerLocalApp
            ? "手机已接手，请重新申请输入。"
            : "输入请求已失效，请重新申请。",
        );
      }
      lease.current = result.value.lease ?? null;
      setView(result.value);
      setError(null);
    } else {
      setError(String(Cause.squash(result.cause)));
      if (action === "status") {
        const current = lease.current;
        lease.current = null;
        if (current !== null) {
          setLeaseNotice("设备连接中断，请重新申请输入。");
          void request("release", current);
        }
        setView(EMPTY);
      }
    }
  }

  async function change(action: "join" | "activate") {
    if (!options.enabled || pending) return;
    generation.current++;
    setLeaseNotice(null);
    setPending(true);
    try {
      await refresh(action);
    } finally {
      setPending(false);
    }
  }

  function release() {
    generation.current++;
    const current = lease.current;
    lease.current = null;
    setView(EMPTY);
    setError(null);
    setLeaseNotice(null);
    if (current !== null) void request("release", current);
  }

  const releaseOnClose = useEffectEvent(release);
  const renewFromTimer = useEffectEvent(() => {
    if (pending || renewing.current) return;
    renewing.current = true;
    void refresh("status").finally(() => {
      renewing.current = false;
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 前台面板退出时释放队列，心跳失效时由服务端回收。
  useEffect(() => {
    if (!options.enabled) return;
    renewFromTimer();
    const timer = setInterval(renewFromTimer, 2_000);
    return () => {
      clearInterval(timer);
      releaseOnClose();
    };
  }, [options.enabled]);

  return {
    view,
    error: error ?? leaseNotice,
    pending,
    join: () => change("join"),
    activate: () => change("activate"),
    release,
  };
}
