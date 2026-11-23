import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";

export const linuxSshDevices = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "linux-devices:list",
  execute: (_input: null) =>
    executeConnectedEnvironmentHttpRequest({
      group: "linuxDevices",
      method: "GET",
      url: (urls) => urls.list(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.list({ headers }),
    }),
  idleTtlMs: 0,
  staleTimeMs: 0,
});
