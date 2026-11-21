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
  expect(tracker.hasActiveRuns()).toBe(true);
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
  expect(tracker.hasActiveRuns()).toBe(false);
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
  expect(tracker.hasActiveRuns()).toBe(false);
});
