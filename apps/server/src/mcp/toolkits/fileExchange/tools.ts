import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import { listConfiguredDevices } from "../../../fileExchange/config.ts";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  parameters: Schema.Struct({
    deviceId: Schema.String,
    localName: Schema.String,
    remoteName: Schema.optionalKey(Schema.String),
    expectedSha256: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    deviceId: Schema.String,
    direction: Schema.Literals(["send", "receive"]),
    workspacePath: Schema.String,
    remoteName: Schema.String,
    sizeBytes: Schema.Int,
    sha256: Schema.String,
  }),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    Project.ProjectService,
    FileExchange.FileExchange,
  ],
};

const configured = () => listConfiguredDevices().length > 0;

const FileSendTool = Tool.make("t3_file_exchange_send", {
  ...shared,
  description:
    "Send one file from this thread's configured workspace exchange directory to an administrator-configured Linux SFTP device. Use file names only. remoteName defaults to localName. The destination must be new. Limit 1 GiB. Call only for a specific transfer the user requested.",
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, configured);

const FileReceiveTool = Tool.make("t3_file_exchange_receive", {
  ...shared,
  description:
    "Receive one file from an administrator-configured Linux SFTP device into this thread's configured workspace exchange directory. Use file names only. remoteName defaults to localName. The destination must be new. Limit 1 GiB. Call only for a specific transfer the user requested.",
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, configured);

const FileMoveTool = Tool.make("t3_file_exchange_move", {
  ...shared,
  parameters: Schema.Struct({
    ...shared.parameters.fields,
    direction: Schema.Literals(["send", "receive"]),
  }),
  success: Schema.Struct({
    ...shared.success.fields,
    sourceDisposition: Schema.Union([
      Schema.Struct({ status: Schema.Literal("removed") }),
      Schema.Struct({
        status: Schema.Literal("retained"),
        message: Schema.String,
        recoveryPath: Schema.optionalKey(Schema.String),
      }),
    ]),
  }),
  description:
    "Move one file between this thread's configured workspace exchange directory and an administrator-configured Linux SFTP device. Use only when the user explicitly requests a move. The destination must be new. Limit 1 GiB. The source is removed only after verifying the saved destination and checking the source again. If sourceDisposition is retained, report that the destination was saved and the source was kept, including its recovery path when present.",
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, configured);

export const FileExchangeToolkit = Toolkit.make(FileSendTool, FileReceiveTool, FileMoveTool);
