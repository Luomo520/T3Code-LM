import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { wantedOlderSettledPages } from "@t3tools/client-runtime/state/threads";
import {
  groupSidebarTasks,
  sidebarTaskActivityAt,
  sidebarTaskHistoryIsVisible,
  sidebarTaskProjectScope,
  sortSidebarTasks,
  visibleSidebarTaskGroup,
} from "./sidebarTaskView";

function task(id: string, at: string, projectId = "a", environmentId = "local") {
  return {
    id,
    environmentId,
    projectId,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: at,
    latestUserMessageAt: null,
    latestConversationMessageAt: at,
  };
}

describe("sidebar recent tasks", () => {
  it("uses completed assistant activity rather than only the last user send", () => {
    const thread = {
      ...task("one", "2026-10-31T10:01:00Z"),
      latestUserMessageAt: "2026-10-31T10:00:00Z",
      latestConversationMessageAt: "2026-10-31T10:02:00Z",
      latestRun: { requestedAt: null, startedAt: null, completedAt: "2026-10-31T10:02:00Z" },
    };
    expect(sidebarTaskActivityAt(thread)).toBe("2026-10-31T10:02:00Z");
  });

  it("ignores later metadata and run updates, including imported conversations without runs", () => {
    const old = {
      ...task("old", "2026-10-26T10:00:00Z"),
      updatedAt: "2026-11-01T10:00:00Z",
      latestRun: { requestedAt: null, startedAt: null, completedAt: "2026-11-01T10:00:00Z" },
    };
    const recent = { ...task("recent", "2026-10-31T10:00:00Z"), latestRun: null };
    expect(sortSidebarTasks([old, recent]).map((thread) => thread.id)).toEqual(["recent", "old"]);
  });

  it("uses legacy user time or creation when conversation time is missing", () => {
    const legacy = {
      ...task("legacy", "bad"),
      latestConversationMessageAt: undefined,
      latestUserMessageAt: "2026-10-25T10:00:00Z",
      updatedAt: "2026-11-01T10:00:00Z",
    };
    expect(sidebarTaskActivityAt(legacy)).toBe("2026-10-25T10:00:00Z");
    expect(sidebarTaskActivityAt({ ...legacy, latestUserMessageAt: null })).toBe(legacy.createdAt);
  });

  it("starts recent and project views across all projects despite a legacy status scope", () => {
    expect(sidebarTaskProjectScope("recent", "old-single-project", null, null)).toBeNull();
    expect(sidebarTaskProjectScope("project", "old-single-project", null, null)).toBeNull();
    expect(sidebarTaskProjectScope("status", "old-single-project", null, null)).toBe(
      "old-single-project",
    );
    expect(sidebarTaskProjectScope("project", "old", "recent-only", "explicit-project")).toBe(
      "explicit-project",
    );
    expect(sidebarTaskProjectScope("recent", "old", "recent-only", "explicit-project")).toBe(
      "recent-only",
    );
  });

  it("loads older recent tasks independently of a collapsed status shelf", () => {
    const environmentId = EnvironmentId.make("local");
    const before = "2026-11-01T00:00:00.000Z";
    const environments = new Map([
      [
        environmentId,
        {
          older: {
            before,
            beforeMs: Date.parse(before),
            counts: new Map([[ProjectId.make("a"), 60]]),
          },
          pages: {
            reads: [],
            status: "ready" as const,
            frontier: { settledAt: before, threadId: ThreadId.make("cut") },
          },
        },
      ],
    ]);
    const requested = new Map<EnvironmentId, number>();
    const wanted = (
      view: "recent" | "project" | "status",
      shelfExpanded: boolean,
      listedCount: number,
      visibleCount: number,
    ) =>
      wantedOlderSettledPages({
        requested,
        environments,
        listedCount,
        visibleCount: sidebarTaskHistoryIsVisible(view, shelfExpanded) ? visibleCount : 0,
      });
    // The default recent list has no shelf toggle; its first and subsequent pages must still load.
    expect(wanted("recent", false, 0, 10)).toEqual(new Map([[environmentId, 1]]));
    expect(wanted("recent", false, 10, 35)).toEqual(new Map([[environmentId, 1]]));
    expect(wanted("recent", false, 10, 10)).toBe(requested);
    expect(wanted("project", false, 0, 10)).toEqual(new Map([[environmentId, 1]]));
    expect(wanted("project", false, 10, 35)).toEqual(new Map([[environmentId, 1]]));
    for (const view of ["status"] as const) {
      expect(wanted(view, false, 0, 10)).toBe(requested);
      expect(wanted(view, true, 0, 10)).toEqual(new Map([[environmentId, 1]]));
    }
  });

  it("sorts globally across lifecycle and pin states without mutating the source", () => {
    const threads = [
      { ...task("old-pinned", "2026-10-31T10:00:00Z"), pinnedAt: "2026-10-31T09:00:00Z" },
      { ...task("new-settled", "2026-10-31T11:00:00Z"), settledOverride: "settled" },
    ];
    expect(sortSidebarTasks(threads).map((thread) => thread.id)).toEqual([
      "new-settled",
      "old-pinned",
    ]);
    expect(threads[0]!.id).toBe("old-pinned");
  });

  it("handles malformed optional times and breaks equal timestamps deterministically", () => {
    const threads = [task("b", "bad"), task("a", "bad")];
    expect(sortSidebarTasks(threads).map((thread) => thread.id)).toEqual(["a", "b"]);
  });

  it("orders project groups by their newest task and merges only explicit project scope members", () => {
    const threads = sortSidebarTasks([
      task("old-a", "2026-10-31T09:00:00Z"),
      task("new-b", "2026-10-31T11:00:00Z", "b"),
      task("new-a", "2026-10-31T10:00:00Z", "same", "remote"),
    ]);
    const groups = groupSidebarTasks(
      threads,
      new Map([
        ["local:a", "group-a"],
        ["remote:same", "group-a"],
      ]),
    );
    expect(groups.map((group) => [group.key, group.threads.map((thread) => thread.id)])).toEqual([
      ["local:b", ["new-b"]],
      ["group-a", ["new-a", "old-a"]],
    ]);
  });

  it("keeps equal project ids in different environments separate without a grouping declaration", () => {
    const threads = sortSidebarTasks([
      task("one", "2026-10-31T09:00:00Z"),
      task("two", "2026-10-31T10:00:00Z", "a", "remote"),
    ]);
    expect(groupSidebarTasks(threads, new Map()).map((group) => group.key)).toEqual([
      "remote:a",
      "local:a",
    ]);
  });

  it("preserves the active parent row in a collapsed group and hides other rows from keyboard order", () => {
    const threads = [task("one", "2026-10-31T09:00:00Z"), task("two", "2026-10-31T10:00:00Z")];
    expect(visibleSidebarTaskGroup(threads, true, "local:two").map((thread) => thread.id)).toEqual([
      "two",
    ]);
    expect(visibleSidebarTaskGroup(threads, true, null)).toEqual([]);
    expect(visibleSidebarTaskGroup(threads, false, "local:two")).toBe(threads);
  });
});
