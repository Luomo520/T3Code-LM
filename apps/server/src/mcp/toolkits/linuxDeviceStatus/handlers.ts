import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import * as Project from "../../../project/ProjectService.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { LinuxDeviceStatusToolkit } from "./tools.ts";

const checkCaller = readCaller().pipe(
  Effect.tap(assertLiveCaller),
  Effect.tap((caller) => assertNotLinked(caller, "inspect this environment's Linux devices")),
);

export const layer = McpToolAccess.toLayer(LinuxDeviceStatusToolkit, {
  t3_linux_device_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, caller } = yield* checkCaller;
      if (caller === undefined) return yield* unavailable();
      if (scope.thread?.subagent === true) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Linux device status needs a regular calling T3 thread.",
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

      const current = yield* checkCaller;
      if (current.caller?.projectId !== caller.projectId) return yield* unavailable();
      const exchange = yield* FileExchange.FileExchange;
      const status = yield* exchange
        .inspect({
          ...input,
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
      return { ...status, deviceId: input.deviceId };
    }),
  ),
});
