import { useIsFocused } from "@react-navigation/native";
import { scheduleConversationUsageRefresh } from "@t3tools/client-runtime/state/usage";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export function useConversationUsage(
  threadRef: ScopedThreadRef | null,
  latestRunId: RunId | null,
  active: boolean,
) {
  const focused = useIsFocused();
  const environmentId = threadRef?.environmentId;
  const threadId = threadRef?.threadId;
  const enabled = threadRef !== null && focused;
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : serverEnvironment.headerUsage({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, includeSessionUsage: true },
        }),
  );
  const refresh = useEffectEvent(() => {
    if (enabled && AppState.currentState === "active" && !query.isPending) query.refresh();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the scoped server query while the conversation is visible
  useEffect(() => {
    if (!focused || !environmentId || !threadId) return;
    refresh();
    const stop =
      latestRunId !== null || active ? scheduleConversationUsageRefresh(refresh, active) : null;
    const subscription = AppState.addEventListener("change", refresh);
    return () => {
      stop?.();
      subscription.remove();
    };
  }, [focused, environmentId, threadId, latestRunId, active]);

  const refreshingAt = query.data?.localRefreshing ? query.data.readAt : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- checks for the scan result after the server reported that its cache was refreshing
  useEffect(() => {
    if (!enabled || refreshingAt === null || query.isPending) return;
    const retry = setTimeout(refresh, 1000);
    return () => clearTimeout(retry);
  }, [enabled, refreshingAt, query.isPending]);

  return query.data?.sessionUsage ?? null;
}
