import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { canMaintainEnvironment, findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

describe("environment maintenance access", () => {
  it("requires a connected authenticated session with operate permission", () => {
    const session = {
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: [AuthOrchestrationOperateScope],
    };
    expect(canMaintainEnvironment(session, true)).toBe(true);
    expect(canMaintainEnvironment(session, false)).toBe(false);
    expect(canMaintainEnvironment({ ...session, authenticated: false }, true)).toBe(false);
    expect(canMaintainEnvironment({ ...session, scopes: [] }, true)).toBe(false);
    const { scopes: _, ...legacy } = session;
    expect(canMaintainEnvironment(legacy, true)).toBe(false);
    expect(canMaintainEnvironment(null, true)).toBe(false);
  });

  it.each([
    { permissions: ["environment:maintain"], expected: true },
    { permissions: ["providers:manage"], expected: false },
    { permissions: [], expected: false },
  ] as const)(
    "honors exact permissions over legacy scopes: $permissions",
    ({ permissions, expected }) => {
      expect(
        canMaintainEnvironment(
          {
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "session",
              serverUpdateScope: "environment:maintain",
            },
            scopes: ["orchestration:operate"],
            permissions,
          },
          true,
        ),
      ).toBe(expected);
    },
  );
});

describe("environment release checks", () => {
  const signal = new AbortController().signal;

  it("uses only the remote platform-aware lookup and compares fork builds", async () => {
    const lookup = vi.fn().mockResolvedValue({ version: "0.1.0-2" });
    expect(await findEnvironmentUpdate("0.1.0-1", signal, lookup)).toEqual({
      targetVersion: "0.1.0-2",
      manualCheckRequired: false,
    });
    expect(lookup).toHaveBeenCalledWith(signal);
    expect(await findEnvironmentUpdate("0.1.0-2", signal, lookup)).toEqual({
      targetVersion: null,
      manualCheckRequired: false,
    });
    expect(await findEnvironmentUpdate("0.1.0-3", signal, lookup)).toEqual({
      targetVersion: null,
      manualCheckRequired: false,
    });
    expect(await findEnvironmentUpdate("0.1.1-t3usage.25-nas.2", signal, lookup)).toEqual({
      targetVersion: "0.1.0-2",
      manualCheckRequired: false,
    });
  });

  it("never offers a generic or another platform's latest release to legacy hosts", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    expect(await findEnvironmentUpdate("0.1.0-1", signal)).toEqual({
      targetVersion: null,
      manualCheckRequired: true,
    });
    expect(
      await findEnvironmentUpdate("1.0.0-nightly.20260923.1", signal, async () => ({
        version: "1.1.0",
      })),
    ).toEqual({
      targetVersion: null,
      manualCheckRequired: true,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("preserves no-package and lookup failure states without claiming an update exists", async () => {
    expect(await findEnvironmentUpdate("0.1.0-1", signal, async () => null)).toEqual({
      targetVersion: null,
      manualCheckRequired: false,
    });
    await expect(
      findEnvironmentUpdate("0.1.0-1", signal, async () => {
        throw new Error("GitHub unavailable");
      }),
    ).rejects.toThrow("GitHub unavailable");
  });
});
