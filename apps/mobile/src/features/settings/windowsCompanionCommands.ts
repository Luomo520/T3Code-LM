import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../../connection/runtime";

export const createWindowsCompanionPairing = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:windows-companion:create-pairing",
  execute: (_input: null) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.pair(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.pair({ headers }),
    }),
});

export const windowsCompanions = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:windows-companion:list",
  execute: (_input: null) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "GET",
      url: (urls) => urls.list(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.list({ headers }),
    }),
  idleTtlMs: 0,
  staleTimeMs: 0,
});

export const renameWindowsCompanion = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:windows-companion:rename",
  execute: (input: { readonly deviceId: string; readonly name: string }) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.rename({ params: { deviceId: input.deviceId } }),
      timeoutMs: 8_000,
      request: ({ client, headers }) =>
        client.rename({
          headers,
          params: { deviceId: input.deviceId },
          payload: { name: input.name },
        }),
    }),
});

export const revokeWindowsCompanion = createEnvironmentCommand(connectionAtomRuntime, {
  label: "environment-data:windows-companion:revoke",
  execute: (input: { readonly deviceId: string }) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.revoke({ params: { deviceId: input.deviceId } }),
      timeoutMs: 8_000,
      request: ({ client, headers }) =>
        client.revoke({ headers, params: { deviceId: input.deviceId } }),
    }),
});
