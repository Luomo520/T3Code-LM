import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { AppState } from "react-native";

import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession, sessionHasScope } from "../../state/session";
import { workspaceConnections } from "../../state/workspace";
import {
  canNotifyAndroidCaptureRequests,
  postAndroidCaptureRequest,
  readAndroidCaptureBackgroundWatch,
} from "../agent-awareness/androidNotifications";
import { androidCapturePhoneName, captureCommand } from "./androidCaptureClient";
import { readAndroidCapturePolicy } from "./androidCapturePolicy";

const CHECK_WINDOW_MS = 20_000;

const readyCaptureEnvironments = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom).filter(
    ({ isEnabled, environmentId, connectionState }) =>
      isEnabled &&
      connectionState === "connected" &&
      sessionHasScope(
        get(environmentSession.sessionStateAtom(environmentId)),
        AuthOrchestrationOperateScope,
      ),
  ),
);

export function checkAndroidCaptureRequestsInBackground(): Promise<void> {
  const canCheck = () =>
    AppState.currentState === "background" &&
    canNotifyAndroidCaptureRequests() &&
    readAndroidCaptureBackgroundWatch() > Date.now();
  const canReceive = (environmentId: EnvironmentId) =>
    readAndroidCapturePolicy(environmentId, "screenshot") !== "deny" ||
    readAndroidCapturePolicy(environmentId, "record-screen") !== "deny";
  if (!canCheck()) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const checked = new Set<string>();
    const release = appAtomRegistry.subscribe(
      readyCaptureEnvironments,
      (environments) => {
        for (const { environmentId, environmentLabel } of environments) {
          if (checked.has(environmentId) || !canCheck() || !canReceive(environmentId)) continue;
          checked.add(environmentId);
          void runAtomCommand(
            appAtomRegistry,
            captureCommand,
            {
              environmentId,
              input: {
                _tag: "listen",
                name: androidCapturePhoneName(),
                delivery: "background",
              },
            },
            { reportFailure: false, reportDefect: false },
          ).then((reply) => {
            if (
              finished ||
              !canCheck() ||
              reply._tag !== "Success" ||
              reply.value._tag !== "pending"
            ) {
              return;
            }
            const job = reply.value.job;
            if (!job?.expiresInMs) return;
            if (readAndroidCapturePolicy(environmentId, job.action) === "deny") {
              // 手机撤销此操作后，原会话应收到拒绝回执，不必等待后台队列过期。
              return runAtomCommand(
                appAtomRegistry,
                captureCommand,
                { environmentId, input: { _tag: "reject", id: job.id, reason: "denied" } },
                { reportFailure: false, reportDefect: false },
              ).then(() => undefined);
            }
            postAndroidCaptureRequest({
              environmentId,
              environmentLabel,
              threadId: job.threadId,
              jobId: job.id,
              recording: job.action === "record-screen",
              expiresInMs: job.expiresInMs,
            });
          });
        }
      },
      { immediate: true },
    );
    const lifecycle = AppState.addEventListener("change", (state) => {
      if (state === "active") finish();
    });
    const timer = setTimeout(finish, CHECK_WINDOW_MS);

    function finish() {
      finished = true;
      clearTimeout(timer);
      lifecycle.remove();
      release();
      resolve();
    }
  });
}
