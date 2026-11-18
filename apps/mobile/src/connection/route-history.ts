import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  BearerConnectionProfile,
  type ConnectionProfile,
} from "@t3tools/client-runtime/connection";

function sameEndpoint(a: BearerConnectionProfile, b: BearerConnectionProfile): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.httpBaseUrl === b.httpBaseUrl &&
    a.wsBaseUrl === b.wsBaseUrl
  );
}

export function profileWithRouteHistory(
  profiles: ReadonlyArray<ConnectionProfile>,
  incoming: ConnectionProfile,
): ConnectionProfile {
  const previous = profiles.find((profile) => profile.connectionId === incoming.connectionId);
  if (
    incoming._tag !== "BearerConnectionProfile" ||
    previous?._tag !== "BearerConnectionProfile" ||
    !sameEndpoint(previous, incoming) ||
    previous.lastConnectedAtEpochMs === undefined
  )
    return incoming;
  return new BearerConnectionProfile({
    ...incoming,
    lastConnectedAtEpochMs: Math.max(
      previous.lastConnectedAtEpochMs,
      incoming.lastConnectedAtEpochMs ?? 0,
    ),
  });
}

export function recordSuccessfulRoute(
  document: ConnectionCatalogDocument,
  route: BearerConnectionProfile,
  connectedAtEpochMs: number,
): ConnectionCatalogDocument {
  if (!Number.isFinite(connectedAtEpochMs) || connectedAtEpochMs < 0) return document;
  return {
    ...document,
    profiles: document.profiles.map((current) =>
      current._tag === "BearerConnectionProfile" &&
      current.connectionId === route.connectionId &&
      sameEndpoint(current, route)
        ? new BearerConnectionProfile({
            ...current,
            lastConnectedAtEpochMs: Math.max(
              current.lastConnectedAtEpochMs ?? 0,
              connectedAtEpochMs,
            ),
          })
        : current,
    ),
  };
}
