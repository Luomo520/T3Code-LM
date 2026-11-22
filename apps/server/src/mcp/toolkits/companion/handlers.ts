import { COMPANION_MAX_IMAGE_BYTES, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { CompanionError, getCompanionStore } from "../../../companion/store.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import { assertFullAccess, assertLiveCaller, loadCaller, unavailable } from "../../threadAccess.ts";
import { pngDimensions } from "../device/handlers.ts";
import { CompanionResultToolkit, CompanionStandardToolkit } from "./tools.ts";

const companionCaller = Effect.fn("mcp.companionCaller")(function* (write = false) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(invocation, "Companion tools");
  const caller = yield* loadCaller();
  yield* assertLiveCaller(caller);
  if (thread.subagent || callerLinkOrigin(caller) !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Companion tools require a regular thread in this environment.",
    });
  }
  if (write) {
    const { managedPolicy } = yield* ServerSettingsService;
    const ceiling = managedPolicy?.limits?.maxRuntimeMode;
    const message = "Companion actions require full-access/default mode.";
    if (ceiling !== undefined && ceiling !== "full-access") {
      return yield* new OrchestratorMcpFailure({ code: "capability_denied", message });
    }
    yield* assertFullAccess(caller, message);
  }
  const { stateDir } = yield* ServerConfig;
  return { threadId: thread.threadId, stateDir };
});

const operate = <A>(operation: () => A) =>
  Effect.flatMap(ServerSettingsService, (settings) =>
    settings
      .withSettingsSnapshot((current) =>
        current.windowsCompanionEnabled
          ? Effect.try({
              try: operation,
              catch: (error) =>
                error instanceof CompanionError
                  ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
                  : unavailable(),
            })
          : Effect.fail(
              new OrchestratorMcpFailure({
                code: "capability_denied",
                message: "Enable Windows Companion in this environment before using its tools.",
              }),
            ),
      )
      .pipe(Effect.catchTags({ ServerSettingsError: () => Effect.fail(unavailable()) })),
  );

type CompanionTask = ReturnType<ReturnType<typeof getCompanionStore>["enqueue"]>;
const taskSummary = ({ id, action, status, updatedAt, message, deviceName }: CompanionTask) => ({
  id,
  action,
  status,
  updatedAt,
  message,
  deviceName,
});

const screenshotUnavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "This companion screenshot is unavailable.",
  });

export const layerStandard = McpToolAccess.toLayer(CompanionStandardToolkit, {
  t3_companion_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { stateDir } = yield* companionCaller();
      const paired = yield* operate(() => getCompanionStore(stateDir).list());
      return {
        devices: paired
          .filter((device) => input.deviceId === undefined || device.deviceId === input.deviceId)
          .map(({ deviceId, name, online }) => ({ deviceId, name, online })),
      };
    }),
  ),
  t3_companion_enqueue: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller(true);
      const task = yield* operate(() =>
        getCompanionStore(stateDir).enqueue(
          threadId,
          input.deviceId,
          input.action,
          input.clientRequestId,
        ),
      );
      return taskSummary(task);
    }),
  ),
  t3_companion_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller(true);
      const task = yield* operate(() => getCompanionStore(stateDir).cancel(threadId, input.id));
      return taskSummary(task);
    }),
  ),
});

export const layerResult = McpToolAccess.toLayer(CompanionResultToolkit, {
  t3_companion_result: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller();
      const task = yield* operate(() => getCompanionStore(stateDir).result(threadId, input.id));
      const summary = taskSummary(task);
      if (task.action !== "screenshot" || task.status !== "done" || task.imagePath === undefined) {
        return summary;
      }
      const fs = yield* FileSystem.FileSystem;
      const info = yield* fs.stat(task.imagePath).pipe(Effect.mapError(screenshotUnavailable));
      if (info.type !== "File" || info.size > COMPANION_MAX_IMAGE_BYTES) {
        return yield* screenshotUnavailable();
      }
      const bytes = yield* fs.readFile(task.imagePath).pipe(Effect.mapError(screenshotUnavailable));
      const { width, height } = pngDimensions(bytes);
      if (bytes.length > COMPANION_MAX_IMAGE_BYTES || width === 0 || height === 0) {
        return yield* screenshotUnavailable();
      }
      return {
        ...summary,
        captureScope: "primary-display" as const,
        summary: `${task.deviceName} · 主显示器 · 上报时间 ${task.updatedAt}`,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(bytes).toString("base64"),
          width,
          height,
        },
      };
    }),
  ),
});
