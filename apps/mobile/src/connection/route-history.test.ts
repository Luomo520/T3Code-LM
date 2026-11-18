import { EnvironmentId } from "@t3tools/contracts";
import { BearerConnectionProfile } from "@t3tools/client-runtime/connection";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "vite-plus/test";
import { profileWithRouteHistory, recordSuccessfulRoute } from "./route-history";

const route = new BearerConnectionProfile({
  connectionId: "lan",
  environmentId: EnvironmentId.make("pc"),
  label: "PC",
  httpBaseUrl: "http://192.168.1.10:3773/",
  wsBaseUrl: "ws://192.168.1.10:3773/",
});
const document = { ...EMPTY_CONNECTION_CATALOG_DOCUMENT, profiles: [route] };

describe("successful LAN route history", () => {
  it("records a hint without changing the profile or unrelated data", () => {
    const updated = recordSuccessfulRoute(document, route, 20);
    expect(updated.profiles[0]).toEqual(
      new BearerConnectionProfile({ ...route, lastConnectedAtEpochMs: 20 }),
    );
    expect(updated.targets).toBe(document.targets);
    expect(updated.credentials).toBe(document.credentials);
  });
  it("rejects an obsolete result after the address changes", () => {
    const moved = new BearerConnectionProfile({
      ...route,
      httpBaseUrl: "http://192.168.1.11:3773/",
    });
    expect(recordSuccessfulRoute({ ...document, profiles: [moved] }, route, 20).profiles[0]).toBe(
      moved,
    );
  });
  it("does not resurrect a removed profile", () => {
    expect(recordSuccessfulRoute({ ...document, profiles: [] }, route, 20).profiles).toEqual([]);
  });
  it("keeps newer timestamps and preserves new network metadata", () => {
    const latest = new BearerConnectionProfile({
      ...route,
      label: "renamed",
      network: "tailscale",
      lastConnectedAtEpochMs: 30,
    });
    const updated = recordSuccessfulRoute({ ...document, profiles: [latest] }, route, 20);
    expect(updated.profiles[0]).toEqual(latest);
  });
  it("retains hints across learned-route metadata refresh", () => {
    const previous = new BearerConnectionProfile({ ...route, lastConnectedAtEpochMs: 30 });
    const refreshed = new BearerConnectionProfile({ ...route, label: "new name" });
    expect(profileWithRouteHistory([previous], refreshed)).toEqual(
      new BearerConnectionProfile({ ...refreshed, lastConnectedAtEpochMs: 30 }),
    );
  });
  it("does not carry hints over to a different address", () => {
    const previous = new BearerConnectionProfile({ ...route, lastConnectedAtEpochMs: 30 });
    const changed = new BearerConnectionProfile({ ...route, wsBaseUrl: "ws://192.168.1.11:3773/" });
    expect(profileWithRouteHistory([previous], changed)).toBe(changed);
  });
  it("ignores invalid timestamps", () => {
    expect(recordSuccessfulRoute(document, route, NaN)).toBe(document);
    expect(recordSuccessfulRoute(document, route, -1)).toBe(document);
  });
});
