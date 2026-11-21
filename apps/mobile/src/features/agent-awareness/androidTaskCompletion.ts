import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { AppRegistry, AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { flattenQueuedThreadMessages, threadOutboxManager } from "../../state/thread-outbox";
import {
  postAndroidTaskCompletion,
  setAndroidTaskCompletionMonitoring,
  supportsAndroidLocalTaskCompletion,
} from "./androidNotifications";
import { createTaskCompletionTracker } from "./taskCompletionTracker";

const hasQueuedOnlineTaskAtom = Atom.make((get) => {
  const queued = get(threadOutboxManager.queuedMessagesByThreadKeyAtom);
  const catalog = get(environmentCatalog.catalogValueAtom);
  const enabled = new Set(enabledEnvironmentIds(catalog));
  return flattenQueuedThreadMessages(queued).some(
    ({ environmentId }) =>
      enabled.has(environmentId) &&
      get(environmentShell.stateValueAtom(environmentId)).status === "live",
  );
}).pipe(Atom.withLabel("mobile:queued-online-task-for-completion"));

/** Observes the same authoritative shell used by the UI, including replay after a socket loss. */
export function installAndroidTaskCompletion(): () => void {
  if (!supportsAndroidLocalTaskCompletion()) return () => undefined;

  // The existing Android React instance retains timers and its socket while this task is active.
  // The native service ends the task when the last run settles or its monitoring window expires.
  AppRegistry.registerHeadlessTask(
    "T3TaskCompletionMonitor",
    () => () => new Promise<void>(() => {}),
  );

  let hasQueuedOnlineTask = false;
  let monitoring = false;
  const tracker = createTaskCompletionTracker({
    background: AppState.currentState === "background",
    onCompletion: postAndroidTaskCompletion,
  });
  const checkMonitoring = (resumed = false) => {
    if (hasQueuedOnlineTask || tracker.hasActiveRuns()) {
      if (AppState.currentState === "active" && (!monitoring || resumed)) {
        monitoring = setAndroidTaskCompletionMonitoring(true);
      }
    } else if (monitoring) {
      setAndroidTaskCompletionMonitoring(false);
      monitoring = false;
    }
  };

  const appState = AppState.addEventListener("change", (state) => {
    tracker.setBackground(state === "background");
    if (state === "active") checkMonitoring(true);
  });
  const environments = new Map<EnvironmentId, () => void>();
  const catalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    (value) => {
      const enabled = new Set(enabledEnvironmentIds(value));
      for (const [environmentId, release] of environments) {
        if (enabled.has(environmentId)) continue;
        release();
        environments.delete(environmentId);
        tracker.removeEnvironment(environmentId);
      }
      for (const environmentId of enabled) {
        if (environments.has(environmentId)) continue;
        const release = appAtomRegistry.subscribe(
          environmentShell.stateValueAtom(environmentId),
          (state) => {
            // An offline cache or partial replay must not discard a run being watched.
            if (state.status !== "live" || Option.isNone(state.snapshot)) return;
            tracker.observe(environmentId, state.snapshot.value.threads);
            checkMonitoring();
          },
          { immediate: true },
        );
        environments.set(environmentId, release);
      }
      checkMonitoring();
    },
    { immediate: true },
  );
  const outbox = appAtomRegistry.subscribe(
    hasQueuedOnlineTaskAtom,
    (queued) => {
      hasQueuedOnlineTask = queued;
      checkMonitoring();
    },
    { immediate: true },
  );
  return () => {
    appState.remove();
    catalog();
    outbox();
    for (const release of environments.values()) release();
    if (monitoring) setAndroidTaskCompletionMonitoring(false);
  };
}
