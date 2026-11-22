import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

const COMPANION_REQUEST_TIMEOUT_MS = 8_000;

export const windowsCompanionList = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "windows-companion:list",
  execute: (_input: undefined) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "GET",
      url: (urls) => urls.list(),
      timeoutMs: COMPANION_REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) => client.list({ headers }),
    }),
});

export const windowsCompanionPair = createEnvironmentCommand(connectionAtomRuntime, {
  label: "windows-companion:pair",
  execute: (_input: undefined) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.pair(),
      timeoutMs: COMPANION_REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) => client.pair({ headers }),
    }),
});

export const windowsCompanionRename = createEnvironmentCommand(connectionAtomRuntime, {
  label: "windows-companion:rename",
  execute: ({ deviceId, name }: { readonly deviceId: string; readonly name: string }) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.rename({ params: { deviceId } }),
      timeoutMs: COMPANION_REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) =>
        client.rename({ headers, params: { deviceId }, payload: { name } }),
    }),
});

export const windowsCompanionRevoke = createEnvironmentCommand(connectionAtomRuntime, {
  label: "windows-companion:revoke",
  execute: (deviceId: string) =>
    executeConnectedEnvironmentHttpRequest({
      group: "companions",
      method: "POST",
      url: (urls) => urls.revoke({ params: { deviceId } }),
      timeoutMs: COMPANION_REQUEST_TIMEOUT_MS,
      request: ({ client, headers }) => client.revoke({ headers, params: { deviceId } }),
    }),
});
