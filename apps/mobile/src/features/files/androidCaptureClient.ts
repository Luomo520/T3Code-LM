import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentCommand } from "@t3tools/client-runtime/state/runtime";
import type { AndroidCaptureInput, AndroidCaptureJob } from "@t3tools/contracts";
import * as Device from "expo-device";

import { connectionAtomRuntime } from "../../connection/runtime";

export const captureCommand = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:android-capture",
  execute: (payload: typeof AndroidCaptureInput.Type) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.androidCapture(),
      timeoutMs: payload._tag === "complete" ? 25_000 : 8_000,
      requestInit: { redirect: "error" },
      request: ({ client, headers }) => client.androidCapture({ headers, payload }),
    }),
});

export type AndroidCaptureJobData = typeof AndroidCaptureJob.Type;
export function androidCapturePhoneName(): string {
  return (Device.deviceName?.trim() || Device.modelName?.trim() || "Android 手机").slice(0, 128);
}
