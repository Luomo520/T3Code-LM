import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { AppRegistry, AppState } from "react-native";

import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentShell } from "../../state/shell";
import { flattenQueuedThreadMessages, threadOutboxManager } from "../../state/thread-outbox";
import {
  postAndroidTaskCompletion,
  readAndroidTaskCompletionWatch,
  setAndroidTaskCompletionWatch,
  supportsAndroidLocalTaskCompletion,
} from "./androidNotifications";
import { createTaskCompletionTracker, TaskCompletionWatch } from "./taskCompletionTracker";

const BACKGROUND_WINDOW_MS = 2 * 60 * 60 * 1000;
const QUEUED_START_WINDOW_MS = 90_000;
const CHECK_WINDOW_MS = 20_000;

const decodeWatch = Schema.decodeUnknownOption(Schema.fromJsonString(TaskCompletionWatch));

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

  let savedWatch = readAndroidTaskCompletionWatch();
  const restored = Option.getOrNull(decodeWatch(savedWatch));
  let background = AppState.currentState === "background";
  let backgroundUntil = restored?.backgroundUntil ?? 0;
  let queuedUntil = restored?.queuedUntil ?? 0;
  let hasQueuedOnlineTask = false;
  let finishCheck: (() => void) | null = null;

  const tracker = createTaskCompletionTracker({
    background,
    ...(restored && { watchedRuns: restored.runs }),
    onCompletion: postAndroidTaskCompletion,
  });

  AppRegistry.registerHeadlessTask(
    "T3TaskCompletionCheck",
    () => () =>
      new Promise<void>((resolve) => {
        if (!background || readAndroidTaskCompletionWatch() === null) {
          resolve();
          return;
        }

        finishCheck?.();
        const finish = () => {
          clearTimeout(timer);
          finishCheck = null;
          resolve();
        };
        const timer = setTimeout(finish, CHECK_WINDOW_MS);
        finishCheck = finish;
      }),
  );

  const syncWatch = () => {
    const now = Date.now();
    const runs = backgroundUntil > now ? tracker.watchedRuns() : [];
    const expiresAt = runs.length > 0 ? backgroundUntil : queuedUntil;
    const watch = expiresAt > now ? JSON.stringify({ backgroundUntil, queuedUntil, runs }) : null;
    if (watch !== savedWatch) {
      savedWatch = watch;
      setAndroidTaskCompletionWatch(watch, expiresAt, background);
    }
    if (watch === null || !background) finishCheck?.();
  };

  const appState = AppState.addEventListener("change", (state) => {
    const next = state === "background";
    if (next === background) return;
    background = next;
    tracker.setBackground(background);
    if (background) {
      const now = Date.now();
      backgroundUntil = now + BACKGROUND_WINDOW_MS;
      queuedUntil = hasQueuedOnlineTask ? now + QUEUED_START_WINDOW_MS : 0;
    } else {
      queuedUntil = 0;
    }
    syncWatch();
  });

  const environments = new Map<EnvironmentId, () => void>();
  const catalog = appAtomRegistry.subscribe(
    environmentCatalog.catalogValueAtom,
    (value) => {
      // The initial empty catalog is published before saved connections are loaded.
      if (!value.isReady) return;
      const enabled = new Set(enabledEnvironmentIds(value));
      tracker.retainEnvironments(enabled);
      for (const [environmentId, release] of environments) {
        if (enabled.has(environmentId)) continue;
        release();
        environments.delete(environmentId);
      }
      for (const environmentId of enabled) {
        if (environments.has(environmentId)) continue;
        const release = appAtomRegistry.subscribe(
          environmentShell.stateValueAtom(environmentId),
          (state) => {
            // An offline cache or partial replay must not discard a run being watched.
            if (state.status !== "live" || Option.isNone(state.snapshot)) return;
            tracker.observe(environmentId, state.snapshot.value.threads);
            syncWatch();
          },
          { immediate: true },
        );
        environments.set(environmentId, release);
      }
      syncWatch();
    },
    { immediate: true },
  );
  const outbox = appAtomRegistry.subscribe(
    hasQueuedOnlineTaskAtom,
    (queued) => {
      hasQueuedOnlineTask = queued;
      if (!queued || !background || backgroundUntil <= Date.now()) return;
      // Home can be pressed before the shell receives the queued run's identity.
      queuedUntil = Date.now() + QUEUED_START_WINDOW_MS;
      syncWatch();
    },
    { immediate: true },
  );
  return () => {
    appState.remove();
    catalog();
    outbox();
    for (const release of environments.values()) release();
    finishCheck?.();
  };
}
