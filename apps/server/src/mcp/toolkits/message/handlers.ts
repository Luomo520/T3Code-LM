import * as Effect from "effect/Effect";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { MessageToolkit } from "./tools.ts";

const handlers = {
  send_to_user: McpToolAccess.actsAsCaller((input) =>
    Effect.succeed({
      sentMessage: input.message,
      message: "Shown to the user. Don't repeat it.",
    }),
  ),
  get_message_origin: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "Read message origin",
      );
      const threads = yield* ThreadManagement.ThreadManagementService;
      let messageId = input.messageId;
      if (messageId === undefined) {
        const projection = yield* threads.getThreadRecords(
          thread.threadId,
          ["runs", "providerThreads"],
          {
            runStatuses: ["running"],
          },
        );
        const activeRun = projection.runs.find((run) =>
          projection.providerThreads.some(
            (providerThread) =>
              providerThread.id === run.providerThreadId &&
              providerThread.providerSessionId === thread.providerSessionId,
          ),
        );
        if (activeRun === undefined) return { status: "missing" } as const;
        const { turnItems } = yield* threads.getThreadRecords(thread.threadId, ["turnItems"], {
          turnItemRunId: activeRun.id,
          turnItemTypes: ["user_message"],
        });
        const messageIds = new Set([activeRun.userMessageId]);
        for (const item of turnItems) {
          if (item.type === "user_message") messageIds.add(item.messageId);
        }
        // 同一运行接收多条消息时，调用方可按消息 ID 精确查找。
        if (messageIds.size > 1)
          return { status: "ambiguous", messageIds: [...messageIds] } as const;
        messageId = activeRun.userMessageId;
      }
      const message = (yield* threads.getMessagesById(thread.threadId, [messageId])).get(messageId);
      if (message?.role !== "user") return { status: "missing" } as const;
      return message.clientOrigin === undefined
        ? ({ status: "unknown", messageId } as const)
        : ({ status: "recorded", messageId, origin: message.clientOrigin } as const);
    }).pipe(
      Effect.mapError((error) => (error._tag === "OrchestratorMcpFailure" ? error : unavailable())),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof MessageToolkit.tools>;

export const layer = McpToolAccess.toLayer(MessageToolkit, handlers);
