import { COMPANION_MAX_IMAGE_BYTES, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { issueCompanionFileDownload } from "../../../assets/AssetAccess.ts";
import { CompanionError, getCompanionStore } from "../../../companion/store.ts";
import {
  getAndroidCaptureStore,
  isAndroidCaptureDevice,
} from "../../../companion/androidCaptureStore.ts";
import { archiveCapture } from "../../../companion/captureArchive.ts";
import { readCompanionTransferFile } from "../../../companion/transferFile.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { callerLinkOrigin } from "../../linkOrigin.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  loadCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
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

const perform = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      error instanceof CompanionError
        ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
        : unavailable(),
  });

const operate = <A>(operation: () => A) =>
  Effect.flatMap(ServerSettingsService, (settings) =>
    settings
      .withSettingsSnapshot((current) =>
        current.windowsCompanionEnabled
          ? perform(operation)
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
type AndroidTask = ReturnType<ReturnType<typeof getAndroidCaptureStore>["enqueue"]>;
const taskSummary = (task: CompanionTask | AndroidTask) => ({
  id: task.id,
  action: task.action,
  status: task.status,
  updatedAt: task.updatedAt,
  message: task.message,
  deviceName: task.deviceName,
  ...("stopRequested" in task && task.stopRequested ? { stopRequested: task.stopRequested } : {}),
});

function androidTask(stateDir: string, threadId: string, id: string) {
  try {
    return getAndroidCaptureStore(stateDir).result(threadId, id);
  } catch (error) {
    if (error instanceof CompanionError && error.status === 404) return null;
    throw error;
  }
}

const screenshotUnavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "This companion screenshot is unavailable.",
  });

export const layerStandard = McpToolAccess.toLayer(CompanionStandardToolkit, {
  t3_companion_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { stateDir } = yield* companionCaller();
      const settings = yield* ServerSettingsService;
      const windowsEnabled = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      const android = yield* perform(() => getAndroidCaptureStore(stateDir).list());
      const windows = windowsEnabled.windowsCompanionEnabled
        ? yield* operate(() => getCompanionStore(stateDir).list())
        : [];
      return {
        devices: [
          ...android,
          ...windows.map(({ deviceId, name, online }) => ({
            deviceId,
            name,
            online,
            platform: "windows" as const,
          })),
        ].filter((device) => input.deviceId === undefined || device.deviceId === input.deviceId),
      };
    }),
  ),
  t3_companion_enqueue: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller(true);
      let params: Record<string, string> = {};
      const fail = (message: string) =>
        new OrchestratorMcpFailure({ code: "invalid_request", message });
      if (
        (input.captureKind !== undefined &&
          input.action !== "screenshot" &&
          input.action !== "record-screen") ||
        (input.durationSeconds !== undefined && input.action !== "record-screen")
      ) {
        return yield* fail(
          "Capture options apply only to their corresponding screenshot or recording action.",
        );
      }
      if (isAndroidCaptureDevice(input.deviceId)) {
        if (
          (input.action !== "screenshot" && input.action !== "record-screen") ||
          input.captureKind !== undefined ||
          input.text !== undefined ||
          input.attachmentId !== undefined
        ) {
          return yield* fail(
            "Android supports only a locally confirmed screenshot or recording. The phone user chooses the capture surface.",
          );
        }
        const action = input.action;
        const task = yield* perform(() =>
          getAndroidCaptureStore(stateDir).enqueue(
            threadId,
            input.deviceId,
            action,
            input.clientRequestId,
            input.durationSeconds ?? 10,
          ),
        );
        return taskSummary(task);
      }
      if (input.action === "screenshot" || input.action === "record-screen") {
        params = {
          ...(input.captureKind === undefined ? {} : { captureKind: input.captureKind }),
          ...(input.durationSeconds === undefined
            ? {}
            : { durationSeconds: String(input.durationSeconds) }),
        };
      } else if (input.action === "receive-file") {
        if (!input.attachmentId)
          return yield* fail("Select a file already attached to this thread.");
        const { projection } = yield* readThread(threadId, ["messages"]);
        const attachment = projection.messages
          .flatMap((message) => message.attachments)
          .find((attachment) => attachment.id === input.attachmentId);
        if (attachment === undefined)
          return yield* fail("This file is unavailable in the requesting thread.");
        const { attachmentsDir } = yield* ServerConfig;
        const { sha256 } = yield* operate(() =>
          readCompanionTransferFile(attachmentsDir, attachment.id),
        );
        params = { attachmentId: attachment.id, fileName: attachment.name.slice(0, 240), sha256 };
      } else if (input.action === "write-notepad") {
        if (
          input.text === undefined ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)
        ) {
          return yield* fail("Provide plain Notepad text of up to 512 characters.");
        }
        params = { text: input.text };
      }
      const task = yield* operate(() =>
        getCompanionStore(stateDir).enqueue(
          threadId,
          input.deviceId,
          input.action,
          input.clientRequestId,
          params,
        ),
      );
      return taskSummary(task);
    }),
  ),
  t3_companion_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller(true);
      const known = yield* perform(() => androidTask(stateDir, threadId, input.id));
      const task = known
        ? yield* perform(() => getAndroidCaptureStore(stateDir).cancel(threadId, input.id))
        : yield* operate(() => getCompanionStore(stateDir).cancel(threadId, input.id));
      return taskSummary(task);
    }),
  ),
});

export const layerResult = McpToolAccess.toLayer(CompanionResultToolkit, {
  t3_companion_result: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { threadId, stateDir } = yield* companionCaller();
      const fromAndroid = yield* perform(() => androidTask(stateDir, threadId, input.id));
      const task =
        fromAndroid ??
        (yield* operate(() => getCompanionStore(stateDir).result(threadId, input.id)));
      const summary = taskSummary(task);
      const capture = "capture" in task ? task.capture : undefined;
      if ("savedFile" in task && task.savedFile !== undefined)
        return {
          ...summary,
          savedFile: task.savedFile,
          ...(task.windowsInstallation === undefined
            ? {}
            : { windowsInstallation: task.windowsInstallation }),
        };
      if ("transferredFile" in task && task.transferredFile !== undefined) {
        const source = task.transferredFile;
        const { origin } = yield* McpInvocationContext.McpInvocationContext;
        const download = yield* issueCompanionFileDownload(threadId, source.path, source.name).pipe(
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "This companion file is unavailable.",
              }),
          ),
        );
        return {
          ...summary,
          file: {
            name: source.name,
            sha256: source.sha256,
            url:
              origin === undefined
                ? download.relativeUrl
                : new URL(download.relativeUrl, origin).href,
            expiresAt: download.expiresAt,
          },
        };
      }
      if (
        task.action === "record-screen" &&
        task.status === "done" &&
        task.recordingPath !== undefined
      ) {
        const { origin } = yield* McpInvocationContext.McpInvocationContext;
        const source = fromAndroid
          ? Effect.succeed(task.recordingPath)
          : archiveCapture(threadId, task.id, task.recordingPath, "avi");
        const download = yield* source.pipe(
          Effect.flatMap((source) => issueCompanionFileDownload(threadId, source)),
          Effect.mapError(
            () =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: "This companion recording is unavailable.",
              }),
          ),
        );
        return {
          ...summary,
          captureScope: fromAndroid
            ? ("android-screen" as const)
            : (("captureScope" in task ? task.captureScope : undefined) ?? "primary-display"),
          ...(capture === undefined ? {} : { capture }),
          recording: {
            url:
              origin === undefined
                ? download.relativeUrl
                : new URL(download.relativeUrl, origin).href,
            expiresAt: download.expiresAt,
          },
        };
      }
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
      if (!fromAndroid) {
        yield* archiveCapture(threadId, task.id, task.imagePath, "png").pipe(
          Effect.mapError(screenshotUnavailable),
        );
      }
      const captureScope = fromAndroid
        ? "android-screen"
        : (("captureScope" in task ? task.captureScope : undefined) ?? "primary-display");
      const label = capture
        ? captureScope === "window" && capture.label !== "所选窗口"
          ? `窗口 ${capture.label}`
          : capture.label
        : captureScope === "android-screen"
          ? "Android 所选画面"
          : captureScope === "window"
            ? "所选窗口"
            : captureScope === "display"
              ? "所选显示器"
              : "主显示器";
      return {
        ...summary,
        captureScope,
        ...(capture === undefined ? {} : { capture }),
        summary: `${task.deviceName} · ${label} · ${capture ? `拍摄时间 ${capture.capturedAt}` : `上报时间 ${task.updatedAt}`}`,
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
