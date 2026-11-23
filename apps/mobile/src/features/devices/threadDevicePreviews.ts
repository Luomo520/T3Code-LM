import type { DeviceServiceState, ThreadId } from "@t3tools/contracts";

/** Host identity is part of the selection because Android serials repeat across hosts. */
export function threadDevicePreviews(state: DeviceServiceState | null, threadId: ThreadId) {
  return (state?.sessions ?? [])
    .filter((session) => session.threadId === threadId)
    .map((session) => {
      const device = state?.devices.find(
        (device) => device.hostId === session.hostId && device.id === session.deviceId,
      );
      const host = state?.hosts.find((host) => host.id === session.hostId);
      const physicalAndroid = device?.platform === "android" && device.physical;
      return {
        key: JSON.stringify([session.hostId, session.deviceId]),
        session,
        name: device?.name ?? (session.platform === "ios" ? "iOS Simulator" : "Android device"),
        description: [device?.version, host?.label, physicalAndroid ? "Android 真机" : null]
          .filter(Boolean)
          .join(" · "),
        physicalAndroid,
        canShutdown: device !== undefined && !physicalAndroid,
        serveSimOnly: host?.kind === "simlock",
      };
    });
}

export type ThreadDevicePreview = ReturnType<typeof threadDevicePreviews>[number];

export function selectedThreadDevicePreview(
  previews: ReadonlyArray<ThreadDevicePreview>,
  selectedKey: string | null,
) {
  return previews.find((preview) => preview.key === selectedKey) ?? previews[0] ?? null;
}
