import {
  COMPANION_MAX_RECORDING_SECONDS,
  CompanionCaptureKind,
  CompanionCaptureMetadata,
  CompanionWindowsInstallation,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { AssetSigner } from "../../../assets/AssetSigner.ts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { ServerConfig } from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext,
  ServerConfig,
  ServerSettingsService,
  ThreadManagementService,
];

const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const action = Schema.Literals([
  "screenshot",
  "record-screen",
  "open-t3",
  "open-notepad",
  "close-window",
  "send-file",
  "receive-file",
  "write-notepad",
  "read-notepad",
]);
const task = Schema.Struct({
  id: identifier,
  action,
  status: Schema.Literals(["queued", "running", "done", "failed", "canceled"]),
  updatedAt: Schema.String,
  message: Schema.String,
  deviceName: Schema.String,
  stopRequested: Schema.optionalKey(Schema.Literal(true)),
});

const list = Tool.make("t3_companion_list", {
  description:
    "List paired devices available for locally confirmed actions. Android clients with backgroundReady can accept queued screen capture requests when offline.",
  parameters: Schema.Struct({ deviceId: Schema.optionalKey(identifier) }),
  success: Schema.Struct({
    devices: Schema.Array(
      Schema.Struct({
        deviceId: identifier,
        name: Schema.String,
        online: Schema.Boolean,
        backgroundReady: Schema.optionalKey(Schema.Literal(true)),
        platform: Schema.Literals(["windows", "android"]),
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const enqueue = Tool.make("t3_companion_enqueue", {
  description:
    "Request one approved action on a paired device. Android accepts only screenshot and record-screen, and requires the phone user to grant Android screen-sharing consent in the foreground for each request. The Windows device user also approves each request. Reuse clientRequestId for retries. Use record-screen only when the user explicitly asks to record this device. For screenshots and recordings, the device user chooses the actual capture surface. On Windows, captureKind may suggest its category. durationSeconds sets a recording maximum from 1 to 30 seconds (default 10). Windows shows the recording and can stop it. Use send-file when the Windows user should choose a local file to return, or receive-file with the attachmentId of a file in this thread to save on Windows. open-t3 and open-notepad let the Windows user launch the fixed app or choose its visible window on a companion that supports window selection. read-notepad returns the text from the editor the Windows user approves. write-notepad replaces its text with the text shown during approval. Older companions require a Notepad they opened. close-window applies only to an original window opened by the companion. Read the original thread result with t3_companion_result.",
  parameters: Schema.Struct({
    deviceId: identifier,
    action,
    clientRequestId: identifier,
    attachmentId: Schema.optionalKey(identifier),
    captureKind: Schema.optionalKey(CompanionCaptureKind),
    durationSeconds: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: COMPANION_MAX_RECORDING_SECONDS })),
    ),
    text: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  }),
  success: task,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const CompanionResultTool = Tool.make("t3_companion_result", {
  description:
    "Check a task in this thread. For close-window, report the waiting message while the task is running and ask the user to handle any save prompt on Windows. Report an exit only when the final result confirms it. Completed screenshots appear inline. For a completed recording or a file sent by the Windows user, include its download link in the reply. A received file returns the confirmed local save path. For an MSI, distinguish an opened installer, cancellation, an unverified outcome, and a verified product code and installed version.",
  parameters: Schema.Struct({ id: identifier }),
  success: Schema.Struct({
    ...task.fields,
    captureScope: Schema.optionalKey(
      Schema.Literals(["primary-display", "window", "display", "android-screen"]),
    ),
    capture: Schema.optionalKey(CompanionCaptureMetadata),
    summary: Schema.optionalKey(Schema.String),
    recording: Schema.optionalKey(Schema.Struct({ url: Schema.String, expiresAt: Schema.Number })),
    file: Schema.optionalKey(
      Schema.Struct({
        url: Schema.String,
        name: Schema.String,
        sha256: Schema.String,
        expiresAt: Schema.Number,
      }),
    ),
    savedFile: Schema.optionalKey(Schema.Struct({ path: Schema.String, sha256: Schema.String })),
    windowsInstallation: Schema.optionalKey(CompanionWindowsInstallation),
    screenshot: Schema.optionalKey(
      Schema.Struct({
        mimeType: Schema.Literal("image/png"),
        data: Schema.String,
        width: Schema.Int,
        height: Schema.Int,
      }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, AssetSigner],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const cancel = Tool.make("t3_companion_cancel", {
  description:
    "Cancel a queued companion task in this thread or cancel an Android capture. On Windows, stop can finish a running recording. Check the result for the saved clip after Windows confirms the stop.",
  parameters: Schema.Struct({ id: identifier }),
  success: task,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true);

export const CompanionStandardToolkit = Toolkit.make(list, enqueue, cancel);
export const CompanionResultToolkit = Toolkit.make(CompanionResultTool);
