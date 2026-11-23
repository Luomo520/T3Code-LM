import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";

import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  deviceEnvironment,
  mayHaveAndroidUsbBinding,
  setAndroidUsbBindingHint,
} from "../../state/device";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { workspaceConnections } from "../../state/workspace";

export function useAndroidDockInputPriority() {
  const environments = useAtomValue(workspaceConnections.environmentsAtom);
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const command = useAtomCommand(deviceEnvironment.usbBinding, {
    reportFailure: false,
    reportDefect: false,
  });

  return () => {
    for (const environment of environments) {
      const { environmentId } = environment;
      if (
        !environment.isEnabled ||
        environment.connectionState !== "connected" ||
        !permitted.has(environmentId) ||
        !mayHaveAndroidUsbBinding(environmentId) ||
        appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.environment
          .capabilities?.androidUsbBinding !== true
      )
        continue;
      const panelId = uuidv4();
      void command({ environmentId, input: { _tag: "appInput", action: "join", panelId } }).then(
        async (result) => {
          if (result._tag !== "Success" || result.value._tag !== "input") return;
          if (result.value.state === "unbound") setAndroidUsbBindingHint(environmentId, false);
          if (result.value.lease) {
            await command({
              environmentId,
              input: { _tag: "appInput", action: "release", panelId, lease: result.value.lease },
            });
          }
        },
      );
    }
  };
}
