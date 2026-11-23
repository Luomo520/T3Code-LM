import * as Schema from "effect/Schema";
import {
  AuthOrchestrationOperateScope,
  type AndroidPhysicalDeviceStatus,
  type DeviceHostSummary,
  type DeviceSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useRef, useState, useSyncExternalStore } from "react";
import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@t3tools/client-runtime/device/screenshot";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { useEnvironmentScope } from "~/state/session";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { Button } from "~/components/ui/button";
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceInputQueue } from "./useDeviceInputQueue";
import { useDeviceControls } from "./useDeviceControls";

const isDeviceScreenshotError = Schema.is(DeviceScreenshotError);

const DOWNLOAD_URL_LIFETIME_MS = 60_000;

const screenReady = (state: AndroidPhysicalDeviceStatus | undefined) =>
  state?.connection === "connected" && state.screen === "unlocked";

function subscribePageVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const pageVisible = () => document.visibilityState === "visible";

function physicalStatusLabel(status: AndroidPhysicalDeviceStatus | undefined) {
  if (!status) return "等待设备自检";
  switch (status.connection) {
    case "permissionDenied":
      return "设备主机缺少 USB 访问权限";
    case "unauthorized":
      return "请在手机上确认 USB 调试授权";
    case "disconnected":
      return "ADB 连接已中断";
    case "unknown":
      return "暂时无法读取 ADB 连接状态";
    case "connected":
      return {
        unlocked: "ADB 已连接，手机已解锁",
        locked: "ADB 已连接，手机已锁屏",
        off: "ADB 已连接，手机屏幕已关闭",
        unknown: "ADB 已连接，暂时无法确认锁屏状态",
      }[status.screen];
  }
}

export function DeviceWorkspace(props: {
  environmentId: EnvironmentId;
  device: DeviceSummary;
  threadId: ThreadId;
  hostLabel: string;
  hostKind: DeviceHostSummary["kind"] | undefined;
  hostDiagnostics: string | undefined;
  visible: boolean;
  onFloat: () => void;
  onClose: () => void;
  onPowerOff: () => void;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  // A capture always finishes, even if the panel hides or closes meanwhile; the user asked for it.
  const capturing = useRef(false);
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  const isPhysicalAndroid = props.device.platform === "android" && props.device.physical;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const documentVisible = useSyncExternalStore(subscribePageVisibility, pageVisible, () => false);
  const foreground = props.visible && documentVisible;
  const [checking, setChecking] = useState(false);
  const queue = useDeviceInputQueue({
    ...props,
    enabled: isPhysicalAndroid && foreground && canOperate,
  });
  const inputLease = queue.view.state === "active" ? queue.view.lease : undefined;
  // Settings and tools run commands on the device's own machine, which EAS and Simlock do not expose.
  const runsHostCommands = props.hostKind === "local" || props.hostKind === "ssh";
  const controls = useDeviceControls({
    ...props,
    access,
    visible: props.visible && runsHostCommands,
    allowActions: !isPhysicalAndroid || (foreground && canOperate && inputLease !== undefined),
    inputLease,
  });
  const physicalStatus = controls.detail?.androidPhysical;
  const readyForInput = foreground && canOperate && access !== null && screenReady(physicalStatus);
  const manualActive = inputLease !== undefined && readyForInput;
  useLiveRefresh(() => void controls.readNow(), {
    enabled: isPhysicalAndroid && foreground,
    intervalMs: 10_000,
  });
  async function checkPhysicalDevice() {
    if (!foreground || checking) return;
    setChecking(true);
    try {
      const status = await controls.readNow();
      if (!screenReady(status?.androidPhysical)) queue.release();
    } finally {
      setChecking(false);
    }
  }
  const saveScreenshot = () => {
    if (
      !access ||
      capturing.current ||
      !props.visible ||
      (isPhysicalAndroid && (!foreground || !screenReady(physicalStatus)))
    )
      return;
    capturing.current = true;
    setScreenshotPending(true);
    setScreenshotError(null);
    return captureDeviceScreenshot(
      { access, platform: props.device.platform, deviceId: props.device.id },
      // Never aborted: see `capturing` above.
      new AbortController().signal,
    )
      .then((image) => {
        const url = URL.createObjectURL(image);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${props.device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
        // The browser reads the blob after the click returns.
        window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_LIFETIME_MS);
      })
      .catch((cause: unknown) => {
        if (isDeviceScreenshotError(cause) && cause.status === 401)
          refreshDeviceHubAccess(props.environmentId);
        setScreenshotError(
          cause instanceof Error ? cause.message : "Screenshot capture failed. Try again.",
        );
      })
      .finally(() => {
        capturing.current = false;
        setScreenshotPending(false);
      });
  };
  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {screenshotError || (controls.error && !toolsOpen) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {screenshotError ?? controls.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceStreamView
            environmentId={props.environmentId}
            platform={props.device.platform}
            deviceName={props.device.name}
            deviceDescription={`${props.hostLabel} · ${props.device.version}${isPhysicalAndroid ? " · Physical device" : ""}`}
            deviceId={props.device.id}
            hostId={props.device.hostId}
            visible={isPhysicalAndroid ? foreground : props.visible}
            inputEnabled={!isPhysicalAndroid || manualActive}
            inputLease={manualActive ? (inputLease ?? null) : null}
            disableAndroidFold={isPhysicalAndroid}
            onInputLost={isPhysicalAndroid ? queue.release : undefined}
            serveSimOnly={props.hostKind === "simlock"}
            axOverlay={axOverlay}
            allowPhoneView
            renderControls={(view) => (
              <>
                {isPhysicalAndroid ? (
                  <div className="absolute top-2 left-2 z-20 flex max-w-[calc(100%-4.5rem)] flex-wrap items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-xs">
                    <span role="status">
                      {controls.detail !== null && !physicalStatus
                        ? "当前服务端未提供真机自检"
                        : physicalStatusLabel(physicalStatus)}
                      {physicalStatus?.connection === "connected" && !view.streaming
                        ? " · 等待画面"
                        : ""}
                      {view.streaming && !view.inputConnected ? " · 输入连接中断" : ""}
                      {manualActive ? " · 正在手动操作" : ""}
                      {queue.view.state === "waiting"
                        ? ` · 排队中，前方 ${queue.view.ahead} 个会话`
                        : ""}
                      {queue.view.state === "ready" ? " · 已轮到本会话，接手前将重新检查设备" : ""}
                      {queue.view.ownerThreadId && queue.view.ownerThreadId !== props.threadId
                        ? ` · 占用会话 ${queue.view.ownerThreadId}`
                        : ""}
                      {queue.error ? ` · ${queue.error}` : ""}
                    </span>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={checking || !foreground}
                      onClick={() => void checkPhysicalDevice()}
                    >
                      自检
                    </Button>
                    {queue.view.state !== "idle" ? (
                      <Button size="xs" variant="outline" onClick={queue.release}>
                        {queue.view.state === "active" ? "暂停并释放输入" : "取消排队"}
                      </Button>
                    ) : null}
                    {queue.view.state === "idle" || queue.view.state === "ready" ? (
                      <Button
                        size="xs"
                        disabled={
                          queue.pending || !readyForInput || !view.streaming || !view.inputConnected
                        }
                        onClick={() =>
                          void (queue.view.state === "idle" ? queue.join() : queue.activate())
                        }
                      >
                        {queue.view.state === "ready" ? "接手操作" : "申请输入"}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
                <DeviceControlsRail
                  platform={props.device.platform}
                  hostKind={props.hostKind}
                  physicalAndroid={isPhysicalAndroid}
                  screenshotAvailable={
                    access !== null &&
                    (isPhysicalAndroid ? screenReady(physicalStatus) && foreground : view.streaming)
                  }
                  handle={view.handle}
                  view={view}
                  controls={controls}
                  screenshotPending={screenshotPending}
                  onScreenshot={() => void saveScreenshot()}
                  toolsOpen={toolsOpen}
                  onTools={() => setToolsOpen(!toolsOpen)}
                  onFloat={props.onFloat}
                  onClose={props.onClose}
                  onPowerOff={props.onPowerOff}
                />
              </>
            )}
          />
        </div>
      </div>
      {toolsOpen ? (
        <DeviceToolsPanel
          device={props.device}
          controls={controls}
          hostDiagnostics={props.hostDiagnostics}
          access={access}
          axOverlay={axOverlay}
          onAxOverlayChange={setAxOverlay}
          onClose={() => setToolsOpen(false)}
          className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none"
        />
      ) : null}
    </>
  );
}
