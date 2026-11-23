import {
  ChatAttachmentId,
  FileHandoffInstallation,
  MessageId,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { EnvironmentAuth } from "../../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { ServerConfig } from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const identifier = TrimmedNonEmptyString.check(Schema.isMaxLength(240));
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
    "Use when the latest user request explicitly asks to save or send an existing attachment, companion screenshot, or companion-selected file to a device. For a preview or a request to see a file, display it in the thread. Pass an attachment ID from a message in this thread or the completed companion task ID. Omit target for the authenticated device that sent the request. For a specifically named device, pass its exact paired-device name. On choose_target, ask an in-thread single-choice question with id t3-file-save-target and the exact device labels, then retry with the selected label. If choices are unavailable, ask for a new save request naming the device. Awaiting_save means ready on the receiving device. Use t3_thread_file_save_status to verify the receipt.",
  parameters: Schema.Struct({
    source: Schema.Union([
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
  ],
})
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const status = Tool.make("t3_thread_file_save_status", {
  description:
    "Read the receiving device's verified save and APK installation receipts for a file staged in this thread. Use the existing transfer ID.",
  parameters: Schema.Struct({ id: identifier }),
  success: result,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext, ThreadManagementService, ServerConfig],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ThreadFileSaveToolkit = Toolkit.make(save, status);
