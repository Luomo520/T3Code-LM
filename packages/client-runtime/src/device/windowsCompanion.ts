import type { CompanionDevice } from "@t3tools/contracts";

export function windowsCompanionNetworkAdapters(info: CompanionDevice["info"]) {
  return Object.entries(info)
    .filter(([key]) => /^network(?:[1-6])?$/.test(key))
    .sort(([left], [right]) => left.localeCompare(right));
}

function normalizeMac(value: string): string | null {
  const trimmed = value.trim();
  if (
    !/^(?:[\da-f]{12}|[\da-f]{2}(?::[\da-f]{2}){5}|[\da-f]{2}(?:-[\da-f]{2}){5})$/i.test(trimmed)
  ) {
    return null;
  }
  const mac = trimmed.replace(/[:-]/g, "").toLowerCase();
  if (mac === "000000000000" || (Number.parseInt(mac.slice(0, 2), 16) & 1) !== 0) return null;
  return mac;
}

export function lookupWindowsCompanionMac(
  devices: readonly CompanionDevice[],
  address: string,
): readonly CompanionDevice[] | null {
  const mac = normalizeMac(address);
  if (!mac) return null;
  // 网卡地址仅用于查询资料，匹配结果不会进入配对和任务路由。
  return devices.filter((device) =>
    windowsCompanionNetworkAdapters(device.info).some(([, adapter]) =>
      adapter
        .split(" · ")
        .some((field) => field.startsWith("MAC ") && normalizeMac(field.slice(4)) === mac),
    ),
  );
}

export function windowsCompanionAvailability(device: CompanionDevice, enabled: boolean) {
  if (!enabled) return "disabled";
  if (device.info.desktopState === "locked") return "locked";
  if (device.info.desktopState === "paused") return "paused";
  if (!device.online) return "offline";
  return device.info.desktopState === "ready" || device.info.desktopState === "input-paused"
    ? "confirmOnDevice"
    : "unknown";
}

export function windowsCompanionCapabilities(device: CompanionDevice, enabled: boolean) {
  const availability = windowsCompanionAvailability(device, enabled);
  return {
    sendFile: availability,
    receiveFile: availability,
    screenshot: availability,
    screenRecording: availability,
    desktopInput:
      availability === "confirmOnDevice" && device.info.desktopState === "input-paused"
        ? "inputPaused"
        : availability,
    stopRecording:
      device.info.recordingStop !== "true"
        ? "stopLocally"
        : availability === "confirmOnDevice"
          ? device.recentTasks.some(
              (task) => task.action === "record-screen" && task.status === "running",
            )
            ? "stopFromConversation"
            : "noRecording"
          : availability,
    installApp: "unsupported",
  } as const;
}
