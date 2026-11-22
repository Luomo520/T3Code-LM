import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useWorktreeSetup } from "./useWorktreeSetup";

function SetupStatus({ route }: { readonly route: ScopedThreadRef }) {
  // oxlint-disable-next-line t3code/no-manual-memo -- 回归测试刻意让每次渲染重新创建会话引用。
  "use no memo";
  const setup = useWorktreeSetup({
    routeThreadRef: { ...route },
    ownerKey: `${route.environmentId}:${route.threadId}`,
    activeThread: undefined,
    threadRef: null,
    serverProjection: null,
    activityRun: null,
    localPreparing: false,
    sendQueuesBehindSetup: false,
    followUpSent: false,
  });
  return <output>{setup.isPreparingWorktree ? "Preparing" : route.threadId}</output>;
}

it("settles the route change even when the scoped reference is recreated each render", async () => {
  const environmentId = EnvironmentId.make("test-environment");
  await using screen = await render(
    <SetupStatus route={{ environmentId, threadId: ThreadId.make("first-thread") }} />,
  );
  await screen.rerender(
    <SetupStatus route={{ environmentId, threadId: ThreadId.make("second-thread") }} />,
  );
  await expect.element(screen.getByRole("status")).toHaveTextContent("second-thread");
});
