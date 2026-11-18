import { useEffect, useState } from "react";
import { runtime } from "../../lib/runtime";
import { MobileDatabase } from "../../persistence/mobile-database";
import {
  createHeaderUsageHistoryStore,
  type HeaderUsageHistoryRequest,
  type HeaderUsageHistoryTarget,
} from "./headerUsageHistoryStore";
import {
  emptyHeaderUsageHistory,
  mergeHeaderUsageHistory,
  presentHeaderUsageHistory,
  resolveHeaderUsageHistoryProvider,
  type HeaderUsageHistory,
  type HistoryUsageSummary,
} from "./headerUsageHistory";

let historyStore: Promise<ReturnType<typeof createHeaderUsageHistoryStore>> | undefined;
function store() {
  return (historyStore ??= runtime.runPromise(MobileDatabase).then(createHeaderUsageHistoryStore));
}

interface ViewHistory {
  readonly identity: string | null;
  readonly initial: HistoryUsageSummary | null;
  readonly synchronized: boolean;
  readonly history: HeaderUsageHistory;
}

export function useHeaderUsageHistory(
  request: HeaderUsageHistoryRequest | null,
  incoming: HistoryUsageSummary | null,
  successful: boolean,
  error: string | null,
  providerLabel: string,
) {
  const requestIdentity = request
    ? JSON.stringify([
        request.environmentId,
        request.providerInstanceId ?? "auto",
        request.home ? "home" : "thread",
        request.home ? null : request.threadId,
      ])
    : null;
  const [mapping, setMapping] = useState<{
    readonly identity: string | null;
    readonly providerId: string | null;
  } | null>(null);
  const providerInstanceId = resolveHeaderUsageHistoryProvider(
    undefined,
    request?.providerInstanceId,
    incoming?.providerInstanceId ??
      (mapping?.identity === requestIdentity ? mapping.providerId : null),
  );
  const target: HeaderUsageHistoryTarget | null =
    request && providerInstanceId ? { ...request, providerInstanceId } : null;
  useEffect(() => {
    if (!request || request.providerInstanceId) return;
    let active = true;
    void store()
      .then((storage) => storage.resolveProvider(request))
      .then((providerId) => {
        if (active) setMapping({ identity: requestIdentity, providerId });
      })
      .catch(() => console.warn("[header-usage] provider history unavailable"));
    return () => {
      active = false;
    };
  }, [requestIdentity]);
  useEffect(() => {
    if (request && !request.providerInstanceId && incoming?.providerInstanceId)
      setMapping({ identity: requestIdentity, providerId: incoming.providerInstanceId });
  }, [requestIdentity, incoming]);
  const identity = target
    ? JSON.stringify([
        target.environmentId,
        target.providerInstanceId,
        target.home ? "home" : "thread",
        target.home ? null : target.threadId,
      ])
    : null;
  const [state, setState] = useState<ViewHistory>(() => ({
    identity,
    initial: incoming,
    synchronized: false,
    history: emptyHeaderUsageHistory(),
  }));
  const current =
    state.identity === identity
      ? state
      : {
          identity,
          initial: incoming,
          synchronized: false,
          history: emptyHeaderUsageHistory(),
        };
  useEffect(() => {
    let active = true;
    setState((previous) =>
      previous.identity === identity
        ? previous
        : {
            identity,
            initial: incoming,
            synchronized: false,
            history: emptyHeaderUsageHistory(),
          },
    );
    if (target)
      void store()
        .then((storage) => storage.load(target))
        .then((history) => {
          if (active)
            setState((previous) =>
              previous.identity === identity ? { ...previous, history } : previous,
            );
        })
        .catch(() => console.warn("[header-usage] history load unavailable"));
    return () => {
      active = false;
    };
    // The identity includes every target field; response updates must not reload SQLite.
  }, [identity]);
  useEffect(() => {
    if (!target || !incoming || incoming.providerInstanceId !== target.providerInstanceId) return;
    let active = true;
    setState((previous) =>
      previous.identity === identity
        ? {
            ...previous,
            history: mergeHeaderUsageHistory(previous.history, incoming, target.home),
            synchronized: previous.synchronized || (successful && incoming !== previous.initial),
          }
        : previous,
    );
    void store()
      .then((storage) => storage.save(target, incoming, !request?.providerInstanceId))
      .then((history) => {
        if (active)
          setState((previous) =>
            previous.identity === identity ? { ...previous, history } : previous,
          );
      })
      .catch(() => console.warn("[header-usage] history save unavailable"));
    return () => {
      active = false;
    };
    // Target contents are represented by identity, not the caller's object allocation.
  }, [identity, incoming, successful]);
  if (!target) return { data: null, historicalFields: {} };
  // A new sourceId invalidates the previous account on this render, before disk I/O.
  const history = mergeHeaderUsageHistory(
    current.history,
    incoming?.providerInstanceId === target.providerInstanceId ? incoming : null,
    target.home,
  );
  return presentHeaderUsageHistory(
    history,
    current.synchronized ? incoming : null,
    target.providerInstanceId,
    providerLabel,
    target.home,
    error,
  );
}
