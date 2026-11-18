import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { wantedOlderSettledPages } from "@t3tools/client-runtime/state/threads";
import {
  nextSidebarTaskHistoryCount,
  shouldKeepSidebarProjectFolder,
  sidebarTaskHistoryIsVisible,
  sidebarTaskHistoryVisibleCount,
} from "./sidebarTaskView";

describe("sidebar completeness", () => {
  it.each(["recent", "project", "status"] as const)(
    "extends %s history past the first 200 rows on the first click",
    (view) => {
      let requested = 10;
      expect(sidebarTaskHistoryVisibleCount(view, requested)).toBe(200);
      requested = nextSidebarTaskHistoryCount(view, requested);
      expect(sidebarTaskHistoryVisibleCount(view, requested)).toBe(225);
      requested = nextSidebarTaskHistoryCount(view, requested);
      expect(sidebarTaskHistoryVisibleCount(view, requested)).toBe(250);
    },
  );

  it("requests older backend pages when Show more advances past 200 rows", () => {
    const environmentId = EnvironmentId.make("local");
    const before = "2026-11-01T00:00:00.000Z";
    const requested = new Map([[environmentId, 2]]);
    const environments = new Map([
      [
        environmentId,
        {
          older: {
            before,
            beforeMs: Date.parse(before),
            counts: new Map([[ProjectId.make("project"), 300]]),
          },
          pages: {
            reads: [],
            status: "ready" as const,
            frontier: { settledAt: before, threadId: ThreadId.make("cut") },
          },
        },
      ],
    ]);
    expect(
      wantedOlderSettledPages({ requested, environments, listedCount: 200, visibleCount: 200 }),
    ).toBe(requested);
    const next = wantedOlderSettledPages({
      requested,
      environments,
      listedCount: 200,
      visibleCount: nextSidebarTaskHistoryCount("recent", 10),
    });
    expect(next.get(environmentId)).toBeGreaterThan(2);
  });

  it.each(["project", "status"] as const)("keeps unarchived empty projects in %s", (view) => {
    expect(
      shouldKeepSidebarProjectFolder({
        view,
        scopedProjectCount: 0,
        pinned: false,
        archived: false,
      }),
    ).toBe(true);
  });

  it.each(["recent", "project", "status"] as const)(
    "does not restore empty archived projects in %s",
    (view) => {
      for (const pinned of [false, true]) {
        expect(
          shouldKeepSidebarProjectFolder({ view, scopedProjectCount: 0, pinned, archived: true }),
        ).toBe(false);
      }
    },
  );

  it("loads project history without inheriting the collapsed Status shelf", () => {
    expect(sidebarTaskHistoryIsVisible("recent", false)).toBe(true);
    expect(sidebarTaskHistoryIsVisible("status", false)).toBe(false);
    expect(sidebarTaskHistoryIsVisible("status", true)).toBe(true);
    expect(sidebarTaskHistoryIsVisible("project", false)).toBe(true);
  });
});
