import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
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
const action = Schema.Literals(["screenshot", "open-t3", "open-notepad", "close-window"]);
const task = Schema.Struct({
  id: identifier,
  action,
  status: Schema.Literals(["queued", "running", "done", "failed", "canceled"]),
  updatedAt: Schema.String,
  message: Schema.String,
  deviceName: Schema.String,
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
    "Request one approved action on a paired Windows companion. The device user approves each request. Reuse clientRequestId for retries. A screenshot is returned to this thread by t3_companion_result.",
  parameters: Schema.Struct({ deviceId: identifier, action, clientRequestId: identifier }),
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
    "Check a task in this thread. Completed screenshots appear inline. To save one later, reuse its task ID and direct the user to “保存到我的设备” on the image. This call only displays it.",
  parameters: Schema.Struct({ id: identifier }),
  success: Schema.Struct({
    ...task.fields,
    captureScope: Schema.optionalKey(Schema.Literal("primary-display")),
    summary: Schema.optionalKey(Schema.String),
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
  dependencies: [...dependencies, FileSystem.FileSystem],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

const cancel = Tool.make("t3_companion_cancel", {
  description: "Cancel a queued companion task in this thread.",
  parameters: Schema.Struct({ id: identifier }),
  success: task,
  failure: OrchestratorMcpFailure,
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Idempotent, true);

export const CompanionStandardToolkit = Toolkit.make(list, enqueue, cancel);
export const CompanionResultToolkit = Toolkit.make(CompanionResultTool);
