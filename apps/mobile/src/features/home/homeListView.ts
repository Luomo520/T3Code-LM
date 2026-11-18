export type HomeListView = "time" | "projects";
export interface ProjectHeading {
  readonly type: "home-project";
  readonly key: string;
  readonly projectKey: string;
  readonly title: string;
  readonly count: number;
  readonly expanded: boolean;
}

export function homeConversationTimestamp(thread: {
  readonly latestConversationMessageAt?: string | null;
  readonly latestUserMessageAt: string | null;
  readonly createdAt: string;
}): number {
  for (const at of [
    thread.latestConversationMessageAt,
    thread.latestUserMessageAt,
    thread.createdAt,
  ]) {
    const timestamp = Date.parse(at ?? "");
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

export function arrangeHomeList<T extends { readonly key: string }>(input: {
  readonly rows: ReadonlyArray<T>;
  readonly mode: HomeListView;
  readonly collapsed: ReadonlySet<string>;
  readonly describe: (
    row: T,
  ) => { projectKey: string; title: string; timestamp: number; pinned: boolean } | null;
}): Array<T | ProjectHeading> {
  const result: Array<T | ProjectHeading> = [];
  const conversations: Array<{ row: T; info: NonNullable<ReturnType<typeof input.describe>> }> = [];
  for (const row of input.rows) {
    const info = input.describe(row);
    if (info) conversations.push({ row, info });
    else result.push(row);
  }
  const sorted = conversations.sort(
    (a, b) => b.info.timestamp - a.info.timestamp || a.row.key.localeCompare(b.row.key),
  );
  if (input.mode === "time") result.push(...sorted.map((item) => item.row));
  else {
    const groups = new Map<string, typeof sorted>();
    for (const item of sorted) {
      const group = groups.get(item.info.projectKey) ?? [];
      group.push(item);
      groups.set(item.info.projectKey, group);
    }
    for (const [projectKey, group] of groups) {
      const expanded = !input.collapsed.has(projectKey);
      result.push({
        type: "home-project",
        key: `home-project:0:${projectKey}`,
        projectKey,
        title: group[0]!.info.title,
        count: group.length,
        expanded,
      });
      if (expanded) result.push(...group.map((item) => item.row));
    }
  }
  return result;
}
