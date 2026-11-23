import {
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  OrchestratorMcpFailure,
  orchestrationV2RunWorkStartedAt,
} from "@t3tools/contracts";
import { extractMarkdownLinkHrefs, parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";
import { renderCodexInlineDirectivesAsMarkdown } from "@t3tools/shared/codexMarkdownDirectives";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { openWorkspaceFileForHandoff } from "../../../assets/AssetAccess.ts";
import type { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { scanProjectDeliveries } from "../../../project/ProjectDeliveries.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { WorkspaceEntries } from "../../../workspace/WorkspaceEntries.ts";
import { unavailable } from "../../threadAccess.ts";

type WorkspaceSource =
  | { readonly _tag: "delivery"; readonly path: string }
  | { readonly _tag: "workspaceOutput"; readonly path: string; readonly messageId?: MessageId };

function mentionsFile(text: string, value: string): boolean {
  const normalized = text.normalize("NFKC").replaceAll("\\", "/");
  const name = value.normalize("NFKC").replaceAll("\\", "/");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9_.-])${escaped}(?![a-z0-9_.-])`, "u").test(normalized);
}

const denied = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: "该文件不属于当前项目的交付目录，也没有对应的会话输出记录。",
  });

export const resolveWorkspaceOutput = Effect.fn("ThreadFileSave.resolveWorkspaceOutput")(function* (
  source: WorkspaceSource,
  thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath">,
  run: OrchestrationV2Run,
  request: OrchestrationV2ConversationMessage,
  threads: ThreadManagementService["Service"],
) {
  const projects = yield* ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) return yield* denied();
  const path = yield* Path.Path;
  const root =
    source._tag === "delivery"
      ? project.value.workspaceRoot
      : (thread.worktreePath ?? project.value.workspaceRoot);
  const chosenPath = path.resolve(root, source.path);
  const relativePath = path.relative(root, chosenPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  )
    return yield* denied();

  const open = openWorkspaceFileForHandoff({
    threadId: thread.id,
    workspaceRoot: root,
    path: relativePath,
  }).pipe(Effect.mapError(denied));

  if (source._tag === "workspaceOutput") {
    const basename = path.basename(relativePath);
    const refersBack =
      /刚才|刚刚|前面|上一(?:条|份|个)|那(?:份|个|张)|\b(?:previous|above|that one)\b/iu.test(
        request.text,
      );
    let requestText = request.text;
    if (refersBack) {
      const history = yield* threads
        .getThreadRecords(thread.id, ["messages"], { messageRoles: ["user"] })
        .pipe(Effect.mapError(unavailable));
      const previous = history.messages
        .filter(
          (message) =>
            message.id !== request.id &&
            DateTime.toEpochMillis(message.createdAt) <= DateTime.toEpochMillis(request.createdAt),
        )
        .at(-1);
      if (previous?.clientOrigin) requestText += `\n${previous.text}`;
    }
    if (path.dirname(relativePath) !== "." && mentionsFile(requestText, relativePath)) {
      return (yield* open) ?? (yield* denied());
    }
    if (mentionsFile(requestText, basename)) {
      const entries = yield* WorkspaceEntries;
      const matches = yield* entries
        .search({ cwd: root, query: basename, limit: 200, kind: "file" })
        .pipe(Effect.mapError(unavailable));
      const exact = matches.entries.filter((entry) => path.basename(entry.path) === basename);
      if (matches.truncated || exact.length !== 1) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "无法唯一确定同名文件，请在原会话指明相对于项目目录的路径。",
        });
      }
      if (path.resolve(root, exact[0]!.path) === chosenPath)
        return (yield* open) ?? (yield* denied());
    }
  }
  if (source._tag === "delivery") {
    const inventory = yield* Effect.tryPromise({
      try: () => scanProjectDeliveries(root),
      catch: unavailable,
    });
    if (!inventory.files.some((entry) => path.resolve(root, entry.relativePath) === chosenPath)) {
      return yield* denied();
    }
  } else if (source.messageId !== undefined) {
    const messages = yield* threads
      .getMessagesById(thread.id, [source.messageId])
      .pipe(Effect.mapError(unavailable));
    const message = messages.get(source.messageId);
    const linked =
      message?.role === "assistant" &&
      !message.streaming &&
      extractMarkdownLinkHrefs(renderCodexInlineDirectivesAsMarkdown(message.text)).some((href) => {
        const link = parseMarkdownFileLink(href);
        return link !== null && path.resolve(root, link.path) === chosenPath;
      });
    if (!linked) return yield* denied();
  } else {
    const records = yield* threads
      .getThreadRecords(thread.id, ["turnItems"], {
        turnItemRunIds: [run.id],
        turnItemTypes: ["file_change", "command_execution"],
      })
      .pipe(Effect.mapError(unavailable));
    const changed = records.turnItems.some(
      (item) =>
        item.status === "completed" &&
        item.type === "file_change" &&
        (item.changes?.length
          ? item.changes.some(
              (change) =>
                !/^(?:d|remove|delete)$/iu.test(change.operation) &&
                path.resolve(root, change.path) === chosenPath,
            )
          : path.resolve(root, item.fileName) === chosenPath),
    );
    const reported = records.turnItems.some(
      (item) =>
        item.status === "completed" &&
        item.type === "command_execution" &&
        item.exitCode === 0 &&
        item.output
          ?.split(/\r?\n/u)
          .some((line) => line.trim() !== "" && path.resolve(root, line.trim()) === chosenPath),
    );
    if (!changed && !reported) return yield* denied();

    const file = yield* open;
    // 命令输出提供路径，创建时间核对它确是本轮新文件。
    if (
      !file ||
      (!changed &&
        file.sourceFile.info.birthtimeMs <
          BigInt(DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run))))
    ) {
      return yield* denied();
    }
    return file;
  }
  return (yield* open) ?? (yield* denied());
});
