import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeProjectScopes,
  buildHomeThreadList,
  findHomeProjectScope,
  selectHomeCatalog,
} from "./homeThreadList";
import { arrangeHomeList, homeConversationTimestamp, type HomeListView } from "./homeListView";
import { makeThreadShellFixture } from "../../test-fixtures";
import { buildThreadListV2Items } from "../threads/threadListV2";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return makeThreadShellFixture({
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  });
}

describe("home project scopes", () => {
  it("includes unarchived history and places pins above both time and project lists", () => {
    const environmentId = EnvironmentId.make("local");
    const projects = ["one", "two"].map((id) =>
      makeProject({ environmentId, id: ProjectId.make(id), title: id }),
    );
    const threads = Array.from({ length: 16 }, (_, index) =>
      makeThread({
        environmentId,
        projectId: projects[index % 2]!.id,
        id: ThreadId.make(`thread-${index}`),
        title: `${index}`,
        latestUserMessageAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        latestConversationMessageAt: index === 4 ? "2026-06-21T00:00:00.000Z" : null,
        updatedAt:
          index === 13
            ? "2026-07-21T00:00:00.000Z"
            : `2026-07-${String(20 - index).padStart(2, "0")}T00:00:00.000Z`,
        settledOverride: index < 13 ? "settled" : "active",
        pinnedAt: index === 4 || index === 13 ? "2026-06-01T00:00:00.000Z" : null,
        snoozedUntil: index === 14 ? "2026-08-01T00:00:00.000Z" : null,
      }),
    );
    const layout = buildHomeThreadList({
      threads,
      environmentId: null,
      searchQuery: "",
      now: "2026-07-01T00:00:00.000Z",
      pinnedBeforeSettled: true,
      settledLimit: 1,
      settledShelfExpanded: false,
      snoozedShelfExpanded: false,
    });
    expect(layout.items).toHaveLength(16);
    expect(layout.hiddenSettledCount).toBe(0);
    const rows = layout.items.map(({ thread, pinned }) => ({ key: thread.id, thread, pinned }));
    const describe = (row: (typeof rows)[number]) => ({
      projectKey: row.thread.projectId,
      title: row.thread.projectId,
      timestamp: homeConversationTimestamp(row.thread),
      pinned: row.pinned,
    });
    const expectThread = (thread: EnvironmentThreadShell) => ({
      key: thread.id,
      thread: { projectId: thread.projectId },
      pinned: thread.pinnedAt !== null,
    });
    const pinned = [expectThread(threads[4]!), expectThread(threads[13]!)];
    const unpinned = threads.toReversed().filter((thread) => thread.pinnedAt === null);
    expect(arrangeHomeList({ rows, describe, mode: "time", collapsed: new Set() })).toMatchObject([
      ...pinned,
      ...unpinned.map(expectThread),
    ]);
    expect(
      arrangeHomeList({ rows, describe, mode: "projects", collapsed: new Set() }),
    ).toMatchObject([
      ...pinned,
      ...[projects[1]!, projects[0]!].flatMap(({ id }) => [
        { type: "home-project", projectKey: id, count: 7, expanded: true },
        ...unpinned.filter((thread) => thread.projectId === id).map(expectThread),
      ]),
    ]);
    const search = buildHomeThreadList({
      threads,
      environmentId: null,
      searchQuery: "15",
      now: "2026-07-01T00:00:00.000Z",
    });
    expect(search.items.map((item) => item.thread.id)).toEqual([threads[15]!.id]);
  });
  it("sorts scoped pins by conversation time as history loads and new replies arrive", () => {
    const environmentId = EnvironmentId.make("local");
    const projectId = ProjectId.make("scoped");
    const now = "2026-07-01T00:00:00.000Z";
    const thread = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
      makeThread({ environmentId, projectId, id: ThreadId.make(id), title: id, ...overrides });
    const olderPin = thread("older-pin", {
      pinnedAt: "2026-06-30T00:00:00.000Z",
      pinOrderKey: "a",
      settledOverride: "settled",
      settledAt: "2026-06-01T00:00:00.000Z",
      latestUserMessageAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
    });
    const newerPin = thread("newer-pin", {
      pinnedAt: "2026-06-02T00:00:00.000Z",
      pinOrderKey: "b",
      latestUserMessageAt: "2026-06-02T00:00:00.000Z",
    });
    const active = thread("active", { latestUserMessageAt: "2026-06-05T00:00:00.000Z" });
    const newSettled = thread("new-settled", {
      settledOverride: "settled",
      settledAt: "2026-06-07T00:00:00.000Z",
      latestUserMessageAt: "2026-06-06T00:00:00.000Z",
    });
    const olderSettled = thread("older-settled", {
      settledOverride: "settled",
      settledAt: "2026-06-04T00:00:00.000Z",
      latestUserMessageAt: "2026-06-03T00:00:00.000Z",
    });
    const other = thread("other", {
      projectId: ProjectId.make("other"),
      pinnedAt: now,
      pinOrderKey: "0",
      latestConversationMessageAt: "2026-06-29T00:00:00.000Z",
    });
    const snoozedPin = thread("snoozed", {
      pinnedAt: now,
      pinOrderKey: "0",
      snoozedUntil: "2099-01-01T00:00:00.000Z",
    });
    const displayedKeys = (
      rows: readonly EnvironmentThreadShell[],
      settledLimit: number,
      mode: HomeListView,
    ) => {
      const layout = buildThreadListV2Items({
        threads: rows,
        projectRefs: [{ environmentId, projectId }],
        environmentId,
        searchQuery: "",
        pinnedBeforeSettled: true,
        now,
        settledLimit,
        settledShelfExpanded: true,
        snoozedShelfExpanded: false,
      });
      return arrangeHomeList({
        rows: layout.items.map((item) => ({ ...item, key: item.thread.id })),
        mode,
        collapsed: new Set(),
        describe: ({ thread, pinned }) => ({
          projectKey: thread.projectId,
          title: thread.projectId,
          timestamp: homeConversationTimestamp(thread),
          pinned,
        }),
      }).map((row) => row.key);
    };
    const threads = [newerPin, newSettled, other, active, olderPin, olderSettled, snoozedPin];
    const afterReply = threads.map((row) =>
      row === olderPin ? { ...row, latestConversationMessageAt: "2026-06-08T00:00:00.000Z" } : row,
    );
    const afterUnpin = threads.map((row) =>
      row === olderPin ? { ...row, pinnedAt: null, pinOrderKey: null } : row,
    );
    for (const mode of ["time", "projects"] as const) {
      const heading = mode === "projects" ? ["home-project:0:scoped"] : [];
      const activePage = [...heading, "new-settled", "active"];
      const moreHistory = [...activePage, "older-settled"];
      expect(displayedKeys(threads, 1, mode)).toEqual(["newer-pin", "older-pin", ...activePage]);
      expect(displayedKeys(threads, 2, mode)).toEqual(["newer-pin", "older-pin", ...moreHistory]);
      expect(displayedKeys(afterReply, 2, mode)).toEqual([
        "older-pin",
        "newer-pin",
        ...moreHistory,
      ]);
      expect(displayedKeys(afterUnpin, 3, mode)).toEqual([
        "newer-pin",
        ...moreHistory,
        "older-pin",
      ]);
    }
  });

  it("derives the catalog from existing unarchived conversations and keeps environments separate", () => {
    const local = EnvironmentId.make("local");
    const remote = EnvironmentId.make("remote");
    const activeProject = makeProject({
      environmentId: local,
      id: ProjectId.make("active"),
      title: "active",
    });
    const archivedProject = makeProject({
      environmentId: local,
      id: ProjectId.make("archived"),
      title: "archived",
    });
    const remoteProject = makeProject({
      environmentId: remote,
      id: activeProject.id,
      title: "remote",
    });
    const active = makeThread({
      environmentId: local,
      projectId: activeProject.id,
      id: ThreadId.make("active"),
      title: "active",
    });
    const archived = makeThread({
      environmentId: local,
      projectId: archivedProject.id,
      id: ThreadId.make("archived"),
      title: "archived",
      archivedAt: "2026-06-02T00:00:00.000Z",
    });
    const deleted = makeThread({
      environmentId: local,
      projectId: activeProject.id,
      id: ThreadId.make("deleted"),
      title: "deleted",
      deletedAt: "2026-06-02T00:00:00.000Z",
    });
    const orphan = makeThread({
      environmentId: local,
      projectId: ProjectId.make("removed"),
      id: ThreadId.make("orphan"),
      title: "orphan",
    });
    const subagent = makeThread({
      environmentId: remote,
      projectId: remoteProject.id,
      id: ThreadId.make("child"),
      title: "child",
      lineage: { ...active.lineage, relationshipToParent: "subagent" },
    });
    const result = selectHomeCatalog({
      projects: [activeProject, archivedProject, remoteProject],
      threads: [archived, deleted, orphan, subagent, active],
    });
    expect(result.projects).toEqual([activeProject]);
    expect(result.threads).toEqual([active]);
    expect(
      selectHomeCatalog({
        projects: [activeProject],
        threads: [{ ...active, archivedAt: "2026-06-03T00:00:00.000Z" }],
      }),
    ).toEqual({ projects: [], threads: [] });
    expect(selectHomeCatalog({ projects: [activeProject], threads: [active] })).toEqual({
      projects: [activeProject],
      threads: [active],
    });
  });
  it("filters threads across both scratch hosts while retaining the selected environment boundary", () => {
    const localEnvironmentId = EnvironmentId.make("local");
    const remoteEnvironmentId = EnvironmentId.make("remote");
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("scratch-local"),
        title: "No project",
        workspaceRoot: "/local/scratch",
        isScratch: true,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("scratch-remote"),
        title: "No project",
        workspaceRoot: "/remote/scratch",
        isScratch: true,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("ordinary"),
        title: "No project",
      }),
    ];
    const threads = projects.map((project) =>
      makeThread({
        environmentId: project.environmentId,
        projectId: project.id,
        id: ThreadId.make(`thread-${project.id}`),
        title: project.id,
      }),
    );
    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "separate",
    });
    expect(scopes).toHaveLength(2);
    const scratchScope = scopes.find((scope) => scope.representative.isScratch)!;
    const filtered = buildThreadListV2Items({
      threads,
      environmentId: null,
      projectRefs: scratchScope.projectRefs,
      searchQuery: "",
      now: "2026-06-01T00:00:00.000Z",
    });
    expect(filtered.items.map((item) => item.thread.id).sort()).toEqual(
      threads
        .slice(0, 2)
        .map((thread) => thread.id)
        .sort(),
    );
    const remoteScopes = buildHomeProjectScopes({
      projects,
      environmentId: remoteEnvironmentId,
      projectGroupingMode: "separate",
    });
    const remoteScratch = remoteScopes.find((scope) => scope.representative.isScratch)!;
    expect(remoteScratch.key).toBe(scratchScope.key);
    expect(remoteScratch.projectRefs).toEqual([
      { environmentId: remoteEnvironmentId, projectId: projects[1]!.id },
    ]);
    expect(
      buildThreadListV2Items({
        threads,
        environmentId: remoteEnvironmentId,
        projectRefs: remoteScratch.projectRefs,
        searchQuery: "",
        now: "2026-06-01T00:00:00.000Z",
      }).items.map((item) => item.thread.id),
    ).toEqual([threads[1]!.id]);
  });

  it("keeps repository identity from an older duplicate when the freshness winner lacks it", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/t3code.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "t3code",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-with-identity"),
        title: "t3code",
        workspaceRoot: "/remote/t3code",
        repositoryIdentity,
        updatedAt: "2026-06-01T00:00:00.000Z",
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote-fresh"),
        title: "t3code",
        workspaceRoot: "/remote/t3code/",
        updatedAt: "2026-06-02T00:00:00.000Z",
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.representative.id).toBe(ProjectId.make("project-local"));
    expect(scopes[0]?.projects.map((project) => project.id)).toContain(
      ProjectId.make("project-remote-fresh"),
    );
    expect(scopes[0]?.projectRefs).toHaveLength(3);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        environmentId: null,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });

  it("prefers an exact scope key over a project ID that collides with it", () => {
    const environmentId = EnvironmentId.make("environment-local");
    const collidingProject = makeProject({
      environmentId,
      id: ProjectId.make("/workspaces/target"),
      title: "Colliding",
      workspaceRoot: "/workspaces/colliding",
    });
    const targetProject = makeProject({
      environmentId,
      id: ProjectId.make("project-target"),
      title: "Target",
      workspaceRoot: "/workspaces/target",
    });
    const scopes = buildHomeProjectScopes({
      projects: [collidingProject, targetProject],
      environmentId: null,
      projectGroupingMode: "separate",
    });
    const targetScope = scopes.find((scope) => scope.title === "Target");
    expect(scopes.map((scope) => scope.title)).toEqual(["Colliding", "Target"]);
    expect(targetScope?.key).toBe("environment-local:/workspaces/target");

    expect(findHomeProjectScope(scopes, "environment-local:/workspaces/target")).toBe(targetScope);
    expect(findHomeProjectScope(scopes, "environment-local:project-target")).toBe(targetScope);
    expect(findHomeProjectScope(scopes, "environment-local:missing")).toBeNull();
    expect(findHomeProjectScope(scopes, null)).toBeNull();
  });
});
