import {
  COMPANION_MAX_RECORDING_SECONDS,
  CompanionCaptureKind,
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
  description: "List paired Windows companions and whether they are online.",
  parameters: Schema.Struct({ deviceId: Schema.optionalKey(identifier) }),
  success: Schema.Struct({
    devices: Schema.Array(
      Schema.Struct({ deviceId: identifier, name: Schema.String, online: Schema.Boolean }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const enqueue = Tool.make("t3_companion_enqueue", {
  description:
    "Request one approved action on a paired Windows companion. The device user approves each request. Reuse clientRequestId for retries. Use record-screen only when the user explicitly asks to record this device. For screenshots and recordings, the Windows user chooses the actual window or display. captureKind may suggest its category. durationSeconds sets a recording maximum from 1 to 30 seconds (default 10). Windows shows the recording and can stop it. Use send-file when the Windows user should choose a local file to return, or receive-file with the attachmentId of a file in this thread to save on Windows. write-notepad replaces the text in the companion's own foreground Notepad with the approved text; read-notepad returns that document's text. Read the original thread result with t3_companion_result.",
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
    "Check a task in this thread. Completed screenshots appear inline. For a completed recording or a file sent by the Windows user, include its download link in the reply. A received file returns the confirmed local save path.",
  parameters: Schema.Struct({ id: identifier }),
  success: Schema.Struct({
    ...task.fields,
    captureScope: Schema.optionalKey(Schema.Literals(["primary-display", "window", "display"])),
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
    "Cancel a queued companion task in this thread, or stop its running Windows recording. Check the result for the saved clip after Windows confirms the stop.",
  parameters: Schema.Struct({ id: identifier }),
  success: task,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true);

export const CompanionStandardToolkit = Toolkit.make(list, enqueue, cancel);
export const CompanionResultToolkit = Toolkit.make(CompanionResultTool);
