import * as Effect from "effect/Effect";
import { expect, it } from "@effect/vitest";
import { readAndroidPhysicalDeviceStatus } from "./AndroidPhysicalDevice.ts";

it.effect.each([
  ["false", "false", "ON", "unlocked"],
  ["true", "false", "ON", "locked"],
  ["false", "true", "ON", "locked"],
  ["true", "true", "OFF", "off"],
] as const)(
  "reads keyguard showing=%s restricted=%s screen=%s",
  ([showing, restricted, screen, expected]) =>
    Effect.gen(function* () {
      const output = `unrelated showing=true
    KeyguardServiceDelegate
      showing=${showing}
      inputRestricted=${restricted}
      screenState=SCREEN_STATE_${screen}
  `;
      const read = readAndroidPhysicalDeviceStatus(
        () => Effect.succeed({ code: 0, stdout: output, stderr: "" }),
        "usb-serial",
      );
      expect(yield* read).toEqual({ connection: "connected", screen: expected });
    }),
);

it.effect.each([
  ["no permissions", "permissionDenied"],
  ["device unauthorized", "unauthorized"],
  ["device offline", "disconnected"],
] as const)("reports %s without inventing a lock state", ([error, connection]) =>
  Effect.gen(function* () {
    const read = readAndroidPhysicalDeviceStatus(
      () => Effect.succeed({ code: 1, stdout: "", stderr: error }),
      "usb-serial",
    );
    expect(yield* read).toEqual({ connection, screen: "unknown" });
  }),
);
