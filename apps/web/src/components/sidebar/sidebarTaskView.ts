export type SidebarTaskView = "recent" | "project" | "status";

export function sidebarTaskHistoryIsVisible(
  view: SidebarTaskView,
  settledShelfExpanded: boolean,
): boolean {
  return view !== "status" || settledShelfExpanded;
}

export const SIDEBAR_HISTORY_INITIAL_COUNT = 10;
export const SIDEBAR_HISTORY_PAGE_COUNT = 25;

export function sidebarTaskHistoryVisibleCount(
  _view: SidebarTaskView,
  requestedCount: number,
): number {
  return Math.max(200, requestedCount);
}

export function nextSidebarTaskHistoryCount(view: SidebarTaskView, requestedCount: number): number {
  return sidebarTaskHistoryVisibleCount(view, requestedCount) + SIDEBAR_HISTORY_PAGE_COUNT;
}

/** Keep project folders visible when a task view is meant to represent the full project set. */
export function shouldKeepSidebarProjectFolder(input: {
  readonly view: SidebarTaskView;
  readonly scopedProjectCount: number;
  readonly pinned: boolean;
  readonly archived: boolean;
}): boolean {
  return (
    !input.archived &&
    (input.view === "project" ||
      input.view === "status" ||
      input.scopedProjectCount > 0 ||
      (input.pinned && !input.archived))
  );
}

export interface SidebarTaskActivity {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestUserMessageAt: string | null;
  readonly latestConversationMessageAt?: string | null | undefined;
  readonly latestRun?: {
    readonly requestedAt: string | null;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

export function sidebarTaskActivityAt(thread: SidebarTaskActivity): string {
  // Metadata and import times must not make an old conversation look recent.
  for (const candidate of [
    thread.latestConversationMessageAt,
    thread.latestUserMessageAt,
    thread.createdAt,
  ]) {
    if (candidate != null && Number.isFinite(Date.parse(candidate))) return candidate;
  }
  return thread.createdAt;
}

export function sortSidebarTasks<T extends SidebarTaskActivity>(threads: readonly T[]): T[] {
  return threads
    .map((thread) => {
      const activityAt = Date.parse(sidebarTaskActivityAt(thread));
      return {
        thread,
        activityAt: Number.isFinite(activityAt) ? activityAt : 0,
        key: `${thread.environmentId}:${thread.id}`,
      };
    })
    .sort((left, right) => right.activityAt - left.activityAt || left.key.localeCompare(right.key))
    .map(({ thread }) => thread);
}

export function groupSidebarTasks<T extends SidebarTaskActivity>(
  sortedThreads: readonly T[],
  projectGroupKeys: ReadonlyMap<string, string>,
): Array<{ key: string; threads: T[] }> {
  const groups = new Map<string, T[]>();
  for (const thread of sortedThreads) {
    const rawKey = `${thread.environmentId}:${thread.projectId}`;
    const key = projectGroupKeys.get(rawKey) ?? rawKey;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return Array.from(groups, ([key, threads]) => ({ key, threads }));
}

export function visibleSidebarTaskGroup<T extends SidebarTaskActivity>(
  threads: readonly T[],
  collapsed: boolean,
  routeKey: string | null,
): readonly T[] {
  return collapsed
    ? threads.filter((thread) => `${thread.environmentId}:${thread.id}` === routeKey)
    : threads;
}

export function sidebarTaskProjectScope(
  view: SidebarTaskView,
  statusScope: string | null,
  recentScope: string | null,
  projectScope: string | null,
): string | null {
  return view === "status" ? statusScope : view === "recent" ? recentScope : projectScope;
}
