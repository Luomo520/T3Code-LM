import {
  MessageId,
  OrchestrationV2MessageClientOrigin,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { SEND_TO_USER_MAX_LENGTH, SEND_TO_USER_TOOL_NAME } from "@t3tools/shared/toolOutput";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Claude 5.1+ returns text written before a tool call only as a short summary; tool input arrives intact.
// It affects only the caller's thread, so read-only sandboxes and plan mode may use it.
const SendToUserTool = Tool.make(SEND_TO_USER_TOOL_NAME, {
  description:
    "Show the user a Markdown message in this thread, exactly as written, before your turn ends. Use it for content the user must read in full mid-turn, such as a draft, a code block, or what a question you are about to ask refers to. Don't repeat it in your reply.",
  parameters: Schema.Struct({
    message: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(SEND_TO_USER_MAX_LENGTH),
    ).annotate({ description: "Markdown, shown verbatim." }),
  }),
  success: Schema.Struct({
    sentMessage: Schema.String,
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Send a message to the user")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  // Claude Code defers MCP tools behind ToolSearch; Anthropic says to declare this from the first request.
  .annotate(Tool.Meta, { "anthropic/alwaysLoad": true });

const GetMessageOriginTool = Tool.make("get_message_origin", {
  description:
    "Read the client that submitted a user message in this thread. Pass the message ID to select an exact message. Without an ID, the tool identifies the current run's message when the run has only one user message.",
  parameters: Schema.Struct({ messageId: Schema.optionalKey(MessageId) }),
  success: Schema.Union([
    Schema.Struct({
      status: Schema.Literal("recorded"),
      messageId: MessageId,
      origin: OrchestrationV2MessageClientOrigin,
    }),
    Schema.Struct({ status: Schema.Literal("unknown"), messageId: MessageId }),
    Schema.Struct({ status: Schema.Literal("missing") }),
    Schema.Struct({ status: Schema.Literal("ambiguous"), messageIds: Schema.Array(MessageId) }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Read user message origin")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const MessageToolkit = Toolkit.make(SendToUserTool, GetMessageOriginTool);
