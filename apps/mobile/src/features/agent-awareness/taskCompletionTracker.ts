import {
  isListedThreadLineage,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

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
  readonly onCompletion: (completion: TaskCompletion) => void;
}) {
  let background = input.background;
  const byEnvironment = new Map<EnvironmentId, Map<ThreadId, ActiveRun>>();
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

    removeEnvironment(environmentId: EnvironmentId) {
      byEnvironment.delete(environmentId);
    },

    hasActiveRuns() {
      return byEnvironment.size > 0;
    },
  };
}
