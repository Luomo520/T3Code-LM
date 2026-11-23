import { NodeHttpServer, NodeCrypto, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ChatAttachmentId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
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

import { layer as assetSignerLayer } from "../../../assets/AssetSigner.ts";
import {
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../../../attachmentStore.ts";
import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../../auth/McpOAuth.ts";
import { layer as secretStoreLayer } from "../../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../../auth/SessionStore.ts";
import { archiveCapture } from "../../../companion/captureArchive.ts";
import { createCompanionStore, getCompanionStore } from "../../../companion/store.ts";
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
    tools: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        description: Schema.optionalKey(Schema.String),
        inputSchema: Schema.Unknown,
      }),
    ),
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
        "sample.txt",
        "sample.txt.bak",
        "验证传输.txt",
        "验证安装.apk",
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
        client: { deviceType: "mobile", label: "手机", os: "Android" },
      });
      const desktop = yield* sessions.issue({
        subject: "owner",
        method: "bearer-access-token",
        scopes,
        client: { deviceType: "desktop", label: "书房电脑" },
      });
      const phoneSession = yield* sessions.verify(mobile.token);
      const computerSession = yield* sessions.verify(desktop.token);
      const sessionAlias = (session: typeof phoneSession) =>
        digest
          .digest(
            Digest.sha256,
            new TextEncoder().encode(`t3-message-origin:session:${session.sessionId}`),
          )
          .pipe(Effect.map((hash) => Buffer.from(hash).toString("base64url")));
      const clientAlias = yield* sessionAlias(phoneSession);
      const computerAlias = yield* sessionAlias(computerSession);
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
      const advertisedSave = discovery.tools.find(({ name }) => name === "t3_thread_file_save");
      expect(advertisedSave?.description).toContain("Leave action and id out of new transfers.");
      expect(advertisedSave?.inputSchema).toMatchObject({
        properties: {
          action: { description: expect.stringContaining("Omit for a new transfer.") },
          id: { description: expect.stringContaining("Existing transfer ID.") },
          source: { description: "File source for a new transfer." },
        },
      });
      const workspaceSave = discovery.tools.find(
        ({ name }) => name === "t3_thread_save_workspace_file",
      );
      expect(workspaceSave?.inputSchema).toMatchObject({
        required: ["path"],
        properties: {
          path: { type: "string" },
          target: { type: "string" },
        },
      });
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
        alias = clientAlias,
        surface: "mobile" | "desktop" = "mobile",
        attachments: ReadonlyArray<ChatAttachment> = [],
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
            creationSource:
              role === "assistant" ? "provider" : surface === "mobile" ? "mobile" : "web",
            ...(role === "user"
              ? {
                  clientOrigin: {
                    clientAlias: alias,
                    surface,
                    deviceType: surface === "mobile" ? "phone" : "desktop",
                  },
                }
              : {}),
            runId: null,
            nodeId: null,
            streaming: false,
            attachments,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        } as never);

      let ordinal = 0;
      const turn = (text: string, alias = clientAlias, surface: "mobile" | "desktop" = "mobile") =>
        Effect.gen(function* () {
          ordinal++;
          const time = DateTime.add(now, { seconds: ordinal });
          const id = RunId.make(`file-save-run-${ordinal}`);
          const messageId = MessageId.make(`file-save-user-${ordinal}`);
          yield* writeMessage(messageId, text, "user", time, threadId, alias, surface);
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
      const manage = (action: "cancel" | "redirect", args: Record<string, unknown> = {}) =>
        call("t3_thread_file_save", { action, ...args });
      const receiveLink = (id: string, session: typeof phoneSession) =>
        readFileHandoff({ _tag: "receive", threadId, id }, session).pipe(
          Effect.map((reply) => {
            if (reply._tag !== "receive") throw new Error("Expected a signed receive URL.");
            return reply;
          }),
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
      expect(
        (yield* call("t3_thread_save_workspace_file", { path: "交付/report.txt" })).isError,
      ).toBe(true);
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
      yield* turn("Please show me sample.txt.bak.");
      yield* turn("Save that file to this phone.");
      const saveSample = () =>
        call("t3_thread_save_workspace_file", { path: "sample.txt", target: "this phone" });
      expect((yield* saveSample()).isError).toBe(true);

      yield* turn("Please show me sample.txt.");
      expect((yield* saveSample()).isError).toBe(true);
      yield* turn("Save that file to this phone.");
      const sampleResult = yield* saveSample();
      expect(sampleResult.isError).toBeFalsy();
      const sample = yield* decodeReceipt(sampleResult.structuredContent);
      expect(sample).toMatchObject({ recipientLabel: "手机 · Android", status: "awaiting_save" });
      const sampleLink = yield* receiveLink(sample.id, phoneSession);
      const sampleDownload = yield* http.get(sampleLink.relativeUrl);
      expect(sampleDownload.status).toBe(200);
      expect(yield* sampleDownload.text).toBe(bytes("sample.txt"));
      const sampleBytes = new TextEncoder().encode(bytes("sample.txt"));
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: sample.id,
          sha256: yield* digest.digestHex(Digest.sha256, sampleBytes),
          sizeBytes: sampleBytes.length,
          savedPath: "Downloads/sample.txt",
        },
        phoneSession,
      );

      yield* turn("把重复.txt发到这台手机");
      expect((yield* save({ _tag: "workspaceOutput", path: "重复.txt" })).isError).toBe(true);
      yield* turn("把子目录/重复.txt发到这台手机");
      yield* receive("子目录/重复.txt", { _tag: "workspaceOutput", path: "子目录/重复.txt" });

      const apkSource = { _tag: "workspaceOutput", path: "验证安装.apk" };
      yield* turn("把验证安装.apk发到这台手机");
      const ordinaryApk = yield* decodeReceipt((yield* save(apkSource)).structuredContent);
      expect(ordinaryApk).not.toHaveProperty("installRequested");
      const ordinaryApkLink = yield* receiveLink(ordinaryApk.id, phoneSession);
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: ordinaryApk.id,
          sha256: ordinaryApkLink.sha256,
          sizeBytes: ordinaryApkLink.sizeBytes,
          savedPath: "Download/t3code/验证安装.apk",
        },
        phoneSession,
      );

      yield* turn("发验证安装.apk到这台手机并安装");
      const apk = yield* decodeReceipt((yield* save(apkSource)).structuredContent);
      expect(apk).toMatchObject({ status: "awaiting_save", installRequested: true });
      const apkLink = yield* receiveLink(apk.id, phoneSession);
      const report = (
        installation:
          | { status: "cancelled" | "failed" }
          | { status: "verified"; packageName: string; version: string; versionCode: string },
      ) => ({
        _tag: "reportInstall" as const,
        threadId,
        id: apk.id,
        sha256: apkLink.sha256,
        installation,
      });
      expect(
        yield* Effect.result(readFileHandoff(report({ status: "failed" }), phoneSession)),
      ).toMatchObject({ _tag: "Failure" });
      yield* sessions.markDisconnected(phoneSession.sessionId);
      yield* sessions.markConnected(phoneSession.sessionId);
      const reconnectedPhone = yield* sessions.verify(mobile.token);
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: apk.id,
          sha256: apkLink.sha256,
          sizeBytes: apkLink.sizeBytes,
          savedPath: "Download/t3code/验证安装.apk",
        },
        reconnectedPhone,
      );
      expect(yield* readFileHandoff({ _tag: "list", threadId }, reconnectedPhone)).toMatchObject({
        transfers: expect.arrayContaining([
          expect.objectContaining({
            id: apk.id,
            disposition: "saved",
            outgoing: false,
            installRequested: true,
          }),
        ]),
      });
      expect(
        yield* Effect.result(readFileHandoff(report({ status: "failed" }), computerSession)),
      ).toMatchObject({ _tag: "Failure" });
      const checkApk = () => call("t3_thread_file_save_status", { id: apk.id });
      for (const status of ["failed", "cancelled"] as const) {
        yield* readFileHandoff(report({ status }), reconnectedPhone);
        expect((yield* checkApk()).structuredContent).toMatchObject({
          id: apk.id,
          status: "saved",
          installation: { status },
        });
      }
      const installed = {
        status: "verified",
        packageName: "com.example.fixture",
        version: "1.0",
        versionCode: "1",
      } as const;
      yield* readFileHandoff(report(installed), reconnectedPhone);
      yield* readFileHandoff(report(installed), reconnectedPhone);
      expect((yield* checkApk()).structuredContent).toMatchObject({
        id: apk.id,
        status: "saved",
        installation: installed,
      });
      expect((yield* decodeReceipt((yield* save(apkSource)).structuredContent)).id).toBe(apk.id);

      // 用合成图片完成一次本地伴侣任务，再将其作为原会话附件保存。
      const companion = yield* Effect.acquireRelease(
        Effect.sync(() => createCompanionStore(config.stateDir)),
        (store) => Effect.sync(() => store.close()),
      );
      const captureDevice = companion.enroll(companion.pair().code, "合成截图设备", {});
      const capture = companion.enqueue(threadId, captureDevice.deviceId, "screenshot", "once");
      expect(companion.poll(captureDevice.token, "合成截图设备", {}).job?.id).toBe(capture.id);
      const imageBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4X88AAAP/AX9v1mSAAAAAAElFTkSuQmCC";
      const originalPng = Buffer.from(imageBase64, "base64");
      companion.complete(captureDevice.token, {
        id: capture.id,
        status: "done",
        message: "合成原图",
        imageBase64,
      });
      const capturedPath = companion.result(threadId, capture.id).imagePath!;
      expect(Buffer.from(yield* fs.readFile(capturedPath))).toEqual(originalPng);
      const screenshotMessage = MessageId.make("original-screenshot");
      const screenshot: ChatAttachment = {
        type: "image",
        id: ChatAttachmentId.make(createDeterministicAttachmentId(threadId, capture.id)!),
        name: "原始截图.png",
        mimeType: "image/png",
        sizeBytes: originalPng.length,
      };
      const originalPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: screenshot,
      })!;
      yield* fs.copyFile(capturedPath, originalPath);
      const preview = yield* turn("给我看看刚才的截图");
      yield* writeMessage(
        screenshotMessage,
        "原始截图",
        "assistant",
        preview.time,
        threadId,
        clientAlias,
        "mobile",
        [screenshot],
      );
      const screenshotSource = {
        _tag: "attachment",
        messageId: screenshotMessage,
        attachmentId: screenshot.id,
      };
      expect((yield* save(screenshotSource)).isError).toBe(true);
      const remoteScreenshotMessage = MessageId.make("remote-screenshot");
      yield* writeMessage(
        remoteScreenshotMessage,
        "另一会话",
        "assistant",
        preview.time,
        otherThread,
        clientAlias,
        "mobile",
        [screenshot],
      );
      yield* turn("把刚才那张保存到这台电脑", computerAlias, "desktop");
      expect(
        (yield* save({ ...screenshotSource, messageId: remoteScreenshotMessage })).isError,
      ).toBe(true);
      const screenshotDelivery = yield* decodeReceipt(
        (yield* save(screenshotSource)).structuredContent,
      );
      expect(screenshotDelivery).toMatchObject({
        recipientLabel: "书房电脑",
        name: screenshot.name,
        status: "awaiting_save",
      });
      const screenshotId = screenshotDelivery.id;
      const originalSha = yield* digest.digestHex(Digest.sha256, originalPng);
      expect(yield* readFileHandoff({ _tag: "inbox" }, phoneSession)).toMatchObject({
        transfers: [],
      });
      expect(yield* readFileHandoff({ _tag: "inbox" }, computerSession)).toMatchObject({
        transfers: [expect.objectContaining({ threadId, id: screenshotId, sha256: originalSha })],
      });
      const screenshotLink = yield* receiveLink(screenshotId, computerSession);
      const screenshotResponse = yield* http.get(screenshotLink.relativeUrl);
      expect(screenshotResponse.status).toBe(200);
      expect(Buffer.from(yield* screenshotResponse.arrayBuffer)).toEqual(originalPng);
      const screenshotReceipt = {
        _tag: "confirmSaved" as const,
        threadId,
        id: screenshotId,
        sha256: originalSha,
        sizeBytes: originalPng.length,
        savedPath: "Downloads/原始截图.png",
      };
      expect(yield* Effect.result(readFileHandoff(screenshotReceipt, phoneSession))).toMatchObject({
        _tag: "Failure",
      });
      yield* readFileHandoff(screenshotReceipt, computerSession);
      expect(
        (yield* call("t3_thread_file_save_status", { id: screenshotId })).structuredContent,
      ).toMatchObject({
        status: "saved",
        savedPath: screenshotReceipt.savedPath,
      });
      expect(companion.list()[0]?.recentTasks).toMatchObject([
        {
          id: capture.id,
          action: "screenshot",
          status: "done",
        },
      ]);
      expect(Buffer.from(yield* fs.readFile(originalPath))).toEqual(originalPng);

      // 设备原件走受控端取件入口；手机先确认落盘，稍后才回报系统安装结果。
      const devices = yield* Effect.acquireRelease(
        Effect.sync(() => getCompanionStore(config.stateDir)),
        (store) => Effect.sync(() => store.close()),
      );
      const pc = devices.enroll(devices.pair().code, "书房电脑", {});
      const sourceJob = devices.enqueue(threadId, pc.deviceId, "send-file", "apk-source");
      expect(devices.poll(pc.token, "书房电脑", {}).job?.id).toBe(sourceJob.id);
      const fixtureApk = process.env.T3_HANDOFF_QA_APK;
      const payload = fixtureApk
        ? Buffer.from(yield* fs.readFile(fixtureApk))
        : Buffer.from("测试 APK 的传输夹具");
      const digestHex = yield* digest.digestHex(Digest.sha256, payload);
      devices.complete(pc.token, {
        id: sourceJob.id,
        status: "done",
        message: "已提供原件",
        file: { name: "测试.apk", data: payload.toString("base64"), sha256: digestHex },
      });
      yield* turn("从书房电脑把测试.apk发到这台手机并安装，装完告诉我结果。");
      const fromPc = { _tag: "companionFile", taskId: sourceJob.id };
      const transfer = yield* decodeReceipt((yield* save(fromPc)).structuredContent);
      expect(transfer).toMatchObject({ installRequested: true, status: "awaiting_save" });
      const downloadLink = yield* receiveLink(transfer.id, reconnectedPhone);
      const downloaded = yield* http.get(downloadLink.relativeUrl);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(yield* downloaded.arrayBuffer)).toEqual(payload);
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: transfer.id,
          sha256: digestHex,
          sizeBytes: payload.length,
          savedPath: "Download/t3code/测试.apk",
        },
        reconnectedPhone,
      );
      const laterReceipt = yield* call("t3_thread_file_save_status", {
        id: transfer.id,
        waitMs: 5000,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      // 即时查询已读到落盘回执时，等待安装的请求仍应留给手机的最终回执。
      const pendingInstall = yield* call("t3_thread_file_save_status", { id: transfer.id });
      expect(pendingInstall.structuredContent).toMatchObject({
        status: "saved",
        installRequested: true,
      });
      expect(pendingInstall.structuredContent).not.toHaveProperty("installation");
      expect(laterReceipt.pollUnsafe()).toBeUndefined();
      yield* readFileHandoff(
        {
          _tag: "reportInstall",
          threadId,
          id: transfer.id,
          sha256: digestHex,
          installation: installed,
        },
        reconnectedPhone,
      );
      expect((yield* Fiber.join(laterReceipt)).structuredContent).toMatchObject({
        id: transfer.id,
        status: "saved",
        installation: installed,
      });
      expect((yield* decodeReceipt((yield* save(fromPc)).structuredContent)).id).toBe(transfer.id);

      const archivedPath = yield* archiveCapture(threadId, capture.id, capturedPath, "png");
      yield* fs.remove(capturedPath);
      yield* turn("把刚才那张存到这台电脑", computerAlias, "desktop");
      const archivedResult = yield* save({ _tag: "companionScreenshot", taskId: capture.id });
      expect(archivedResult).toMatchObject({
        structuredContent: { status: "awaiting_save", recipientLabel: "书房电脑" },
      });
      const archivedDelivery = yield* decodeReceipt(archivedResult.structuredContent);
      expect(archivedDelivery).toMatchObject({
        recipientLabel: "书房电脑",
        status: "awaiting_save",
      });
      const archiveLink = yield* receiveLink(archivedDelivery.id, computerSession);
      const archiveResponse = yield* http.get(archiveLink.relativeUrl);
      expect(Buffer.from(yield* archiveResponse.arrayBuffer)).toEqual(originalPng);
      expect(Buffer.from(yield* fs.readFile(archivedPath))).toEqual(originalPng);
      yield* readFileHandoff({ ...screenshotReceipt, id: archivedDelivery.id }, computerSession);

      yield* turn("把 验证传输.txt 发到书房电脑或者手机");
      expect(
        (yield* save({ _tag: "workspaceOutput", path: "验证传输.txt" })).structuredContent,
      ).toMatchObject({ status: "choose_target" });

      const saveWorkspace = () => call("t3_thread_save_workspace_file", { path: "验证传输.txt" });
      expect((yield* saveWorkspace()).structuredContent).toMatchObject({ status: "choose_target" });
      const workspaceSource = { _tag: "workspaceOutput", path: "验证传输.txt" };

      yield* turn("把 验证传输.txt 发到书房电脑");
      yield* sessions.markConnected(computerSession.sessionId);
      const pendingWorkspace = yield* decodeReceipt((yield* saveWorkspace()).structuredContent);
      expect(pendingWorkspace).toMatchObject({
        recipientLabel: "书房电脑",
        status: "awaiting_save",
      });
      const linkWorkspace = yield* receiveLink(pendingWorkspace.id, computerSession);
      const workspaceBytes = yield* http.get(linkWorkspace.relativeUrl);
      expect(yield* workspaceBytes.text).toBe(bytes("验证传输.txt"));
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: pendingWorkspace.id,
          sha256: linkWorkspace.sha256,
          sizeBytes: linkWorkspace.sizeBytes,
        },
        computerSession,
      );
      expect((yield* saveWorkspace()).structuredContent).toMatchObject({
        id: pendingWorkspace.id,
        status: "saved",
      });

      yield* turn("把 验证传输.txt 保存到书房电脑");
      yield* sessions.markDisconnected(computerSession.sessionId);
      const offline = yield* decodeReceipt((yield* saveWorkspace()).structuredContent);
      expect(offline).toMatchObject({ recipientLabel: "书房电脑", status: "awaiting_save" });
      const offlineLink = yield* receiveLink(offline.id, computerSession);
      yield* readFileHandoff(
        {
          _tag: "confirmSaved",
          threadId,
          id: offline.id,
          sha256: offlineLink.sha256,
          sizeBytes: offlineLink.sizeBytes,
        },
        computerSession,
      );

      yield* turn("把 验证传输.txt 发到这台手机");
      const { id: redirectedId } = yield* decodeReceipt(
        (yield* save(workspaceSource)).structuredContent,
      );
      const simple = yield* call("t3_thread_save_workspace_file", { path: "验证传输.txt" });
      expect((yield* decodeReceipt(simple.structuredContent)).id).toBe(redirectedId);
      const oldLink = yield* receiveLink(redirectedId, phoneSession);
      const oldReceipt = {
        _tag: "confirmSaved" as const,
        threadId,
        id: redirectedId,
        sha256: oldLink.sha256,
        sizeBytes: oldLink.sizeBytes,
        savedPath: "Download/old.txt",
      };
      yield* turn("取消刚才那份了吗？");
      expect((yield* manage("cancel")).isError).toBe(true);
      yield* turn("取消不存在.txt");
      expect((yield* manage("cancel")).isError).toBe(true);
      yield* turn("取消生成任务");
      expect((yield* manage("cancel")).isError).toBe(true);
      yield* turn(`取消 ${redirectedId}`, computerAlias, "desktop");
      expect((yield* manage("cancel", { id: redirectedId })).isError).toBe(true);
      yield* turn("改发到书房电脑");
      expect(
        (yield* manage("redirect", { id: "00000000-0000-0000-0000-000000000000" })).isError,
      ).toBe(true);
      expect((yield* manage("redirect")).structuredContent).toMatchObject({
        id: redirectedId,
        recipientLabel: "书房电脑",
        status: "awaiting_save",
      });
      expect((yield* manage("redirect")).structuredContent).toMatchObject({ id: redirectedId });
      expect((yield* http.get(oldLink.relativeUrl)).status).toBe(404);
      expect(yield* readFileHandoff({ _tag: "inbox" }, phoneSession)).toMatchObject({
        transfers: [],
      });
      expect(yield* readFileHandoff({ _tag: "inbox" }, computerSession)).toMatchObject({
        transfers: [expect.objectContaining({ id: redirectedId })],
      });
      for (const session of [phoneSession, computerSession]) {
        expect(yield* Effect.result(readFileHandoff(oldReceipt, session))).toMatchObject({
          _tag: "Failure",
        });
      }
      const newLink = yield* receiveLink(redirectedId, computerSession);
      const download = yield* http.get(newLink.relativeUrl, { headers: { range: "bytes=0-3" } });
      expect(download.status).toBe(206);
      expect(Buffer.from(yield* download.arrayBuffer)).toEqual(
        Buffer.from(bytes("验证传输.txt")).subarray(0, 4),
      );
      yield* turn("取消刚才那份");
      expect((yield* manage("cancel")).structuredContent).toMatchObject({
        id: redirectedId,
        status: "awaiting_save",
        claimed: true,
      });
      yield* turn("改发到这台手机");
      expect((yield* manage("redirect")).structuredContent).toMatchObject({
        id: redirectedId,
        recipientLabel: "书房电脑",
        status: "awaiting_save",
        claimed: true,
      });
      yield* readFileHandoff({ ...oldReceipt, savedPath: "Downloads/new.txt" }, computerSession);
      yield* turn("取消刚才那份");
      expect((yield* manage("cancel")).structuredContent).toMatchObject({
        status: "saved",
        savedPath: "Downloads/new.txt",
      });

      yield* turn("把 验证传输.txt 发到这台手机");
      const { id: cancelledId } = yield* decodeReceipt(
        (yield* save(workspaceSource)).structuredContent,
      );
      const cancelledLink = yield* receiveLink(cancelledId, phoneSession);
      yield* turn("取消刚才那份");
      for (let attempt = 0; attempt < 2; attempt++) {
        expect((yield* manage("cancel")).structuredContent).toMatchObject({
          id: cancelledId,
          status: "cancelled",
        });
      }
      expect((yield* http.get(cancelledLink.relativeUrl)).status).toBe(404);
      expect(yield* readFileHandoff({ _tag: "inbox" }, phoneSession)).toMatchObject({
        transfers: [],
      });

      yield* turn("把 验证传输.txt 发到这台手机");
      const { id: racedId } = yield* decodeReceipt(
        (yield* save(workspaceSource)).structuredContent,
      );
      const racedLink = yield* receiveLink(racedId, phoneSession);
      yield* turn("取消刚才那份");
      const [racedDownload] = yield* Effect.all(
        [http.get(racedLink.relativeUrl), manage("cancel")],
        { concurrency: "unbounded" },
      );
      const settled = yield* manage("cancel");
      if (racedDownload.status === 200) {
        expect(yield* racedDownload.text).toBe(bytes("验证传输.txt"));
        expect(settled.structuredContent).toMatchObject({
          id: racedId,
          status: "awaiting_save",
          claimed: true,
        });
      } else {
        expect([404, 409]).toContain(racedDownload.status);
        expect(settled.structuredContent).toMatchObject({ id: racedId, status: "cancelled" });
      }

      const secondDesktop = yield* sessions.issue({
        subject: "owner",
        method: "bearer-access-token",
        scopes,
        client: { deviceType: "desktop", label: "书房电脑" },
      });
      const secondComputerSession = yield* sessions.verify(secondDesktop.token);
      const choosing = yield* turn("把 验证传输.txt 发到书房电脑");
      const decodeSave = Schema.decodeUnknownEffect(
        ThreadFileSaveToolkit.tools.t3_thread_file_save.successSchema,
      );
      const destinations = yield* decodeSave((yield* save(workspaceSource)).structuredContent);
      if (destinations.status !== "choose_target")
        return yield* Effect.die("Expected device choices.");
      const sameName = destinations.devices.filter(({ label }) => label.startsWith("书房电脑 · "));
      expect(new Set(sameName.map(({ label }) => label)).size).toBe(2);
      const selected = sameName[0]!.label;
      expect((yield* save(workspaceSource, selected)).structuredContent).toMatchObject({
        status: "choose_target",
      });
      const requestId = RuntimeRequestId.make("choose-file-device");
      const nodeId = NodeId.make("file-save-root");
      yield* apply({
        type: "turn-item.updated",
        threadId,
        runId: choosing.id,
        occurredAt: choosing.time,
        payload: {
          id: TurnItemId.make("file-save-device-options"),
          threadId,
          runId: choosing.id,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: choosing.time,
          completedAt: choosing.time,
          updatedAt: choosing.time,
          type: "user_input_request",
          requestId,
          questions: [
            {
              id: "t3-file-save-target",
              header: "设备",
              question: "请选择接收文件的设备。",
              options: sameName.map(({ label }) => ({ label, description: "书房电脑" })),
            },
          ],
        },
      } as never);
      yield* apply({
        type: "runtime-request.updated",
        threadId,
        runId: choosing.id,
        nodeId,
        occurredAt: choosing.time,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "resolved",
          responseCapability: { type: "message" },
          createdAt: choosing.time,
          resolvedAt: choosing.time,
          answers: { "t3-file-save-target": selected },
        },
      } as never);
      expect((yield* save(workspaceSource, sameName[1]!.label)).structuredContent).toMatchObject({
        status: "choose_target",
      });
      const { id: matchedId } = yield* decodeReceipt(
        (yield* save(workspaceSource, selected)).structuredContent,
      );
      const matched = yield* Effect.forEach([computerSession, secondComputerSession], (session) =>
        readFileHandoff({ _tag: "inbox" }, session).pipe(
          Effect.map(
            (reply) => reply._tag === "inbox" && reply.transfers.some(({ id }) => id === matchedId),
          ),
        ),
      );
      expect(matched).toContain(true);
      expect(matched).toContain(false);
      yield* turn("把 outside.txt 发到这台手机");
      expect((yield* save({ _tag: "workspaceOutput", path: "../outside.txt" })).isError).toBe(true);
      expect((yield* save({ _tag: "workspaceOutput", path: "outside.txt" })).isError).toBe(true);
    }).pipe(Effect.provide(support)),
);
