import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { headerUsageViewRefreshGate } from "./headerUsageRefresh";

const noConfig = Atom.make(null);

export function useHeaderUsageQuery(props: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId?: string;
  readonly providerInstanceId?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const config = useAtomValue(
    props.environmentId ? serverEnvironment.configValueAtom(props.environmentId) : noConfig,
  );
  const supported = config?.environment.capabilities.headerUsage === true;
  const query = useEnvironmentQuery(
    props.environmentId && supported
      ? serverEnvironment.headerUsage({
          environmentId: props.environmentId,
          input: {
            ...(props.threadId ? { threadId: props.threadId } : {}),
            ...(props.providerInstanceId ? { providerInstanceId: props.providerInstanceId } : {}),
          },
        })
      : null,
  );
  const canRefresh = useAtomValue(
    serverEnvironment.refreshHeaderUsage.permissionAtom(props.environmentId),
  );
  const request = useAtomCommand(serverEnvironment.refreshHeaderUsage, {
    reportFailure: false,
    reportDefect: false,
  });
  const resolvedInstanceId = props.providerInstanceId ?? query.data?.providerInstanceId;
  const refreshCached = query.refresh;
  async function refresh() {
    if (!props.environmentId || !supported || document.visibilityState === "hidden") return;
    refreshCached();
    if (!canRefresh) return;
    const identity = JSON.stringify([props.environmentId, resolvedInstanceId ?? "auto"]);
    if (!headerUsageViewRefreshGate.take(identity, Date.now())) return;
    await request({
      environmentId: props.environmentId,
      input: {
        refresh: true,
        ...(props.threadId ? { threadId: props.threadId } : {}),
        ...(resolvedInstanceId ? { providerInstanceId: resolvedInstanceId } : {}),
      },
    });
    refreshCached();
  }
  const onResume = useEffectEvent(() => {
    void refresh();
  });
  const onPoll = useEffectEvent(() => {
    if (document.visibilityState !== "hidden") {
      setNow(Date.now());
      refreshCached();
    }
  });
  useEffect(() => {
    if (!props.environmentId || !supported) return;
    onResume();
    const timer = setInterval(onPoll, 2000);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("focus", onResume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("focus", onResume);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new thread or account is a page entry even though the event reads the latest target.
  }, [props.environmentId, props.threadId, props.providerInstanceId, supported]);
  return { ...query, config, supported, resolvedInstanceId, refresh, now };
}
