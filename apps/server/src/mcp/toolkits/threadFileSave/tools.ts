import {
  ChatAttachmentId,
  FileHandoffInstallation,
  MessageId,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Tool, Toolkit } from "effect/ai";

import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { ServerConfig } from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { WorkspaceEntries } from "../../../workspace/WorkspaceEntries.ts";
import { WorkspacePaths } from "../../../workspace/WorkspacePaths.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
const filePath = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));
const result = Schema.Struct({
  id: identifier,
  name: Schema.String,
  recipientLabel: Schema.String,
  status: Schema.Literals(["awaiting_save", "saved", "cancelled"]),
  savedPath: Schema.optionalKey(Schema.String),
  installation: Schema.optionalKey(FileHandoffInstallation),
});

const save = Tool.make("t3_thread_file_save", {
  description:
    "Send a file only when the user explicitly asks to save it or send it to a device. For previews, show it in the thread. Use delivery for a file in this project's release inventory. Use workspaceOutput for a project file whose exact name or path the user gives, or a file created or edited in this turn, with the exact path recorded by the edit or printed on its own output line by the command that created it. To reuse a file linked in an earlier assistant reply, add its messageId. Existing attachments and completed companion tasks are also supported. The server uses the unique device named as destination in the user request or the authenticated sender for this device. After a device-choice response, pass the selected exact device label. On choose_target, ask an in-thread single-choice question with id t3-file-save-target and the exact labels, or ask for a save request naming the device. Use t3_thread_file_save_status to verify the receipt.",
  parameters: Schema.Struct({
    source: Schema.Union([
      Schema.TaggedStruct("delivery", { path: filePath }),
      Schema.TaggedStruct("workspaceOutput", {
        path: filePath,
        messageId: Schema.optionalKey(MessageId),
      }),
      Schema.TaggedStruct("attachment", { messageId: MessageId, attachmentId: ChatAttachmentId }),
      Schema.TaggedStruct("companionScreenshot", { taskId: identifier }),
      Schema.TaggedStruct("companionFile", { taskId: identifier }),
    ]),
    target: Schema.optionalKey(identifier),
  }),
  success: Schema.Union([
    result,
    Schema.Struct({
      status: Schema.Literal("choose_target"),
      reason: Schema.String,
      devices: Schema.Array(Schema.Struct({ label: Schema.String, online: Schema.Boolean })),
    }),
  ]),
  failure: OrchestratorMcpFailure,
  dependencies: [
    McpInvocationContext,
    ThreadManagementService,
    EnvironmentAuth,
    SessionStore,
    ServerConfig,
    ServerSettingsService,
    Digest.Digest,
    ProjectService,
    WorkspacePaths,
    WorkspaceEntries,
    FileSystem.FileSystem,
    Path.Path,
  ],
})
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const status = Tool.make("t3_thread_file_save_status", {
  description:
    "Check the real receiving-device receipt using the existing transfer ID. After staging, call with waitMs up to 15000. Report success only after saved. If it still says awaiting_save, tell the user the device has yet to come online or save the file. APK installation requires its own verified receipt.",
  parameters: Schema.Struct({
    id: identifier,
    waitMs: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 15_000 }))),
  }),
  success: result,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext, ThreadManagementService, ServerConfig],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ThreadFileSaveToolkit = Toolkit.make(save, status);
