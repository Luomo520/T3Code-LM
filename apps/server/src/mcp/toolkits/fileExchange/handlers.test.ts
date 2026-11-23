import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type Project as ProjectRecord,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
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
        return yield* Effect.all([
          toolkit
            .handle("t3_file_exchange_send", {
              deviceId: "fixture",
              localName: "report.txt",
            })
            .pipe(Stream.unwrap, Stream.runCollect),
          toolkit
            .handle("t3_file_exchange_move", {
              deviceId: "fixture",
              localName: "report.txt",
              direction: "send",
            })
            .pipe(Stream.unwrap, Stream.runCollect),
        ]);
      }).pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(FileExchangeHandlers.layer).pipe(
            Layer.provideMerge(layers),
          ),
        ),
      );
      for (const result of results)
        expect(result.at(-1)?.result).toMatchObject({ code: test.code });
    }
  }),
);

it.effect("passes explicit move requests and reports recovery after publication", () =>
  Effect.gen(function* () {
    const caller = { ...liveThreadShell(threadId), worktreePath: "/fixture/active-worktree" };
    const sourceDisposition = {
      status: "retained" as const,
      message: "The original name was replaced.",
      recoveryPath: "/remote/exchange/.staging/source",
    };
    const invocations: { readonly mode?: string; readonly workspaceRoot: string }[] = [];
    const layers = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(Project.ProjectService)({
        getById: () =>
          Effect.succeedSome({
            id: caller.projectId,
            workspaceRoot: "/fixture/workspace",
          } as ProjectRecord),
      }),
      Layer.mock(FileExchange.FileExchange)({
        transfer: (input) => {
          invocations.push(input);
          return Effect.succeed({
            deviceId: input.deviceId,
            direction: input.direction,
            workspacePath: `exchange/${input.localName}`,
            remoteName: input.remoteName ?? input.localName,
            sizeBytes: 32,
            sha256: "a".repeat(64),
            ...(input.mode === "move" ? { sourceDisposition } : {}),
          });
        },
      }),
    );
    const result = yield* Effect.gen(function* () {
      const toolkit = yield* FileExchangeToolkit;
      const input = { deviceId: "fixture", localName: "report.txt" };
      yield* toolkit.handle("t3_file_exchange_send", input).pipe(Stream.unwrap, Stream.runCollect);
      return yield* toolkit
        .handle("t3_file_exchange_move", { ...input, direction: "receive" })
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(FileExchangeHandlers.layer).pipe(
          Layer.provideMerge(layers),
        ),
      ),
    );
    expect(invocations[0]?.mode).toBeUndefined();
    expect(invocations[1]).toMatchObject({ mode: "move", workspaceRoot: caller.worktreePath });
    expect(result.at(-1)?.result).toMatchObject({ direction: "receive", sourceDisposition });
  }),
);
