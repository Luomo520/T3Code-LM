import { scheduleConversationUsageRefresh } from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useConversationUsage(
  threadRef: ScopedThreadRef | null,
  latestRunId: RunId | null,
  active: boolean,
) {
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : serverEnvironment.headerUsage({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, includeSessionUsage: true },
        }),
  );
  const refresh = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !query.isPending) query.refresh();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the selected thread's refresh timers and browser visibility listeners
  useEffect(() => {
    if (!environmentId || !threadId) return;
    refresh();
    const stop =
      latestRunId !== null || active ? scheduleConversationUsageRefresh(refresh, active) : null;
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      stop?.();
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [environmentId, threadId, latestRunId, active]);

  const refreshingAt = query.data?.localRefreshing ? query.data.readAt : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- waits for a new result after a response says the server scan is pending
  useEffect(() => {
    if (refreshingAt === null || query.isPending) return;
    const retry = setTimeout(refresh, 1000);
    return () => clearTimeout(retry);
  }, [refreshingAt, query.isPending]);

  return query.data?.sessionUsage ?? null;
}
