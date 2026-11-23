import { NodeHttpServer, NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { McpSchema } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";
import * as DateTime from "effect/DateTime";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AssetSigner, layer as assetSignerLayer } from "../../../assets/AssetSigner.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../../auth/McpOAuth.ts";
import { layer as secretStoreLayer } from "../../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { ServerConfig } from "../../../config.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import { readFileHandoff } from "../../../fileExchange/FileHandoff.ts";
import { layerFileHandoffRoutes } from "../../../http.ts";
import { OrchestratorProjectionError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { WorkspaceEntries } from "../../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../../workspace/WorkspacePaths.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { layer } from "./handlers.ts";
import { ThreadFileSaveToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("handoff-e2e-environment");
const projectId = ProjectId.make("project:mcp-test");
const threadId = ThreadId.make("handoff-e2e-thread");
const otherThread = ThreadId.make("handoff-e2e-other-thread");

const threadsLayer = Layer.effect(
  ThreadManagementService,
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const normalizeError = (threadId: ThreadId) => (cause: unknown) =>
      new OrchestratorProjectionError({ threadId, cause });
    return {
      getThreadShell: (id: ThreadId) =>
        store.getThreadShell(id).pipe(Effect.mapError(normalizeError(id))),
      getThreadRecords: (...args: Parameters<typeof store.getThreadRecords>) =>
        store.getThreadRecords(...args).pipe(Effect.mapError(normalizeError(args[0]))),
      getMessagesById: (id: ThreadId, ids: readonly MessageId[]) =>
        store.getMessagesById(id, ids).pipe(Effect.mapError(normalizeError(id))),
    } as ThreadManagementService["Service"];
  }),
);

const projectLayer = Layer.unwrap(
  Effect.gen(function* () {
    const cfg = yield* ServerConfig;
    const path = yield* Path.Path;
    return Layer.mock(ProjectService)({
      getById: (id: ProjectId) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                title: "Handoff",
                workspaceRoot: path.join(cfg.baseDir, "project"),
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                deletedAt: null,
              })
            : Option.none(),
        ),
    });
  }),
);

const support = Layer.mergeAll(
  EnvironmentAuth.layer,
  McpSessionRegistry.layer,
  assetSignerLayer,
  ProjectionStore.layer,
  projectLayer,
  WorkspacePaths.layer,
  Layer.mock(WorkspaceEntries)({
    search: ({ query }) =>
      Effect.succeed({
        entries: (query === "重复.txt" ? ["重复.txt", "子目录/重复.txt"] : [query]).map((path) => ({
          kind: "file",
          path,
        })),
        truncated: false,
      }),
  }),
  ServerSettingsService.layerTest(),
).pipe(
  Layer.provideMerge(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(secretStoreLayer),
  Layer.provide(ManagedPolicy.layerTest()),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-file-save-e2e-" })),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NodeHttpServer.layerTest),
  ),
);

const testRoutes = Layer.mergeAll(
  McpHttpServer.layerMcpTransport(
    McpHttpServer.toolkitRegistration(ThreadFileSaveToolkit, layer).pipe(
      Layer.provide(threadsLayer),
    ),
  ).pipe(Layer.provide(McpOAuth.layerMcpClientAuthenticator)),
  layerFileHandoffRoutes,
);
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.Struct({ result: Schema.Unknown }));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeTools = Schema.decodeUnknownEffect(
  Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
);
const decodeCall = Schema.decodeUnknownEffect(McpSchema.CallToolResult);

it.live(
  "stages authorized work from a conversation and reports the authenticated destination's receipt",
  () =>
    Effect.gen(function* () {
      const storage = yield* ProjectionStore.ProjectionStoreV2;
      const config = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const registry = yield* McpSessionRegistry.McpSessionRegistry;
      const sessions = yield* SessionStore;
      const digest = yield* Digest.Digest;
      const root = path.join(config.baseDir, "project");
      const files = [
        "交付/report.txt",
        "linked.txt",
        "new.txt",
        "验证传输.txt",
        "重复.txt",
        "子目录/重复.txt",
      ];
      const bytes = (file: string) => `原始文件 ${file}\n`;
      for (const file of files) {
        const absolute = path.join(root, file);
        yield* fs.makeDirectory(path.dirname(absolute), { recursive: true });
        yield* fs.writeFileString(absolute, bytes(file));
      }
      yield* fs.writeFileString(path.join(config.baseDir, "outside.txt"), "outside");
      yield* fs.symlink(path.join(config.baseDir, "outside.txt"), path.join(root, "outside.txt"));

      const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
      const mobile = yield* sessions.issue({
        subject: "owner",
        method: "bearer-access-token",
        scopes,
        client: { deviceType: "mobile", label: "手机" },
      });
      const desktop = yield* sessions.issue({
        subject: "owner",
        method: "bearer-access-token",
        scopes,
        client: { deviceType: "desktop", label: "书房电脑" },
      });
      const phoneSession = yield* sessions.verify(mobile.token);
      const computerSession = yield* sessions.verify(desktop.token);
      const encoded = new TextEncoder().encode(
        `t3-message-origin:session:${phoneSession.sessionId}`,
      );
      const clientAlias = Buffer.from(yield* digest.digest(Digest.sha256, encoded)).toString(
        "base64url",
      );
      const credential = yield* registry.issue({
        threadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      yield* HttpRouter.serve(testRoutes, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const http = yield* HttpClient.HttpClient;
      const headers = {
        accept: "application/json, text/event-stream",
        authorization: credential.config.authorizationHeader,
      };
      const result = yield* http.post("/mcp", {
        headers,
        body: HttpBody.text(
          encodeJson({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "file-save-e2e", version: "1" },
            },
          }),
          "application/json",
        ),
      });
      expect(result.status).toBe(200);
      const sessionId = result.headers["mcp-session-id"];
      expect(sessionId).toBeTruthy();
      const rpc = (method: string, params: object) =>
        http
          .post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": sessionId!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              encodeJson({ jsonrpc: "2.0", id: 2, method, params }),
              "application/json",
            ),
          })
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.flatMap(decodeEnvelope),
            Effect.map((response) => response.result),
          );
      const discovery = yield* rpc("tools/list", {}).pipe(Effect.flatMap(decodeTools));
      expect(discovery.tools.map(({ name }) => name)).toContain("t3_thread_file_save");
      const call = (name: string, args: Record<string, unknown>) =>
        rpc("tools/call", { name, arguments: args }).pipe(Effect.flatMap(decodeCall));
      let sequence = 0;
      const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
        storage.apply({
          ...event,
          id: EventId.make(`file-save-e2e-event-${++sequence}`),
        } as OrchestrationV2DomainEvent);
      const now = DateTime.makeUnsafe("2026-05-01T00:00:00.000Z");
      for (const id of [threadId, otherThread]) {
        const thread = idleThreadProjection(liveThreadShell(id)).thread;
        yield* apply({
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: thread,
        } as never);
      }
      const owner = idleThreadProjection(liveThreadShell(threadId)).thread;
      const writeMessage = (
        id: MessageId,
        text: string,
        role: "user" | "assistant",
        timestamp: DateTime.Utc,
        activeThread = threadId,
      ) =>
        apply({
          type: "message.updated",
          threadId: activeThread,
          occurredAt: timestamp,
          payload: {
            id,
            text,
            role,
            threadId: activeThread,
            createdBy: role === "user" ? "user" : "agent",
            creationSource: role === "user" ? "mobile" : "provider",
            ...(role === "user"
              ? { clientOrigin: { clientAlias, surface: "mobile", deviceType: "phone" } }
              : {}),
            runId: null,
            nodeId: null,
            streaming: false,
            attachments: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        } as never);

      let ordinal = 0;
      const turn = (text: string) =>
        Effect.gen(function* () {
          ordinal++;
          const time = DateTime.add(now, { seconds: ordinal });
          const id = RunId.make(`file-save-run-${ordinal}`);
          const messageId = MessageId.make(`file-save-user-${ordinal}`);
          yield* writeMessage(messageId, text, "user", time);
          yield* apply({
            type: "run.created",
            threadId,
            occurredAt: time,
            runId: id,
            providerInstanceId: owner.providerInstanceId,
            payload: {
              id,
              threadId,
              ordinal,
              modelSelection: owner.modelSelection,
              providerInstanceId: owner.providerInstanceId,
              status: "running",
              providerThreadId: null,
              userMessageId: messageId,
              rootNodeId: null,
              activeAttemptId: null,
              requestedAt: time,
              startedAt: time,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          } as never);
          return { id, time };
        });
      const save = (source: object, target?: string) =>
        call("t3_thread_file_save", { source, ...(target === undefined ? {} : { target }) });
      const decodeReceipt = Schema.decodeUnknownEffect(
        ThreadFileSaveToolkit.tools.t3_thread_file_save_status.successSchema,
      );
      const receive = (
        file: string,
        source: object,
        target?: string,
        toolTarget = target ?? null,
      ) =>
        Effect.gen(function* () {
          const staged = yield* save(source, toolTarget ?? undefined);
          expect(
            staged.isError,
            staged.content[0]?.type === "text" ? `${file} ${staged.content[0].text}` : file,
          ).toBeFalsy();
          const { id } = yield* decodeReceipt(staged.structuredContent);
          expect(staged.structuredContent).toMatchObject({ status: "awaiting_save" });
          const receivedBy = target ? computerSession : phoneSession;
          const list = yield* readFileHandoff({ _tag: "list", threadId }, receivedBy);
          expect(list).toMatchObject({
            transfers: expect.arrayContaining([
              expect.objectContaining({ id, outgoing: false, autoReceive: true }),
            ]),
          });
          const pending = yield* call("t3_thread_file_save_status", { id, waitMs: 5 });
          expect((yield* decodeReceipt(pending.structuredContent)).status).toBe("awaiting_save");
          const link = yield* readFileHandoff({ _tag: "receive", threadId, id }, receivedBy);
          if (link._tag !== "receive") return yield* Effect.die("Expected a signed receive URL.");
          const download = yield* http.get(link.relativeUrl);
          expect(download.status).toBe(200);
          expect(yield* download.text).toBe(bytes(file));
          const receipt = {
            _tag: "confirmSaved" as const,
            threadId,
            id,
            sha256: link.sha256,
            sizeBytes: link.sizeBytes,
            savedPath: `Download/t3code/${path.basename(file)}`,
          };
          expect(
            yield* Effect.result(readFileHandoff(receipt, target ? phoneSession : computerSession)),
          ).toMatchObject({ _tag: "Failure" });
          const wait = yield* call("t3_thread_file_save_status", { id, waitMs: 1_000 }).pipe(
            Effect.forkChild,
          );
          yield* readFileHandoff(receipt, receivedBy);
          const saved = yield* Fiber.join(wait);
          expect(saved.structuredContent).toMatchObject({
            status: "saved",
            savedPath: receipt.savedPath,
          });
          const retried = yield* save(source, toolTarget ?? undefined);
          expect((yield* decodeReceipt(retried.structuredContent)).id).toBe(id);
        });

      const delivery = { _tag: "delivery", path: "交付/report.txt" };
      yield* turn("只给我看看交付报告，不要下载");
      expect((yield* save(delivery)).isError).toBe(true);
      expect(yield* readFileHandoff({ _tag: "list", threadId }, phoneSession)).toMatchObject({
        transfers: [],
      });
      yield* turn("把这个交付报告发到这台手机");
      yield* receive("交付/report.txt", delivery);

      const link = {
        _tag: "workspaceOutput",
        path: "linked.txt",
        messageId: MessageId.make("last-reply"),
      };
      yield* writeMessage(link.messageId, "[生成的报告](linked.txt)", "assistant", now);
      const remoteLink = MessageId.make("remote-reply");
      yield* writeMessage(remoteLink, "[另一个会话](linked.txt)", "assistant", now, otherThread);
      yield* turn("把刚才那个发到书房电脑");
      expect((yield* save({ ...link, messageId: remoteLink }, "书房电脑")).isError).toBe(true);
      yield* receive("linked.txt", link, "书房电脑", null);
      yield* turn("把书房电脑刚生成的这个报告发到这台手机");
      yield* receive("linked.txt", link, undefined, "书房电脑");

      const fresh = yield* turn("生成一份记录然后发到这台手机");
      yield* apply({
        type: "turn-item.updated",
        threadId,
        runId: fresh.id,
        occurredAt: fresh.time,
        payload: {
          id: TurnItemId.make("file-created"),
          threadId,
          runId: fresh.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: fresh.time,
          completedAt: fresh.time,
          updatedAt: fresh.time,
          type: "file_change",
          fileName: "new.txt",
        },
      } as never);
      yield* receive("new.txt", { _tag: "workspaceOutput", path: "new.txt" });

      yield* turn("把当前项目的 验证传输.txt 发到这台手机");
      yield* receive("验证传输.txt", { _tag: "workspaceOutput", path: "验证传输.txt" });
      yield* turn("给我看看 验证传输.txt");
      yield* turn("把刚才那份发到书房电脑");
      yield* receive("验证传输.txt", { _tag: "workspaceOutput", path: "验证传输.txt" }, "书房电脑");
      yield* turn("把重复.txt发到这台手机");
      expect((yield* save({ _tag: "workspaceOutput", path: "重复.txt" })).isError).toBe(true);
      yield* turn("把子目录/重复.txt发到这台手机");
      yield* receive("子目录/重复.txt", { _tag: "workspaceOutput", path: "子目录/重复.txt" });
      yield* turn("把 验证传输.txt 发到书房电脑或者手机");
      expect(
        (yield* save({ _tag: "workspaceOutput", path: "验证传输.txt" })).structuredContent,
      ).toMatchObject({ status: "choose_target" });
      yield* sessions.issue({
        subject: "owner",
        method: "bearer-access-token",
        scopes,
        client: { deviceType: "desktop", label: "书房电脑" },
      });
      yield* turn("把 验证传输.txt 发到书房电脑");
      expect(
        (yield* save({ _tag: "workspaceOutput", path: "验证传输.txt" })).structuredContent,
      ).toMatchObject({ status: "choose_target" });
      yield* turn("把 outside.txt 发到这台手机");
      expect((yield* save({ _tag: "workspaceOutput", path: "../outside.txt" })).isError).toBe(true);
      expect((yield* save({ _tag: "workspaceOutput", path: "outside.txt" })).isError).toBe(true);
    }).pipe(Effect.provide(support)),
);
