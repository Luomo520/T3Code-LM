import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FileExchange from "../../../fileExchange/FileExchange.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as FileExchangeHandlers from "./handlers.ts";
import { FileExchangeToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:file-exchange");
const threadId = ThreadId.make("thread:file-exchange");
const scope = {
  environmentId,
  requestNamespace: "provider:file-exchange",
  thread: {
    threadId,
    providerSessionId: "provider:file-exchange",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
};

it.effect("only a live full-access regular thread may reach file exchange", () =>
  Effect.gen(function* () {
    const shell = liveThreadShell(threadId);
    for (const test of [
      { caller: { ...shell, runtimeMode: "auto" }, scope, code: "capability_denied" },
      { caller: { ...shell, interactionMode: "plan" }, scope, code: "capability_denied" },
      { caller: { ...shell, activeRunId: null }, scope, code: "parent_not_active" },
      {
        caller: shell,
        scope: { ...scope, thread: { ...scope.thread, subagent: true } },
        code: "capability_denied",
      },
      {
        caller: shell,
        scope: {
          ...scope,
          thread: undefined,
          client: { sessionId: "full", label: "Full", access: "full-access" },
        },
        code: "thread_credential_required",
      },
    ] as const) {
      const layers = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, test.scope),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(test.caller),
        }),
        Layer.mock(Project.ProjectService)({}),
        Layer.mock(FileExchange.FileExchange)({}),
      );
      const results = yield* Effect.gen(function* () {
        const toolkit = yield* FileExchangeToolkit;
        return yield* toolkit
          .handle("t3_file_exchange_send", {
            deviceId: "fixture",
            localName: "report.txt",
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(FileExchangeHandlers.layer).pipe(
            Layer.provideMerge(layers),
          ),
        ),
      );
      expect(results.at(-1)?.result).toMatchObject({ code: test.code });
    }
  }),
);
