import {
  isListedThreadLineage,
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Schema from "effect/Schema";

export const TaskCompletionWatch = Schema.Struct({
  backgroundUntil: Schema.Finite,
  queuedUntil: Schema.Finite,
  runs: Schema.Array(
    Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId, runId: RunId }),
  ),
});

interface TaskCompletion {
  readonly path: string;
  readonly runId: RunId;
  readonly title: string;
  readonly failed: boolean;
}

interface ActiveRun {
  readonly runId: RunId;
  backgrounded: boolean;
}

export function createTaskCompletionTracker(input: {
  readonly background: boolean;
  readonly watchedRuns?: typeof TaskCompletionWatch.Type.runs;
  readonly onCompletion: (completion: TaskCompletion) => void;
}) {
  let background = input.background;
  const byEnvironment = new Map<EnvironmentId, Map<ThreadId, ActiveRun>>();
  for (const { environmentId, threadId, runId } of input.watchedRuns ?? []) {
    const runs = byEnvironment.get(environmentId) ?? new Map<ThreadId, ActiveRun>();
    runs.set(threadId, { runId, backgrounded: true });
    byEnvironment.set(environmentId, runs);
  }

  return {
    setBackground(next: boolean) {
      if (background === next) return;
      background = next;
      if (!background) return;
      for (const runs of byEnvironment.values()) {
        for (const run of runs.values()) run.backgrounded = true;
      }
    },

    observe(environmentId: EnvironmentId, threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
      const previous = byEnvironment.get(environmentId);
      const active = new Map<ThreadId, ActiveRun>();
      for (const thread of threads) {
        if (
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          !isListedThreadLineage(thread.lineage) ||
          thread.latestRunId === null
        ) {
          continue;
        }
        const awareness = projectThreadAwarenessV2({
          environmentId,
          project: { title: "" },
          thread,
        });
        const phase = awareness?.phase;
        if (awareness !== null && (phase === "completed" || phase === "failed")) {
          const run = previous?.get(thread.id);
          if (run?.runId === thread.latestRunId && run.backgrounded) {
            input.onCompletion({
              path: awareness.deepLink,
              runId: run.runId,
              title: awareness.threadTitle,
              failed: phase === "failed",
            });
          }
        } else if (phase !== undefined || thread.status === "queued") {
          active.set(thread.id, {
            runId: thread.activeRunId ?? thread.latestRunId,
            // A fresh replay still showing this run as active clears past background exposure.
            backgrounded: background,
          });
        }
      }
      if (active.size === 0) byEnvironment.delete(environmentId);
      else byEnvironment.set(environmentId, active);
    },

    retainEnvironments(enabled: ReadonlySet<EnvironmentId>) {
      for (const environmentId of byEnvironment.keys()) {
        if (!enabled.has(environmentId)) byEnvironment.delete(environmentId);
      }
    },

    watchedRuns() {
      const watched: Array<(typeof TaskCompletionWatch.Type.runs)[number]> = [];
      for (const [environmentId, runs] of byEnvironment) {
        for (const [threadId, run] of runs) {
          if (run.backgrounded) watched.push({ environmentId, threadId, runId: run.runId });
        }
      }
      return watched;
    },
  };
}
