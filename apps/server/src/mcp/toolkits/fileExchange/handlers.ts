import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { FileExchangeToolkit } from "./tools.ts";

const transfer = (direction: "send" | "receive") =>
  McpToolAccess.writesEnvironment(
    (
      input: {
        readonly deviceId: string;
        readonly localName: string;
        readonly remoteName?: string;
        readonly expectedSha256?: string;
      },
      check,
    ) =>
      Effect.gen(function* () {
        const { scope, caller } = yield* check;
        yield* McpInvocationContext.requireThreadScope(scope, "File exchange");
        if (caller === undefined) return yield* unavailable();
        if (scope.thread?.subagent === true) {
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: "File exchange needs a regular calling T3 thread.",
          });
        }
        const projects = yield* Project.ProjectService;
        const project = yield* projects
          .getById(caller.projectId)
          .pipe(Effect.mapError(unavailable));
        if (Option.isNone(project)) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "The calling workspace is unavailable.",
          });
        }
        const current = yield* check;
        if (current.caller?.projectId !== caller.projectId) return yield* unavailable();
        const exchange = yield* FileExchange.FileExchange;
        return yield* exchange
          .transfer({
            ...input,
            direction,
            workspaceRoot: current.caller.worktreePath ?? project.value.workspaceRoot,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: error.message,
                }),
            ),
          );
      }),
  );

export const layer = McpToolAccess.toLayer(FileExchangeToolkit, {
  t3_file_exchange_send: transfer("send"),
  t3_file_exchange_receive: transfer("receive"),
});
