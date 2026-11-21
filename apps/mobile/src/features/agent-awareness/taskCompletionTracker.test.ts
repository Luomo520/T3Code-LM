import { EnvironmentId, RunId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { v2ThreadShell } from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { createTaskCompletionTracker } from "./taskCompletionTracker";

const environmentId = EnvironmentId.make("environment");
const runId = RunId.make("running");
const running: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  latestRunId: runId,
  activeRunId: runId,
  status: "running",
};
const complete: OrchestrationV2ThreadShell = {
  ...running,
  activeRunId: null,
  status: "completed",
};

it("reports the tracked run once when it completes in the background", () => {
  const onCompletion = vi.fn();
  const tracker = createTaskCompletionTracker({ background: false, onCompletion });
  tracker.observe(environmentId, [running]);
  tracker.setBackground(true);
  tracker.observe(environmentId, [complete]);
  tracker.setBackground(false);
  tracker.observe(environmentId, [complete]);

  expect(onCompletion).toHaveBeenCalledExactlyOnceWith({
    path: "/threads/environment/thread-v2",
    runId,
    title: "Thread",
    failed: false,
  });
  expect(tracker.watchedRuns()).toEqual([]);
});

it("recovers a missed completion from the first replay after returning to the app", () => {
  const onCompletion = vi.fn();
  const tracker = createTaskCompletionTracker({ background: false, onCompletion });
  tracker.observe(environmentId, [running]);
  tracker.setBackground(true);
  // The socket was disconnected while paused. No shell updates arrive until the replay.
  tracker.setBackground(false);
  tracker.observe(environmentId, [{ ...complete, status: "failed" }]);

  expect(onCompletion).toHaveBeenCalledExactlyOnceWith({
    path: "/threads/environment/thread-v2",
    runId,
    title: "Thread",
    failed: true,
  });
});

it("keeps historical results, foreground completions and interrupted runs quiet", () => {
  const onCompletion = vi.fn();
  const tracker = createTaskCompletionTracker({ background: false, onCompletion });
  tracker.observe(environmentId, [complete]);
  tracker.observe(environmentId, [running]);
  tracker.setBackground(true);
  tracker.setBackground(false);
  tracker.observe(environmentId, [running]);
  tracker.observe(environmentId, [complete]);
  tracker.observe(environmentId, [running]);
  tracker.setBackground(true);
  tracker.observe(environmentId, [{ ...complete, latestRunStopRequested: true }]);

  expect(onCompletion).not.toHaveBeenCalled();
  expect(tracker.watchedRuns()).toEqual([]);
});

it("restores watched identities after the app process restarts without alerting for history", () => {
  const onCompletion = vi.fn();
  const original = createTaskCompletionTracker({ background: false, onCompletion });
  original.observe(environmentId, [running]);
  expect(original.watchedRuns()).toEqual([]);
  original.setBackground(true);

  const restored = createTaskCompletionTracker({
    background: true,
    watchedRuns: original.watchedRuns(),
    onCompletion,
  });
  restored.observe(environmentId, [complete]);
  restored.observe(environmentId, [complete]);

  expect(onCompletion).toHaveBeenCalledExactlyOnceWith({
    path: "/threads/environment/thread-v2",
    runId,
    title: "Thread",
    failed: false,
  });
  expect(restored.watchedRuns()).toEqual([]);
});

it("drops restored watches when their environment is disabled", () => {
  const onCompletion = vi.fn();
  const tracker = createTaskCompletionTracker({
    background: true,
    watchedRuns: [{ environmentId, threadId: running.id, runId }],
    onCompletion,
  });
  tracker.retainEnvironments(new Set());
  tracker.observe(environmentId, [complete]);

  expect(onCompletion).not.toHaveBeenCalled();
  expect(tracker.watchedRuns()).toEqual([]);
});
