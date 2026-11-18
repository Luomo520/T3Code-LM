import { describe, expect, it } from "vite-plus/test";
import { arrangeHomeList, homeConversationTimestamp } from "./homeListView";

describe("home time and project views", () => {
  const rows = [
    { key: "a", project: "one", time: 1 },
    { key: "b", project: "two", time: 4 },
    { key: "c", project: "one", time: 3 },
  ];
  const describe = (row: (typeof rows)[number]) => ({
    projectKey: row.project,
    title: row.project,
    timestamp: row.time,
    pinned: false,
  });
  it("orders globally by activity", () => {
    expect(
      arrangeHomeList({ rows, describe, mode: "time", collapsed: new Set() }).map((r) => r.key),
    ).toEqual(["b", "c", "a"]);
  });
  it("groups by project and keeps each group newest first", () => {
    const result = arrangeHomeList({ rows, describe, mode: "projects", collapsed: new Set() });
    expect(result.map((r) => r.key)).toEqual([
      "home-project:0:two",
      "b",
      "home-project:0:one",
      "c",
      "a",
    ]);
  });
  it("collapses a project without removing its heading", () => {
    expect(
      arrangeHomeList({ rows, describe, mode: "projects", collapsed: new Set(["one"]) }).map(
        (r) => r.key,
      ),
    ).toEqual(["home-project:0:two", "b", "home-project:0:one"]);
  });
  it("orders across former lifecycle boundaries without giving pinned rows priority", () => {
    const items = [
      ...rows,
      { key: "settled", project: "", time: 0 },
      { key: "old", project: "one", time: 9 },
    ];
    expect(
      arrangeHomeList({
        rows: items,
        describe: (r) => (r.key === "settled" ? null : { ...describe(r), pinned: r.key === "a" }),
        mode: "time",
        collapsed: new Set(),
      }).map((r) => r.key),
    ).toEqual(["settled", "old", "b", "c", "a"]);
  });
  it("uses conversation time rather than metadata or run time and tolerates old backends", () => {
    expect(
      homeConversationTimestamp({
        latestConversationMessageAt: "2026-10-20T00:00:00Z",
        latestUserMessageAt: "2026-10-19T00:00:00Z",
        createdAt: "2026-10-30T00:00:00Z",
      }),
    ).toBe(Date.parse("2026-10-20T00:00:00Z"));
    expect(
      homeConversationTimestamp({
        latestUserMessageAt: "2026-10-19T00:00:00Z",
        createdAt: "2026-10-30T00:00:00Z",
      }),
    ).toBe(Date.parse("2026-10-19T00:00:00Z"));
    expect(
      homeConversationTimestamp({
        latestConversationMessageAt: null,
        latestUserMessageAt: null,
        createdAt: "2026-10-30T00:00:00Z",
      }),
    ).toBe(Date.parse("2026-10-30T00:00:00Z"));
    expect(
      homeConversationTimestamp({
        latestConversationMessageAt: "invalid",
        latestUserMessageAt: null,
        createdAt: "invalid",
      }),
    ).toBe(Number.NEGATIVE_INFINITY);
  });
  it("renders both views when the engine has no Array.toSorted without mutating input", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
    let timeKeys: string[] = [];
    let projectKeys: string[] = [];
    try {
      Object.defineProperty(Array.prototype, "toSorted", { value: undefined, configurable: true });
      timeKeys = arrangeHomeList({ rows, describe, mode: "time", collapsed: new Set() }).map(
        (r) => r.key,
      );
      projectKeys = arrangeHomeList({ rows, describe, mode: "projects", collapsed: new Set() }).map(
        (r) => r.key,
      );
    } finally {
      if (descriptor) Object.defineProperty(Array.prototype, "toSorted", descriptor);
      else Reflect.deleteProperty(Array.prototype, "toSorted");
    }
    expect(timeKeys).toEqual(["b", "c", "a"]);
    expect(projectKeys).toEqual(["home-project:0:two", "b", "home-project:0:one", "c", "a"]);
    expect(rows.map((row) => row.key)).toEqual(["a", "b", "c"]);
  });
});
