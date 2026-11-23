import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import { isExchangeName } from "../../../fileExchange/config.ts";
import { isActiveRun } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { FileExchangeToolkit } from "./tools.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);

type TransferInput = {
  readonly deviceId: string;
  readonly localName: string;
  readonly remoteName?: string;
  readonly expectedSha256?: string;
  readonly direction?: "send" | "receive";
};

const exactArgument = (value: string) => {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return `(?:${escaped}|"${escaped}"|\`${escaped}\`|「${escaped}」|“${escaped}”)`;
};

// 将原话中的操作、方向、设备及源/目标文件名与工具参数一起核对。
function matchesTransferRequest(
  original: string,
  input: TransferInput,
  direction: "send" | "receive",
  move: boolean,
): boolean {
  const remoteName = input.remoteName ?? input.localName;
  if (!isExchangeName(input.localName) || !isExchangeName(remoteName)) return false;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(input.deviceId)) return false;
  const sending = direction === "send";
  const source = exactArgument(sending ? input.localName : remoteName);
  const target = exactArgument(sending ? remoteName : input.localName);
  const device = exactArgument(input.deviceId);
  const rename = input.localName === remoteName ? "?" : "";
  const englishVerb = move
    ? "[Mm]ove"
    : sending
      ? "[Ss]end|[Uu]pload|[Tt]ransfer|[Cc]opy"
      : "[Rr]eceive|[Dd]ownload|[Ff]etch|[Rr]etrieve|[Cc]opy";
  const englishDirection = sending ? "[Tt]o" : "[Ff]rom";
  const english = `(?:[Pp]lease\\s+)?(?:${englishVerb})\\s+${source}\\s+${englishDirection}\\s+${device}(?:\\s+[Aa]s\\s+${target})${rename}`;
  const chineseVerb = move
    ? "移动|移走"
    : sending
      ? "上传|发送|传输|传|复制"
      : "下载|接收|取回|拉取|复制";
  const chinese = sending
    ? `(?:把\\s*)?${source}\\s*(?:${chineseVerb})到\\s*${device}`
    : `从\\s*${device}\\s*(?:${chineseVerb})\\s*${source}`;
  const chineseCommand = `(?:请(?:帮我)?|帮我|麻烦)?\\s*${chinese}(?:[，,]?\\s*(?:另存为|存为|重命名为)\\s*${target})${rename}`;
  return new RegExp(`^(?:${english}|${chineseCommand})[。！.!]?$`, "u").test(original.trim());
}

const transfer = (direction: "send" | "receive" | "move") =>
  McpToolAccess.writesEnvironment((input: TransferInput, check) =>
    Effect.gen(function* () {
      const { scope, caller, threads } = yield* check;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "File exchange");
      if (caller === undefined || caller.activeRunId === null) return yield* unavailable();
      if (thread.subagent === true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "File exchange needs a regular calling T3 thread.",
        });
      }
      const transferDirection = direction === "move" ? input.direction : direction;
      if (transferDirection === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Choose send or receive for a file move.",
        });
      }
      const records = yield* threads
        .getThreadRecords(thread.threadId, ["runs"], { runIds: [caller.activeRunId] })
        .pipe(Effect.mapError(unavailable));
      const run = records.runs.find((item) => item.id === caller.activeRunId);
      if (
        run === undefined ||
        !isActiveRun(run) ||
        run.providerInstanceId !== thread.providerInstanceId
      )
        return yield* unavailable();
      const messages = yield* threads
        .getMessagesById(thread.threadId, [run.userMessageId])
        .pipe(Effect.mapError(unavailable));
      const message = messages.get(run.userMessageId);
      if (
        message?.role !== "user" ||
        message.createdBy !== "user" ||
        message.threadId !== thread.threadId ||
        !message.clientOrigin ||
        !matchesTransferRequest(message.text, input, transferDirection, direction === "move")
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "请在原会话从已认证的客户端明确请求传输，写明方向、设备编号、源文件名和需要改用的目标文件名。",
        });
      }
      const projects = yield* Project.ProjectService;
      const project = yield* projects.getById(caller.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(project)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The calling workspace is unavailable.",
        });
      }
      const workspaceRoot = caller.worktreePath ?? project.value.workspaceRoot;
      const recheck = Effect.gen(function* () {
        const current = yield* check;
        if (
          current.caller?.projectId !== caller.projectId ||
          current.caller.activeRunId !== caller.activeRunId ||
          current.caller.worktreePath !== caller.worktreePath
        )
          return yield* unavailable();
        if (caller.worktreePath === null) {
          const currentProject = yield* projects
            .getById(caller.projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(currentProject) || currentProject.value.workspaceRoot !== workspaceRoot)
            return yield* unavailable();
        }
      });
      yield* recheck;
      const exchange = yield* FileExchange.FileExchange;
      const receipt = yield* exchange
        .transfer(
          {
            ...input,
            direction: transferDirection,
            ...(direction === "move" ? { mode: "move" as const } : {}),
            workspaceRoot,
          },
          recheck,
        )
        .pipe(
          Effect.mapError((error) =>
            isMcpFailure(error)
              ? error
              : new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
          ),
        );
      return {
        ...receipt,
        sourceDisposition: receipt.sourceDisposition ?? {
          status: "retained" as const,
          message: "The source removal was not confirmed.",
        },
      };
    }),
  );

export const layer = McpToolAccess.toLayer(FileExchangeToolkit, {
  t3_file_exchange_send: transfer("send"),
  t3_file_exchange_receive: transfer("receive"),
  t3_file_exchange_move: transfer("move"),
});
