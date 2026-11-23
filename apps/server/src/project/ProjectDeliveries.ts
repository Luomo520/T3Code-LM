// @effect-diagnostics nodeBuiltinImport:off -- 使用 Dirent 区分目录、普通文件与符号链接，并限制说明文件的读取字节数。
import type { ProjectDelivery, ProjectDeliveryPlatform, ProjectId } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

type DeliveryFile = Omit<ProjectDelivery, "projectId" | "projectTitle" | "workspaceRoot">;
type DeliveryScan = { files: DeliveryFile[]; incomplete: boolean };

const DELIVERY_DIRECTORIES = ["交付", "deliveries", "releases"] as const;
const MAX_DIRECTORIES = 1_000;
const MAX_FILES = 4_000;
const MAX_PROJECT_CHILDREN = 2_000;
const PAGE_SIZE = 40;
const RELEASE_DATE =
  /(?:发布日期|发行日期|(?:本地)?构建日期|构建时间|released(?: on)?|release date|build date)[^\d\r\n]{0,24}(20\d{2}-\d{2}-\d{2})/i;
const RELEASE_DOCUMENT = /^(?:README|RELEASE(?:[_-]NOTES)?|发布说明|使用说明)(?:\.[^.]+)?$/i;
const VERSION = /(?:^|[^\da-z])v?(\d+\.\d+\.\d+(?:[-+.][\da-z]+)*)(?=$|[^\da-z])/i;

function deliveryPlatform(name: string): ProjectDeliveryPlatform {
  if (/(?:^|[-_.])android(?:[-_.]|$)|\.(?:apk|aab)$/i.test(name)) return "android";
  if (/(?:^|[-_.])(?:windows|win32|win64|win)(?:[-_.]|$)|\.(?:exe|msi|msix)$/i.test(name))
    return "windows";
  if (/(?:^|[-_.])(?:linux|nas)(?:[-_.]|$)|\.(?:deb|rpm|appimage)$/i.test(name)) return "linux";
  if (/(?:^|[-_.])(?:macos|darwin|mac)(?:[-_.]|$)|\.(?:dmg|pkg)$/i.test(name)) return "macos";
  return "other";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(".." + NodePath.sep) && !NodePath.isAbsolute(relative)
  );
}

async function releaseDate(path: string): Promise<string | null> {
  try {
    if (!(await NodeFSP.lstat(path)).isFile()) return null;
    const handle = await NodeFSP.open(path, "r");
    try {
      const text = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(text, 0, text.length, 0);
      return RELEASE_DATE.exec(text.toString("utf8", 0, bytesRead))?.[1] ?? null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** 读取项目交付目录和其直属对话的交付目录，始终限制在项目根内。 */
export async function scanProjectDeliveries(workspaceRoot: string): Promise<DeliveryScan> {
  let incomplete = false;
  const root = await NodeFSP.realpath(workspaceRoot);
  const files: DeliveryFile[] = [];

  const rootEntries = await NodeFSP.readdir(root, { withFileTypes: true });
  const children = rootEntries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .filter((entry) => !DELIVERY_DIRECTORIES.some((name) => name === entry.name))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  incomplete = children.length > MAX_PROJECT_CHILDREN;
  const roots = rootEntries
    .filter(
      (entry) => entry.isDirectory() && DELIVERY_DIRECTORIES.some((name) => name === entry.name),
    )
    .map((entry) => entry.name);
  const candidateChildren = children.slice(0, MAX_PROJECT_CHILDREN);
  for (let start = 0; start < candidateChildren.length; start += 16) {
    const nested = await Promise.all(
      candidateChildren.slice(start, start + 16).map(async (child) => {
        const parent = NodePath.join(root, child.name);
        const realParent = await NodeFSP.realpath(parent).catch(() => null);
        if (realParent !== parent) return [];
        const deliveries = await Promise.all(
          DELIVERY_DIRECTORIES.map(async (name) => {
            const relative = NodePath.join(child.name, name);
            const info = await NodeFSP.lstat(NodePath.join(root, relative)).catch(
              (error: unknown) => {
                if (!isMissing(error)) incomplete = true;
                return null;
              },
            );
            return info?.isDirectory() ? relative : null;
          }),
        );
        return deliveries.filter((entry) => entry !== null);
      }),
    );
    roots.push(...nested.flat());
  }

  const queue = roots.map((relative) => ({ relative, ancestors: [] as string[] }));
  for (let index = 0; index < queue.length; index++) {
    if (index >= MAX_DIRECTORIES || files.length >= MAX_FILES) {
      incomplete = true;
      break;
    }
    const directory = queue[index]!;
    const folder = NodePath.join(root, directory.relative);
    // Dirent 拒绝符号链接，realpath 也检查扫描期间被替换的目录。
    const realFolder = await NodeFSP.realpath(folder).catch(() => null);
    if (realFolder === null || !isInside(root, realFolder) || realFolder !== folder) {
      incomplete = true;
      continue;
    }
    const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (!isMissing(error)) incomplete = true;
        return [];
      },
    );
    const sorted = entries
      .filter((entry) => !entry.name.startsWith("."))
      .toSorted((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }));
    const notes = sorted.find((entry) => entry.isFile() && RELEASE_DOCUMENT.test(entry.name));
    const notesPath = notes
      ? NodePath.join(directory.relative, notes.name).split(NodePath.sep).join("/")
      : null;
    const documentedDate = notes ? await releaseDate(NodePath.join(folder, notes.name)) : null;
    const folderVersion = directory.ancestors
      .toReversed()
      .map((ancestor) => VERSION.exec(ancestor)?.[1])
      .find((version) => version !== undefined);

    for (const entry of sorted) {
      if (entry.isDirectory()) {
        if (queue.length >= MAX_DIRECTORIES) {
          incomplete = true;
          continue;
        }
        queue.push({
          relative: NodePath.join(directory.relative, entry.name),
          ancestors: [...directory.ancestors, entry.name],
        });
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_FILES) {
        incomplete = true;
        break;
      }
      const relativePath = NodePath.join(directory.relative, entry.name)
        .split(NodePath.sep)
        .join("/");
      if (relativePath !== relativePath.trim()) continue;
      const stat = await NodeFSP.lstat(NodePath.join(root, relativePath)).catch(() => null);
      if (!stat?.isFile()) {
        incomplete = true;
        continue;
      }
      const platform = deliveryPlatform(entry.name);
      const inheritedPlatform = directory.ancestors
        .toReversed()
        .map(deliveryPlatform)
        .find((candidate) => candidate !== "other");
      files.push({
        relativePath,
        name: entry.name.trim() || relativePath,
        version: folderVersion ?? VERSION.exec(NodePath.parse(entry.name).name)?.[1] ?? null,
        platform: platform === "other" ? (inheritedPlatform ?? "other") : platform,
        date:
          documentedDate ??
          (Number.isFinite(stat.mtimeMs) ? stat.mtime.toISOString().slice(0, 10) : null),
        notesPath: notesPath === relativePath ? null : notesPath,
      });
    }
  }
  return { files, incomplete };
}

type Project = { id: ProjectId; title: string; workspaceRoot: string };

function searchText(value: string): string {
  return value.normalize("NFKC").toLowerCase().trim();
}

export const makeProjectDeliveryListing = Effect.gen(function* () {
  const cache = yield* Cache.make({
    capacity: 200,
    timeToLive: "30 seconds",
    lookup: (root: string) =>
      Effect.promise(() =>
        scanProjectDeliveries(root).catch((error: unknown): DeliveryScan => ({
          files: [],
          incomplete: !isMissing(error),
        })),
      ),
  });

  return Effect.fn("ProjectDeliveries.list")(function* (input: {
    readonly projects: ReadonlyArray<Project>;
    readonly query?: string | undefined;
    readonly offset?: number | undefined;
    readonly preferredPlatform?: ProjectDeliveryPlatform | undefined;
  }) {
    const query = searchText(input.query ?? "");
    const pages = yield* Effect.forEach(
      input.projects,
      (project) =>
        Cache.get(cache, project.workspaceRoot).pipe(
          Effect.map((scan) => ({
            incomplete: scan.incomplete,
            files: scan.files
              .filter((file) => searchText(file.name).includes(query))
              .map((file) => ({
                ...file,
                projectId: project.id,
                projectTitle: project.title,
                workspaceRoot: project.workspaceRoot,
              })),
          })),
        ),
      { concurrency: 4 },
    );
    const files = pages
      .flatMap((page) => page.files)
      .sort((left, right) => {
        if (input.preferredPlatform) {
          const suitability =
            Number(right.platform === input.preferredPlatform) -
            Number(left.platform === input.preferredPlatform);
          if (suitability !== 0) return suitability;
        }
        if (query) {
          const rank = searchText(left.name).indexOf(query) - searchText(right.name).indexOf(query);
          if (rank !== 0) return rank;
        }
        const dateOrder = (right.date ?? "").localeCompare(left.date ?? "");
        return (
          dateOrder ||
          right.relativePath.localeCompare(left.relativePath, undefined, { numeric: true })
        );
      });
    const offset = input.offset ?? 0;
    return {
      files: files.slice(offset, offset + PAGE_SIZE),
      nextOffset: offset + PAGE_SIZE < files.length ? offset + PAGE_SIZE : null,
      incomplete: pages.some((page) => page.incomplete),
    };
  });
});
