import type { AndroidPhysicalDeviceStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DeviceHostReady, HostDevice } from "./DeviceHost.ts";

export const listPhysicalAndroidDevices = Effect.fn("AndroidPhysicalDevice.list")(function* (
  run: DeviceHostReady["run"],
  hubDevices: ReadonlyArray<HostDevice>,
) {
  const listed = yield* run("adb", ["devices", "-l"], { timeoutMs: 5_000 });
  if (listed.code !== 0) {
    return {
      devices: [],
      detail: "Could not list connected Android devices with ADB.",
    };
  }

  const lines = listed.stdout.split(/\r?\n/).map((line) => line.trim());
  const diagnostics = [
    ...(lines.some((line) => /^\S+\s+no permissions\b/.test(line))
      ? ["The device host does not have permission to access an Android USB device."]
      : []),
    ...(lines.some((line) => /^\S+\s+unauthorized\b/.test(line))
      ? ["Unlock the Android device and accept its USB debugging prompt, then refresh."]
      : []),
    ...(lines.some((line) => /^\S+\s+offline\b/.test(line) && !/^emulator-\d+\s/.test(line))
      ? ["An Android device is offline in ADB. Reconnect it, then refresh."]
      : []),
  ];

  const hubIds = new Set(
    hubDevices
      .filter((device) => device.platform === "android" && device.booted)
      .map((device) => device.id),
  );
  const connected = lines.flatMap((line) => {
    const match = /^(\S{1,256})\s+device(?:\s+(.*))?$/.exec(line);
    if (!match) return [];
    const serial = match[1]!;
    if (/^emulator-\d+$/.test(serial) || hubIds.has(serial)) return [];
    const model = /(?:^|\s)model:(\S+)/.exec(match[2] ?? "")?.[1]?.replaceAll("_", " ");
    return [{ serial, model }];
  });
  const devices = yield* Effect.forEach(
    connected,
    ({ serial, model }) =>
      run("adb", ["-s", serial, "shell", "getprop"], { timeoutMs: 5_000 }).pipe(
        Effect.map((properties): HostDevice | null => {
          if (
            properties.code !== 0 ||
            /^\[(?:ro\.kernel\.qemu|ro\.boot\.qemu)\]:\s*\[1\]/m.test(properties.stdout)
          ) {
            return null;
          }
          const name = /^\[ro\.product\.model\]:\s*\[([^\r\n]+)\]/m
            .exec(properties.stdout)?.[1]
            ?.trim();
          const release = /^\[ro\.build\.version\.release\]:\s*\[([^\r\n]+)\]/m
            .exec(properties.stdout)?.[1]
            ?.trim();
          return {
            id: serial,
            name: name || model || serial,
            version: release ? `Android ${release}` : "Android",
            platform: "android",
            booted: true,
            physical: true,
          };
        }),
      ),
    { concurrency: 4 },
  );
  return {
    devices: devices.filter((device) => device !== null),
    detail: diagnostics.join("\n"),
  };
});

export const readAndroidPhysicalDeviceStatus = Effect.fn("AndroidPhysicalDevice.readStatus")(
  function* (
    run: DeviceHostReady["run"],
    serial: string,
  ): Effect.fn.Return<AndroidPhysicalDeviceStatus> {
    const result = yield* run("adb", ["-s", serial, "shell", "dumpsys", "window", "policy"], {
      timeoutMs: 5_000,
    });
    if (result.code !== 0) {
      const error = result.stderr + result.stdout;
      const connection = /no permissions|insufficient permissions/i.test(error)
        ? "permissionDenied"
        : /unauthorized/i.test(error)
          ? "unauthorized"
          : /device.+not found|no devices|device offline|device disconnected/i.test(error)
            ? "disconnected"
            : "unknown";
      return { connection, screen: "unknown" };
    }

    // KeyguardServiceDelegate 提供实际锁屏状态。其他窗口可能也包含 showing 字段。
    const keyguard =
      /^\s*KeyguardServiceDelegate:?[^\S\r\n]*\r?\n((?:[\t ]+[^\r\n]*\r?\n?)*)/m.exec(
        result.stdout,
      )?.[1] ?? "";
    const showing = /^\s*showing=(true|false)\s*$/m.exec(keyguard)?.[1];
    const restricted = /^\s*inputRestricted=(true|false)\s*$/m.exec(keyguard)?.[1];
    const screenState = /^\s*screenState=([A-Z_]+)\s*$/m.exec(keyguard)?.[1];
    const screen =
      screenState === "SCREEN_STATE_OFF"
        ? "off"
        : showing === "true" || restricted === "true"
          ? "locked"
          : showing === "false" && restricted === "false" && screenState === "SCREEN_STATE_ON"
            ? "unlocked"
            : "unknown";
    return { connection: "connected", screen };
  },
);
