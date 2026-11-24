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
const POLL_INTERVAL_MS = 4_000;

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
  const deadline = Date.now() + CHECK_WINDOW_MS;
  const canCheck = () =>
    Date.now() < deadline &&
    AppState.currentState === "background" &&
    canNotifyAndroidCaptureRequests() &&
    readAndroidCaptureBackgroundWatch() > Date.now();
  const canReceive = (environmentId: EnvironmentId) =>
    readAndroidCapturePolicy(environmentId, "screenshot") !== "deny" ||
    readAndroidCapturePolicy(environmentId, "record-screen") !== "deny";
  if (!canCheck()) return Promise.resolve();

  return new Promise((resolve) => {
    let finished = false;
    const inFlight = new Set<EnvironmentId>();
    const handled = new Map<EnvironmentId, string>();
    let environments = appAtomRegistry.get(readyCaptureEnvironments);

    async function check(environmentId: EnvironmentId, environmentLabel: string) {
      inFlight.add(environmentId);
      try {
        const reply = await runAtomCommand(
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
        );
        if (finished || !canCheck() || reply._tag !== "Success" || reply.value._tag !== "pending") {
          return;
        }
        const job = reply.value.job;
        if (
          job?.expiresInMs === undefined ||
          job.expiresInMs <= 0 ||
          handled.get(environmentId) === job.id
        )
          return;
        if (readAndroidCapturePolicy(environmentId, job.action) === "deny") {
          // 手机撤销此操作后，原会话应收到拒绝回执，不必等待后台队列过期。
          const rejected = await runAtomCommand(
            appAtomRegistry,
            captureCommand,
            { environmentId, input: { _tag: "reject", id: job.id, reason: "denied" } },
            { reportFailure: false, reportDefect: false },
          );
          if (rejected._tag === "Success") handled.set(environmentId, job.id);
          return;
        }
        postAndroidCaptureRequest({
          environmentId,
          environmentLabel,
          threadId: job.threadId,
          jobId: job.id,
          recording: job.action === "record-screen",
          expiresInMs: job.expiresInMs,
        });
        handled.set(environmentId, job.id);
      } finally {
        // 网络失败时释放当前查询，下次检查可用同一配对环境重试。
        inFlight.delete(environmentId);
      }
    }

    function poll() {
      if (finished || !canCheck()) return;
      for (const { environmentId, environmentLabel } of environments) {
        if (inFlight.has(environmentId) || !canReceive(environmentId)) continue;
        void check(environmentId, environmentLabel).catch(() => {});
      }
    }

    const release = appAtomRegistry.subscribe(
      readyCaptureEnvironments,
      (connected) => {
        environments = connected;
        poll();
      },
      { immediate: true },
    );
    // 用户可能在首次查询后才发起请求，在本次 Android 后台检查内继续查询队列。
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    const lifecycle = AppState.addEventListener("change", (state) => {
      if (state === "active") finish();
    });
    const timer = setTimeout(finish, CHECK_WINDOW_MS);

    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(interval);
      lifecycle.remove();
      release();
      resolve();
    }
  });
}
