import { useAtomValue } from "@effect/atom-react";
import type {
  DeviceSummary,
  DeviceUsbBindingInput,
  DeviceUsbBindingReply,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

type UsbAction = Extract<DeviceUsbBindingInput, { hostId: string }>;

export function AndroidUsbBinding(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly device: DeviceSummary;
  readonly foreground: boolean;
}) {
  const supported = useAtomValue(
    serverEnvironment.configValueAtom(props.environmentId),
    (config) => config?.environment.capabilities?.androidUsbBinding === true,
  );
  const command = useAtomCommand(deviceEnvironment.usbBinding, { reportFailure: false });
  const [status, setStatus] = useState<Extract<DeviceUsbBindingReply, { _tag: "status" }> | null>(
    null,
  );
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<UsbAction["_tag"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const target = {
    hostId: props.device.hostId,
    deviceId: props.device.id,
    threadId: props.threadId,
  };

  async function request(input: UsbAction) {
    if (!props.foreground || inFlight.current) return;
    inFlight.current = true;
    setBusy(input._tag);
    setError(null);
    try {
      const result = await command({ environmentId: props.environmentId, input });
      if (result._tag === "Failure") {
        setError(formatEnvironmentQueryError(result.cause));
      } else if (result.value._tag === "challenge") {
        setCode(result.value.code);
      } else if (result.value._tag === "status") {
        setStatus(result.value);
        if (result.value.bound) setCode(null);
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }

  useLiveRefresh(() => void request({ _tag: "usbStatus", ...target }), {
    enabled: supported && props.foreground && code === null,
    intervalMs: 15_000,
    refreshOnShow: true,
  });
  if (!supported) return null;

  return (
    <section aria-label="T3 App 绑定" className="space-y-2 border-b px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span role="status">
          {status?.bound
            ? `已绑定 T3 App · ${status.deviceName ?? props.device.name}`
            : code
              ? "等待手机确认"
              : "绑定本机 T3 App"}
        </span>
        {status?.bound ? (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null || !props.foreground}
            onClick={() => void request({ _tag: "unbindUsb", ...target })}
          >
            解除绑定
          </Button>
        ) : (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null || !props.foreground}
            onClick={() => void request({ _tag: "start", ...target })}
          >
            {code ? "重新生成绑定码" : "生成绑定码"}
          </Button>
        )}
      </div>
      {code ? (
        <div className="space-y-2">
          <output className="select-all font-mono text-base tracking-wider">{code}</output>
          <p className="text-muted-foreground">
            在手机的「设置 → 多端互控 → 此环境 → Android USB
            绑定」中输入绑定码，保持该页打开。绑定码有效期为 2 分钟。
          </p>
          <Button
            size="xs"
            disabled={busy !== null || !props.foreground}
            onClick={() => void request({ _tag: "confirm", ...target, code })}
          >
            {busy === "confirm" ? "正在核验 USB 设备…" : "确认绑定"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
