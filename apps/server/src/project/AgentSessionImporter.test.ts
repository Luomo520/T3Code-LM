// @effect-diagnostics processEnvInEffect:off - opt-in read-only local evidence test uses an explicit environment gate.
// @effect-diagnostics nodeBuiltinImport:off - opt-in read-only real history verification and evidence output.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AgentSessionSource,
  type ServerSettingsError,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  RunId,
  ThreadId,
  type ApplicationStoredEvent,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  CLAUDE_MODEL_SELECTION,
  CODEX_MODEL_SELECTION,
} from "../orchestration-v2/testkit/fixtures/shared.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { makeCodexLocalSync } from "./CodexLocalSync.ts";
import * as LocalHistory from "./CodexLocalHistory.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "@effect/platform-node/NodePath";
import { vi } from "@effect/vitest";
import * as ProjectService from "./ProjectService.ts";

const projectId = ProjectId.make("agent-session-import-project");
const timestamp = "2026-09-01T10:00:00.000Z";
const now = DateTime.makeUnsafe(timestamp);
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const persistence = Layer.mergeAll(
  stores,
  EventSink.layer.pipe(Layer.provide(stores)),
  ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  IdAllocator.layer,
);

function candidate(
  modelSelection: typeof CODEX_MODEL_SELECTION,
  providerSessionId: string,
  provider: AgentSessionSource = "codex",
) {
  const providerInstanceId = modelSelection.instanceId;
  return {
    _tag: "Importable" as const,
    source: {
      provider,
      providerInstanceId,
      providerSessionId,
      filePath: `/tmp/${providerInstanceId}/${providerSessionId}.jsonl`,
      size: 100,
      mtimeMs: 2,
      device: 3,
      inode: 4,
      birthtimeMs: 1,
    },
    thread: {
      source: provider,
      providerInstanceId,
      providerSessionId,
      title: "Imported thread",
      model: modelSelection.model,
      createdAt: timestamp,
      updatedAt: timestamp,
      omittedMessageCount: 0,
      messages: [
        { role: "user" as const, text: "Fix it", createdAt: timestamp },
        { role: "assistant" as const, text: "Fixed", createdAt: timestamp },
      ],
    },
    worktree: null as { path: string; branch: string | null } | null,
  } satisfies AgentSessionScanner.AgentSessionRecentThread;
}

const PI_MODEL_SELECTION = { instanceId: ProviderInstanceId.make("pi"), model: "default" };

// Pi threads are owned by their session file path, not the session UUID.
const nativeId = ({ source }: ReturnType<typeof candidate>) =>
  source.provider === "pi" ? source.filePath : source.providerSessionId;

function importId(source: ReturnType<typeof candidate>) {
  return ThreadId.make(
    `import:${source.source.providerInstanceId}:${source.source.providerSessionId}`,
  );
}

const seedOwner = Effect.fn(function* (
  source: ReturnType<typeof candidate>,
  lifecycle: "active" | "archived" | "deleted" = "active",
) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const { providerInstanceId, providerSessionId, provider } = source.source;
  const nativeThreadId = nativeId(source);
  const threadId = ThreadId.make(`owner:${providerInstanceId}:${providerSessionId}`);
  const driver = ProviderDriverKind.make(provider);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ids.derive.providerThread({ driver, nativeThreadId }),
    driver,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: { driver, nativeId: nativeThreadId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Native thread",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: source.thread.model },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: lifecycle === "archived" ? now : null,
    deletedAt: lifecycle === "deleted" ? now : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  };
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${threadId}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      },
      {
        id: EventId.make(`${threadId}:provider`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: providerThread,
      },
    ],
  });
  return threadId;
});

const makeImporter = Effect.fn(function* (
  candidates: ReadonlyArray<ReturnType<typeof candidate>>,
  beforeTransaction: Effect.Effect<void> = Effect.void,
  getAdapter?: ProviderAdapterRegistry.ProviderAdapterRegistryV2Shape["get"],
  threadCommands?: KeyedLock.KeyedLock<ThreadId>,
  settings: Layer.Layer<
    ServerSettings.ServerSettingsService,
    ServerSettingsError
  > = ServerSettings.layerTest(),
  realScan?: {
    readonly workspaceRoot: string;
    readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const published: Array<ApplicationStoredEvent> = [];
  const withTransaction: typeof sql.withTransaction = (effect) =>
    beforeTransaction.pipe(Effect.andThen(sql.withTransaction(effect)));
  const importSql = new Proxy(sql, {
    get: (target, key, receiver) =>
      key === "withTransaction" ? withTransaction : Reflect.get(target, key, receiver),
  });
  const sinkLayer = Layer.fresh(EventSink.layer).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(SqlClient.SqlClient, importSql),
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
        Layer.succeed(EventStore.EventStoreV2, {
          ...events,
          publishCommitted: (batch) =>
            events.publishCommitted(batch).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  published.push(...batch);
                }),
              ),
            ),
        }),
      ),
    ),
  );
  const context = yield* Layer.build(
    AgentSessionImporter.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          sinkLayer,
          settings,
          Layer.succeed(IdAllocator.IdAllocatorV2, yield* IdAllocator.IdAllocatorV2),
          Layer.succeed(
            ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
          ),
          realScan === undefined
            ? Layer.mock(AgentSessionScanner.AgentSessionScanner)({
                recentThreads: () => Stream.fromIterable(candidates),
              })
            : Layer.succeed(AgentSessionScanner.AgentSessionScanner, realScan.scanner),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Project",
                workspaceRoot: realScan?.workspaceRoot ?? "/workspace/project",
                defaultModelSelection: null,
                scripts: [],
                createdAt: timestamp,
                updatedAt: timestamp,
                deletedAt: null,
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: (threadId, fields) =>
              projections
                .getThreadRecords(threadId, fields)
                .pipe(
                  Effect.mapError(
                    (cause) => new Orchestrator.OrchestratorProjectionError({ threadId, cause }),
                  ),
                ),
          }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)(
            getAdapter === undefined ? {} : { get: getAdapter },
          ),
          Layer.succeed(
            ThreadCommandExecutor.ThreadCommandExecutor,
            threadCommands ?? (yield* KeyedLock.make<ThreadId>()),
          ),
        ),
      ),
    ),
  );
  const importer = Context.get(context, AgentSessionImporter.AgentSessionImporter);
  return { run: importer.importRecentAgentThreads({ projectId }), importNativeHistory: importer.importNativeHistory, published, context, importer };
});

const titleSyncFixture = Effect.fn(function* () {
  const source = candidate(CODEX_MODEL_SELECTION, "title-repair");
  source.thread.title = "[Image: shot.jpg; ref=image_1]";
  const id = importId(source);
  const helper = yield* makeImporter([source]);
  yield* helper.run;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const row = {
    id: "title-repair",
    cwd: "/workspace/project",
    name: null,
    title: "[Image: shot.jpg; ref=image_1]\n修复安卓构建和启动报错",
    first_user_message: "修复安卓构建和启动报错",
    model: source.thread.model,
    created_at: 1,
    updated_at: 2,
    history_mode: "paginated",
  };
  let busy = false;
  let beforeWrite = Effect.void;
  const makeSync = makeCodexLocalSync.pipe(
    Effect.provide(helper.context),
    Effect.provideService(EventSink.EventSinkV2, {
      ...sink,
      write: (input) =>
        Effect.gen(function* () {
          const race = beforeWrite;
          beforeWrite = Effect.void;
          yield* race;
          return yield* sink.write(input);
        }),
    }),
    Effect.provideService(Orchestrator.OrchestratorV2, {
      getThreadRecords: (threadId: ThreadId) =>
        projections
          .getThreadRecords(threadId, ["messages", "runs", "turnItems", "providerThreads"])
          .pipe(
            Effect.map((p) =>
              busy ? { ...p, messages: p.messages.map((m) => ({ ...m, streaming: true })) } : p,
            ),
          ),
    } as unknown as Orchestrator.OrchestratorV2["Service"]),
    Effect.provideService(ProjectStore.ProjectStoreV2, {
      list: () => Effect.succeed([{ projectId, workspaceRoot: "/workspace/project" }]),
    } as unknown as ProjectStore.ProjectStoreV2["Service"]),
    Effect.provideService(ServerSettings.ServerSettingsService, {
      getSettings: Effect.succeed({
        providerInstances: { codex: { driver: "codex", config: { homePath: "/fake-codex" } } },
      }),
    } as unknown as ServerSettings.ServerSettingsService["Service"]),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    Effect.provide(NodePath.layer),
  );
  const setThread = Effect.fn(function* (patch: Partial<OrchestrationV2AppThread>) {
    const thread = yield* projections.getThread(id);
    const sequence = yield* sink.latestSequence({ threadId: id });
    yield* sink.write({
      events: [
        {
          id: EventId.make(`fixture-metadata:${sequence}`),
          type: "thread.metadata-updated",
          threadId: id,
          occurredAt: now,
          payload: { ...thread, ...patch },
        },
      ],
    });
  });
  return {
    id,
    source,
    row,
    projections,
    makeSync,
    setThread,
    setBusy: (value: boolean) => {
      busy = value;
    },
    race: (effect: Effect.Effect<void>) => {
      beforeWrite = effect;
    },
  };
});

it.effect("syncs known import archives and restores only its own archives across restarts", () =>
  Effect.gen(function* () {
    const f = yield* titleSyncFixture();
    using catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([]);
    using _version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("same");
    using states = vi
      .spyOn(LocalHistory, "readLocalCodexArchiveStates")
      .mockResolvedValue([{ id: f.row.id, archived: 1, archived_at: 1 }]);
    const sink = yield* EventSink.EventSinkV2;
    const tick = yield* f.makeSync;
    yield* tick;
    const archived = yield* f.projections.getThread(f.id);
    expect(archived.archivedAt).not.toBeNull();
    const sequence = yield* sink.latestSequence({ threadId: f.id });
    catalog.mockResolvedValue([f.row]);
    yield* tick;
    expect(yield* sink.latestSequence({ threadId: f.id })).toBe(sequence);
    states.mockResolvedValue([{ id: f.row.id, archived: 0, archived_at: null }]);
    const restarted = yield* f.makeSync;
    yield* restarted;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
    yield* f.setThread({ archivedAt: now });
    yield* restarted;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toEqual(now);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not infer archives from empty, missing, failed, or unrelated source results", () =>
  Effect.gen(function* () {
    const f = yield* titleSyncFixture();
    using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([]);
    using states = vi.spyOn(LocalHistory, "readLocalCodexArchiveStates").mockResolvedValue([]);
    const tick = yield* f.makeSync;
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
    states.mockRejectedValue(new Error("source unavailable"));
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
    states.mockResolvedValue([{ id: "different-native-id", archived: 1, archived_at: 1 }]);
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "preserves ordinary T3 threads and imported threads with another active native owner",
  () =>
    Effect.gen(function* () {
      const f = yield* titleSyncFixture();
      using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([]);
      using states = vi
        .spyOn(LocalHistory, "readLocalCodexArchiveStates")
        .mockResolvedValue([{ id: f.row.id, archived: 1, archived_at: 1 }]);
      const tick = yield* f.makeSync;
      yield* f.setThread({ historyOrigin: undefined });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
      expect(states).toHaveBeenLastCalledWith(expect.any(String), []);
      yield* f.setThread({ historyOrigin: "v1_import", activeProviderThreadId: null });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
      expect(states).toHaveBeenLastCalledWith(expect.any(String), []);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("defers busy imports and rejects racing archive or restore writes", () =>
  Effect.gen(function* () {
    const f = yield* titleSyncFixture();
    using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([]);
    using states = vi
      .spyOn(LocalHistory, "readLocalCodexArchiveStates")
      .mockResolvedValue([{ id: f.row.id, archived: 1, archived_at: 1 }]);
    const tick = yield* f.makeSync;
    f.setBusy(true);
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
    f.setBusy(false);
    f.race(f.setThread({ title: "Concurrent user metadata" }).pipe(Effect.orDie));
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toBeNull();
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).not.toBeNull();
    states.mockResolvedValue([{ id: f.row.id, archived: 0, archived_at: null }]);
    const manualArchiveAt = DateTime.add(now, { seconds: 1 });
    f.race(f.setThread({ archivedAt: manualArchiveAt }).pipe(Effect.orDie));
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toEqual(manualArchiveAt);
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).archivedAt).toEqual(manualArchiveAt);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "repairs only a bad imported title despite an unfinished Codex turn and retries empty history",
  () =>
    Effect.gen(function* () {
      const f = yield* titleSyncFixture();
      using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([f.row]);
      using _version = vi
        .spyOn(LocalHistory, "readLocalCodexVersion")
        .mockResolvedValue("unchanged");
      using messages = vi.spyOn(LocalHistory, "readLocalCodexMessages").mockImplementation(() => {
        throw new Error("Codex turn is still active");
      });
      const tick = yield* f.makeSync;
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe("修复安卓构建和启动报错");
      expect(
        (yield* f.projections.getThreadRecords(f.id, ["messages"])).messages.map((m) => m.text),
      ).toEqual(["Fix it", "Fixed"]);
      messages.mockReturnValue([]);
      yield* tick;
      yield* tick;
      expect(messages).toHaveBeenCalledTimes(3);
      messages.mockReturnValue([
        ...f.source.thread.messages.map((m, i) => ({ ...m, nativeId: String(i) })),
        { role: "user", text: "Persisted later", createdAt: timestamp, nativeId: "u3" },
      ]);
      yield* tick;
      expect((yield* f.projections.getThreadRecords(f.id, ["messages"])).messages).toHaveLength(3);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("repairs bad titles with divergent history while preserving meaningful titles", () =>
  Effect.gen(function* () {
    const f = yield* titleSyncFixture();
    using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([f.row]);
    using _version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("same");
    using _messages = vi
      .spyOn(LocalHistory, "readLocalCodexMessages")
      .mockReturnValue([{ role: "user", text: "Diverged", createdAt: timestamp, nativeId: "u1" }]);
    const tick = yield* f.makeSync;
    yield* tick;
    expect((yield* f.projections.getThread(f.id)).title).toBe("修复安卓构建和启动报错");
    expect((yield* f.projections.getThreadRecords(f.id, ["messages"])).messages).toHaveLength(2);
    yield* f.setThread({ title: "A meaningful existing title" });
    yield* yield* f.makeSync;
    expect((yield* f.projections.getThread(f.id)).title).toBe("A meaningful existing title");
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "defers title repair while T3 is busy, archived, deleted, manually edited, or not imported",
  () =>
    Effect.gen(function* () {
      const f = yield* titleSyncFixture();
      using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([f.row]);
      using _version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("same");
      using _messages = vi.spyOn(LocalHistory, "readLocalCodexMessages").mockReturnValue([]);
      const tick = yield* f.makeSync;
      f.setBusy(true);
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe(f.source.thread.title);
      f.setBusy(false);
      yield* f.setThread({ archivedAt: now });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe(f.source.thread.title);
      yield* f.setThread({ archivedAt: null, deletedAt: now });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe(f.source.thread.title);
      yield* f.setThread({ deletedAt: null, historyOrigin: undefined });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe(f.source.thread.title);
      yield* f.setThread({ historyOrigin: "v1_import" });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error)
      VALUES ('manual-title-repair','thread',${f.id},'thread.metadata.update',${timestamp},1,'accepted',NULL)`;
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe(f.source.thread.title);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "rejects a title repair racing a metadata event and retries without caching history",
  () =>
    Effect.gen(function* () {
      const f = yield* titleSyncFixture();
      using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([f.row]);
      using _version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("same");
      using _messages = vi.spyOn(LocalHistory, "readLocalCodexMessages").mockReturnValue([]);
      const tick = yield* f.makeSync;
      f.race(f.setThread({ title: "Manually chosen concurrent title" }).pipe(Effect.orDie));
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe("Manually chosen concurrent title");
      yield* f.setThread({ title: "Codex conversation" });
      yield* tick;
      expect((yield* f.projections.getThread(f.id)).title).toBe("修复安卓构建和启动报错");
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("falls back to a matching rollout when paginated history is a different branch", () =>
  Effect.gen(function* () {
    const f = yield* titleSyncFixture();
    const row = { ...f.row, rollout_path: "/fake-codex/session.jsonl" };
    using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([row]);
    using _version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("unchanged");
    using _messages = vi.spyOn(LocalHistory, "readLocalCodexMessages").mockReturnValue([
      {
        role: "user",
        text: "Different paginated branch",
        nativeId: "wrong",
        createdAt: timestamp,
      },
    ]);
    using rollout = vi.spyOn(LocalHistory, "readLocalCodexRollout").mockResolvedValue([
      ...f.source.thread.messages.map((m, i) => ({ ...m, nativeId: String(i) })),
      {
        role: "assistant",
        text: "Screenshot final reply",
        nativeId: "final",
        createdAt: timestamp,
      },
    ]);
    const tick = yield* f.makeSync;
    yield* tick;
    yield* tick;
    expect(
      (yield* f.projections.getThreadRecords(f.id, ["messages"])).messages.map((m) => m.text),
    ).toEqual(["Fix it", "Fixed", "Screenshot final reply"]);
    expect(rollout).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "caches divergent rollout fingerprints but retries changes and rejected idle commits",
  () =>
    Effect.gen(function* () {
      const f = yield* titleSyncFixture();
      yield* f.setThread({ title: "Meaningful title" });
      using _catalog = vi
        .spyOn(LocalHistory, "readLocalCodexCatalog")
        .mockResolvedValue([{ ...f.row, rollout_path: "/fake-codex/session.jsonl" }]);
      using version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("v1");
      using _messages = vi
        .spyOn(LocalHistory, "readLocalCodexMessages")
        .mockReturnValue([
          { role: "user", text: "Other branch", nativeId: "other", createdAt: timestamp },
        ]);
      using rollout = vi
        .spyOn(LocalHistory, "readLocalCodexRollout")
        .mockResolvedValue([
          { role: "user", text: "Unrelated rollout", nativeId: "bad", createdAt: timestamp },
        ]);
      const tick = yield* f.makeSync;
      yield* tick;
      yield* tick;
      expect(rollout).toHaveBeenCalledTimes(1);
      version.mockResolvedValue("v2");
      rollout.mockResolvedValue([
        ...f.source.thread.messages.map((m, i) => ({ ...m, nativeId: String(i) })),
        { role: "assistant", text: "Safe final", nativeId: "final", createdAt: timestamp },
      ]);
      f.race(f.setThread({ title: "Concurrent user rename" }).pipe(Effect.orDie));
      yield* tick;
      expect((yield* f.projections.getThreadRecords(f.id, ["messages"])).messages).toHaveLength(2);
      yield* tick;
      expect((yield* f.projections.getThreadRecords(f.id, ["messages"])).messages).toHaveLength(3);
      expect((yield* f.projections.getThread(f.id)).title).toBe("Concurrent user rename");
      yield* tick;
      expect(rollout).toHaveBeenCalledTimes(3);
      version.mockImplementation(async (_home, _path, onlyRollout) =>
        onlyRollout ? "v2" : "unrelated-history-update",
      );
      yield* tick;
      expect(rollout).toHaveBeenCalledTimes(3);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

if (process.env.T3_JK_VERIFY_REPORT)
  it.effect(
    "verifies real JK rollout through isolated application events",
    () =>
      Effect.gen(function* () {
        const nativeId = "01a152fe-5bc2-7523-8b19-51d7a8b8c4df";
        const catalogDb = new DatabaseSync(join(homedir(), ".codex/state_5.sqlite"), {
          readOnly: true,
        });
        const liveDb = new DatabaseSync(join(homedir(), ".t3/userdata/statev2.sqlite"), {
          readOnly: true,
        });
        let row: LocalHistory.LocalCodexThread;
        let prefix: Array<{ role: "user" | "assistant"; text: string; createdAt: string }>;
        try {
          row = catalogDb
            .prepare("SELECT * FROM threads WHERE id=?")
            .get(nativeId) as unknown as LocalHistory.LocalCodexThread;
          prefix = liveDb
            .prepare(`SELECT m.role,m.created_at,m.payload_json FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_turn_items ti ON json_extract(ti.payload_json,'$.messageId')=m.message_id AND ti.thread_id=m.thread_id
        WHERE m.thread_id=? ORDER BY ti.ordinal,m.created_at,m.message_id`)
            .all("import:codex:" + nativeId)
            .map((r) => ({
              role: r.role as "user" | "assistant",
              text: JSON.parse(String(r.payload_json)).text,
              createdAt: String(r.created_at),
            }));
        } finally {
          catalogDb.close();
          liveDb.close();
        }
        const expected = yield* Effect.promise(() => LocalHistory.readLocalCodexRollout(row));
        const source = candidate(CODEX_MODEL_SELECTION, nativeId);
        source.thread.messages = prefix;
        const helper = yield* makeImporter([source]);
        yield* helper.run;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        using _catalog = vi.spyOn(LocalHistory, "readLocalCodexCatalog").mockResolvedValue([row]);
        const tick = yield* makeCodexLocalSync.pipe(
          Effect.provide(helper.context),
          Effect.provideService(Orchestrator.OrchestratorV2, {
            getThreadRecords: (id: ThreadId) =>
              projections.getThreadRecords(id, [
                "messages",
                "turnItems",
                "runs",
                "providerThreads",
              ]),
          } as unknown as Orchestrator.OrchestratorV2["Service"]),
          Effect.provideService(ProjectStore.ProjectStoreV2, {
            list: () => Effect.succeed([{ projectId, workspaceRoot: row.cwd }]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
          Effect.provideService(ServerSettings.ServerSettingsService, {
            getSettings: Effect.succeed({
              providerInstances: {
                codex: { driver: "codex", config: { homePath: join(homedir(), ".codex") } },
              },
            }),
          } as unknown as ServerSettings.ServerSettingsService["Service"]),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, homedir()),
          Effect.provide(NodePath.layer),
        );
        yield* tick;
        yield* tick;
        const actual = (yield* projections.getThreadRecords(importId(source), [
          "messages",
          "turnItems",
        ])).messages;
        const hash = (messages: ReadonlyArray<{ role: string; text: string }>) =>
          createHash("sha256")
            .update(JSON.stringify(messages.map((m) => [m.role, m.text])))
            .digest("hex");
        const expectedHash = hash(expected),
          actualHash = hash(actual);
        const last = expected.at(-1)!;
        const result = {
          verifiedAt: DateTime.formatIso(yield* DateTime.now),
          mode: "isolated-application-events",
          readOnlyNative: true,
          realT3DatabaseWritten: false,
          nativeId,
          initialMessages: prefix.length,
          expectedMessages: expected.length,
          actualMessages: actual.length,
          appended: actual.length - prefix.length,
          orderedContentHashMatches: actualHash === expectedHash,
          expectedSha256: expectedHash,
          actualSha256: actualHash,
          screenshotNativeItemId: last.nativeId,
          screenshotLastReplyMatches:
            last.nativeId === "msg_07c723b2c5fc8a4b016ae3817528a487d287af15cf8185bc3c" &&
            actual.at(-1)?.text === last.text,
          noBodiesOrSecretsPersisted: true,
        };
        yield* Effect.promise(() =>
          writeFile(
            process.env.T3_JK_VERIFY_REPORT!,
            JSON.stringify(result, null, 2) + "\n",
            "utf8",
          ),
        );
        expect(expected.length).toBe(815);
        expect(actual.length).toBe(815);
        expect(actualHash).toBe(expectedHash);
        expect(result.screenshotLastReplyMatches).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(persistence)),
    30_000,
  );

it.effect(
  "syncs a missing paginated conversation, then appends once and preserves a manual title after restart",
  () =>
    Effect.gen(function* () {
      const source = candidate(CODEX_MODEL_SELECTION, "local-sync");
      const id = importId(source);
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const helper = yield* makeImporter([]);
      let busy = false;
      const providerInstances = {
        codex: { driver: "codex", config: { homePath: "/fake-codex" } },
      } as Record<string, { driver: string; config: { homePath: string } }>;
      const row = {
        id: "local-sync",
        cwd: "/workspace/project",
        name: "JK BMS display",
        title: "继续",
        first_user_message: "Fix it",
        model: source.thread.model,
        created_at: 1,
        updated_at: 2,
        history_mode: "paginated",
      };
      using catalog = vi
        .spyOn(LocalHistory, "readLocalCodexCatalog")
        .mockImplementation(async () => [row]);
      using version = vi.spyOn(LocalHistory, "readLocalCodexVersion").mockResolvedValue("initial");
      using messages = vi
        .spyOn(LocalHistory, "readLocalCodexMessages")
        .mockReturnValue(source.thread.messages.map((m, i) => ({ ...m, nativeId: String(i) })));
      const makeSync = makeCodexLocalSync.pipe(
        Effect.provide(helper.context),
        Effect.provideService(Orchestrator.OrchestratorV2, {
          getThreadRecords: (id: ThreadId) =>
            projections
              .getThreadRecords(id, ["messages", "runs", "turnItems", "providerThreads"])
              .pipe(
                Effect.map((p) =>
                  busy ? { ...p, messages: p.messages.map((m) => ({ ...m, streaming: true })) } : p,
                ),
              ),
        } as unknown as Orchestrator.OrchestratorV2["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          list: () => Effect.succeed([{ projectId, workspaceRoot: "/workspace/project" }]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ServerSettings.ServerSettingsService, {
          getSettings: Effect.succeed({ providerInstances }),
        } as unknown as ServerSettings.ServerSettingsService["Service"]),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
        Effect.provide(NodePath.layer),
      );
      const tick = yield* makeSync;
      yield* sql`CREATE TEMP TRIGGER fail_local_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT,'test interrupted local runtime'); END`;
      yield* tick;
      const initial = yield* projections.getThreadRecords(id, ["messages"]);
      expect(initial.thread.title).toBe("JK BMS display");
      expect(initial.thread.settledOverride).toBe("active");
      expect(initial.messages).toHaveLength(2);
      expect(
        yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id=${id}`,
      ).toHaveLength(0);
      yield* sql`DROP TRIGGER fail_local_runtime`;
      yield* tick;
      expect(
        yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id=${id}`,
      ).toHaveLength(1);
      // History can commit after the state row, without advancing its second-resolution timestamp.
      version.mockResolvedValue("history-commit-2");
      const next = [
        ...source.thread.messages.map((m, i) => ({ ...m, nativeId: String(i) })),
        {
          role: "user" as const,
          text: "Next",
          createdAt: "2026-09-01T09:59:00.000Z",
          nativeId: "u3",
        },
      ];
      messages.mockReturnValue(next);
      busy = true;
      yield* tick;
      expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toHaveLength(2);
      busy = false;
      yield* tick;
      yield* tick;
      expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toHaveLength(3);
      version.mockResolvedValue("history-commit-3");
      messages.mockReturnValue([
        ...next,
        { role: "assistant", text: "Next completed", createdAt: timestamp, nativeId: "a4" },
      ]);
      yield* tick;
      yield* tick;
      expect(
        (yield* projections.getThreadRecords(id, ["messages"])).messages.map((m) => m.text),
      ).toEqual(["Fix it", "Fixed", "Next", "Next completed"]);
      for (const title of ["Codex renamed", "JK BMS display", "Codex renamed", "JK BMS display"]) {
        row.name = title;
        yield* tick;
        expect((yield* projections.getThread(id)).title).toBe("JK BMS display");
      }
      yield* sql`INSERT INTO orchestration_command_receipts (command_id,aggregate_kind,aggregate_id,command_type,accepted_at,result_sequence,status,error)
      VALUES ('rename-manual','thread',${id},'thread.metadata.update',${timestamp},1,'accepted',NULL)`;
      row.name = "New Codex name";
      const restarted = yield* makeSync;
      yield* restarted;
      expect((yield* projections.getThreadRecords(id, ["messages"])).thread.title).toBe(
        "JK BMS display",
      );
      expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toHaveLength(4);
      const sink = yield* EventSink.EventSinkV2;
      const active = yield* projections.getThread(id);
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-local-sync"),
            type: "thread.metadata-updated",
            threadId: id,
            occurredAt: now,
            payload: { ...active, archivedAt: now },
          },
        ],
      });
      version.mockResolvedValue("history-commit-4");
      messages.mockReturnValue([
        ...next,
        { role: "assistant", text: "Next completed", createdAt: timestamp, nativeId: "a4" },
        { role: "user", text: "After reopen", createdAt: timestamp, nativeId: "u5" },
      ]);
      yield* tick;
      expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toHaveLength(4);
      yield* sink.write({
        events: [
          {
            id: EventId.make("unarchive-local-sync"),
            type: "thread.metadata-updated",
            threadId: id,
            occurredAt: now,
            payload: { ...active, archivedAt: null },
          },
        ],
      });
      yield* tick;
      expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toHaveLength(5);
      // Ownership includes tombstones: a deleted or archived native session must
      // never be re-imported as a second visible thread.
      for (const lifecycle of ["archived", "deleted"] as const) {
        const owner = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, lifecycle), lifecycle);
        catalog.mockResolvedValue([{ ...row, id: lifecycle }]);
        const again = yield* makeSync;
        yield* again;
        expect((yield* projections.getThread(owner)).id).toBe(owner);
        expect(
          yield* Effect.option(projections.getThread(ThreadId.make(`import:codex:${lifecycle}`))),
        ).toEqual(Option.none());
      }
      providerInstances["codex-other"] = { driver: "codex", config: { homePath: "/fake-codex" } };
      const other = candidate(
        { ...CODEX_MODEL_SELECTION, instanceId: ProviderInstanceId.make("codex-other") },
        "shared-home",
      );
      const owner = yield* seedOwner(other);
      catalog.mockResolvedValue([{ ...row, id: "shared-home" }]);
      yield* yield* makeSync;
      expect((yield* projections.getThread(owner)).id).toBe(owner);
      expect(
        yield* Effect.option(projections.getThread(ThreadId.make("import:codex:shared-home"))),
      ).toEqual(Option.none());
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rejects a stale history merge atomically", () =>
  Effect.gen(function* () {
    const source = candidate(CODEX_MODEL_SELECTION, "guard");
    const helper = yield* makeImporter([source]);
    yield* helper.run;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const id = importId(source);
    const before = yield* projections.getThreadRecords(id, ["messages"]);
    const result = yield* sink.write({
      guardIdleThread: { threadId: id, updatedAt: DateTime.makeUnsafe(0), messageCount: 2 },
      events: AgentSessionImporter.messageEvents({
        threadId: id,
        index: 2,
        message: { role: "user", text: "Stale", createdAt: timestamp },
      }),
    });
    expect(result).toHaveLength(0);
    expect((yield* projections.getThreadRecords(id, ["messages"])).messages).toEqual(
      before.messages,
    );
    const sequence = yield* sink.latestSequence({ threadId: id });
    yield* sink.write({
      events: AgentSessionImporter.messageEvents({
        threadId: id,
        index: 1,
        message: { role: "assistant", text: "Changed concurrently", createdAt: timestamp },
      }).map((event) => ({ ...event, id: EventId.make(`edit:${event.id}`) })),
    });
    const guarded = yield* sink.write({
      guardIdleThread: {
        threadId: id,
        updatedAt: before.thread.updatedAt,
        messageCount: 2,
        sequence,
      },
      events: AgentSessionImporter.messageEvents({
        threadId: id,
        index: 2,
        message: { role: "user", text: "Stale", createdAt: timestamp },
      }),
    });
    expect(guarded).toHaveLength(0);
    expect(
      (yield* projections.getThreadRecords(id, ["messages"])).messages.map((m) => m.text),
    ).toEqual(["Fix it", "Changed concurrently"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "ignores owned sessions, including archived and deleted threads, but imports other instances and unowned sessions",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const active = candidate(CODEX_MODEL_SELECTION, "active");
      const archived = candidate(
        CLAUDE_MODEL_SELECTION,
        "020e7f00-dce6-406b-8ec6-ed90498945d6",
        "claudeAgent",
      );
      const deleted = candidate(CODEX_MODEL_SELECTION, "deleted");
      const ownedPi = candidate(PI_MODEL_SELECTION, "owned-pi", "pi");
      const owners = [
        yield* seedOwner(active),
        yield* seedOwner(archived, "archived"),
        yield* seedOwner(deleted, "deleted"),
        yield* seedOwner(ownedPi),
      ];
      const before = yield* Effect.forEach(owners, (id) =>
        projections.getThreadRecords(id, ["providerThreads"]),
      );
      const otherInstance = candidate(
        { ...CLAUDE_MODEL_SELECTION, instanceId: ProviderInstanceId.make("claude-other") },
        archived.source.providerSessionId,
        "claudeAgent",
      );
      const unowned = candidate(CODEX_MODEL_SELECTION, "unowned");
      unowned.thread.omittedMessageCount = 1;
      unowned.worktree = { path: "/workspace/project/.claude/worktrees/feat", branch: "feat" };
      const unownedPi = candidate(PI_MODEL_SELECTION, "unowned-pi", "pi");
      const importer = yield* makeImporter([
        active,
        archived,
        deleted,
        ownedPi,
        otherInstance,
        unowned,
        unownedPi,
      ]);

      expect(yield* importer.run).toEqual({ importedCount: 3, skippedCount: 0 });
      for (const source of [active, archived, deleted, ownedPi]) {
        const threadId = importId(source);
        expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
        expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
        expect(yield* runtimes.getByThreadId({ threadId })).toEqual(Option.none());
      }
      expect(
        yield* Effect.forEach(owners, (id) =>
          projections.getThreadRecords(id, ["providerThreads"]),
        ),
      ).toEqual(before);
      expect(
        new Set(
          importer.published.flatMap((stored) =>
            "event" in stored ? [stored.event.threadId] : [],
          ),
        ),
      ).toEqual(new Set([importId(otherInstance), importId(unowned), importId(unownedPi)]));
      for (const source of [otherInstance, unowned, unownedPi]) {
        const threadId = importId(source);
        const records = yield* projections.getThreadRecords(threadId, [
          "messages",
          "turnItems",
          "providerThreads",
        ]);
        expect(records.messages.map((message) => message.text)).toEqual(["Fix it", "Fixed"]);
        const notices = records.turnItems.filter((item) => item.type === "system_notice");
        if (source === unowned) {
          expect(records.turnItems[0]).toBe(notices[0]);
          expect(notices).toMatchObject([
            {
              ordinal: 1,
              runId: null,
              message: expect.stringContaining("1 earlier message was not imported"),
            },
          ]);
        } else {
          expect(notices).toEqual([]);
        }
        expect(records.thread.historyOrigin).toBe("v1_import");
        expect(records.thread.worktreePath).toBe(source.worktree?.path ?? null);
        expect(records.thread.branch).toBe(source.worktree?.branch ?? null);
        expect(records.thread.activeProviderThreadId).toBe(records.providerThreads[0]?.id);
        expect(records.providerThreads[0]?.nativeThreadRef?.nativeId).toBe(nativeId(source));
        expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
          providerInstanceId: source.source.providerInstanceId,
          resumeCursor:
            source.source.provider === "claudeAgent"
              ? { threadId, resume: source.source.providerSessionId }
              : { threadId: nativeId(source) },
          runtimePayload: {
            cwd: source.worktree?.path ?? "/workspace/project",
            importedTranscripts: [source.source],
          },
        });
      }
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("tolerates a missing transcript owner but propagates failed ownership reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ownership-read");
    const threadId = importId(source);
    yield* runtimes.upsert({
      threadId: ThreadId.make("missing-owner"),
      providerName: "codex",
      providerInstanceId: source.source.providerInstanceId,
      adapterKey: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      lastSeenAt: timestamp,
      resumeCursor: null,
      runtimePayload: { importedTranscripts: [source.source] },
    });
    yield* runtimes.recordImportedTranscript({
      threadId: ThreadId.make("missing-owner"),
      source: source.source,
    });
    const importer = yield* makeImporter([source]);
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });

    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${threadId}`;
    expect(yield* Effect.flip(importer.run)).toMatchObject({
      _tag: "AgentSessionScanError",
      operation: "read-projects",
      cause: {
        _tag: "OrchestratorProjectionError",
        threadId,
        cause: { _tag: "ProjectionStoreReadError" },
      },
    });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("rechecks ownership after the import reaches the commit transaction", () =>
  Effect.gen(function* () {
    const enteringTransaction = yield* Deferred.make<void>();
    const continueTransaction = yield* Deferred.make<void>();
    const source = candidate(CODEX_MODEL_SELECTION, "claimed-during-import");
    const importer = yield* makeImporter(
      [source],
      Deferred.succeed(enteringTransaction, undefined).pipe(
        Effect.andThen(Deferred.await(continueTransaction)),
      ),
    );
    const pending = yield* Effect.forkScoped(importer.run);
    yield* Deferred.await(enteringTransaction);
    // Commit ownership after all pre-transaction reads, before the import acquires SQLite.
    const ownerId = yield* seedOwner(source);
    yield* Deferred.succeed(continueTransaction, undefined);
    expect(yield* Fiber.join(pending)).toEqual({ importedCount: 0, skippedCount: 0 });
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 0 });
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* EventStore.EventStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    expect(yield* Effect.option(projections.getThread(importId(source)))).toEqual(Option.none());
    expect(yield* events.read({ threadId: importId(source) }).pipe(Stream.runCollect)).toEqual([]);
    expect(yield* runtimes.list()).toEqual([]);
    expect(importer.published).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(ownerId, ["providerThreads"])).providerThreads[0]
        ?.appThreadId,
    ).toBe(ownerId);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "retries failed commits and runtime persistence without replaying committed history",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = candidate(CODEX_MODEL_SELECTION, "retry");
      const threadId = importId(source);
      const importer = yield* makeImporter([source]);
      yield* sql`CREATE TEMP TRIGGER fail_import BEFORE INSERT ON orchestration_events WHEN NEW.event_type = 'message.updated' BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual([]);
      expect(yield* Effect.option(projections.getThread(threadId))).toEqual(Option.none());
      expect(yield* runtimes.list()).toEqual([]);
      expect(importer.published).toEqual([]);
      yield* sql`DROP TRIGGER fail_import`;

      yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
      expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
      const committed = yield* events.read({ threadId }).pipe(Stream.runCollect);
      expect(committed).toHaveLength(6);
      expect(importer.published).toHaveLength(6);
      expect(yield* runtimes.list()).toEqual([]);
      yield* sql`DROP TRIGGER fail_runtime`;

      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(yield* events.read({ threadId }).pipe(Stream.runCollect)).toEqual(committed);
      expect(importer.published).toHaveLength(6);
      expect(
        (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Fix it", "Fixed"]);
      expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId }))).toMatchObject({
        providerInstanceId: source.source.providerInstanceId,
        resumeCursor: { threadId: source.source.providerSessionId },
        runtimePayload: { importedTranscripts: [source.source] },
      });
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not certify new native history after a partial import retry", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const original = candidate(CODEX_MODEL_SELECTION, "partial-retry");
    const threadId = importId(original);
    const importer = yield* makeImporter([original]);
    yield* sql`CREATE TEMP TRIGGER fail_runtime BEFORE INSERT ON provider_session_runtime BEGIN SELECT RAISE(ABORT, 'test runtime failure'); END`;
    expect(yield* importer.run).toEqual({ importedCount: 0, skippedCount: 1 });
    yield* sql`DROP TRIGGER fail_runtime`;
    expect(yield* runtimes.list()).toEqual([]);
    const continued = candidate(CODEX_MODEL_SELECTION, original.source.providerSessionId);
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue outside T3", createdAt: timestamp },
      { role: "assistant", text: "Native continuation", createdAt: timestamp },
    );
    // The thread holds only the original messages, so the continued transcript stays unrecorded.
    expect(yield* (yield* makeImporter([continued])).run).toEqual({
      importedCount: 0,
      skippedCount: 1,
    });
    expect(yield* runtimes.list()).toEqual([]);
    expect(
      (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
        (message) => message.text,
      ),
    ).toEqual(["Fix it", "Fixed"]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("does not record a changed transcript as imported without its new messages", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const first = candidate(
      CLAUDE_MODEL_SELECTION,
      "6f1c2a7e-3b4d-4e5f-9a8b-1c2d3e4f5a6b",
      "claudeAgent",
    );
    const threadId = importId(first);
    expect(yield* (yield* makeImporter([first])).run).toEqual({
      importedCount: 1,
      skippedCount: 0,
    });

    const continued = candidate(
      CLAUDE_MODEL_SELECTION,
      first.source.providerSessionId,
      "claudeAgent",
    );
    continued.source.size = 200;
    continued.source.mtimeMs = 3;
    continued.thread.messages.push(
      { role: "user", text: "Continue", createdAt: timestamp },
      { role: "assistant", text: "Continued", createdAt: timestamp },
    );
    yield* (yield* makeImporter([continued])).run;

    const recorded = AgentSessionScanner.decodeImportedTranscriptPayload(
      Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimePayload,
    ).pipe(Option.getOrThrow).importedTranscripts;
    const texts = (yield* projections.getThreadRecords(threadId, ["messages"])).messages.map(
      (message) => message.text,
    );
    expect({
      recordsChangedTranscript: recorded?.some((source) => source.size === 200) ?? false,
      showsNewMessages: texts.includes("Continued"),
    }).not.toEqual({ recordsChangedTranscript: true, showsNewMessages: false });
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect(
  "copies native session history into the imported thread once, retrying a failed read",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const source = candidate(CODEX_MODEL_SELECTION, "native-history");
      const threadId = yield* seedOwner(source);
      const resolved: Array<ProviderInstanceId> = [];
      const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
      let closed = false;
      let failRead = true;
      const replayed = (role: "user" | "assistant", text: string) => ({
        createdBy: role === "user" ? ("user" as const) : ("agent" as const),
        creationSource: "provider" as const,
        id: MessageId.make(`replayed:${text}`),
        threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      });
      const adapter = {
        openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              opened.push(input);
              return {
                readThreadSnapshot: ({ providerThread }) =>
                  failRead
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                          driver: providerThread.driver,
                          providerThreadId: providerThread.id,
                        }),
                      )
                    : Effect.succeed({
                        providerThread,
                        providerTurns: [],
                        runtimeRequests: [],
                        reasoningMessageIds: [MessageId.make("replayed:Check the build log")],
                        messages: [
                          replayed("user", "Fix the build"),
                          replayed("assistant", "Check the build log"),
                          replayed("assistant", "Fixed it"),
                          replayed("assistant", " "),
                        ],
                      }),
              } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
            }),
            () =>
              Effect.sync(() => {
                closed = true;
              }),
          ),
      } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
      const importer = yield* makeImporter([], Effect.void, (instanceId) =>
        Effect.sync(() => {
          resolved.push(instanceId);
          return adapter;
        }),
      );

      const importHistory = importer.importNativeHistory({
        threadId,
        workspaceRoot: "/workspace/project",
      });

      expect((yield* Effect.flip(importHistory))._tag).toBe(
        "ProviderAdapterReadThreadSnapshotError",
      );
      expect(closed).toBe(true);
      expect(
        (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
      ).toBeUndefined();

      failRead = false;
      expect(yield* importHistory).toBe(3);
      expect(resolved).toEqual([
        CODEX_MODEL_SELECTION.instanceId,
        CODEX_MODEL_SELECTION.instanceId,
      ]);
      expect(opened[1]).toMatchObject({
        threadId,
        initialNativeThreadId: source.source.providerSessionId,
        runtimePolicy: { cwd: "/workspace/project" },
      });
      // Forks keep run-less history only for this origin.
      expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
        "v1_import",
      );
      expect(yield* importHistory).toBe(0);
      expect(opened).toHaveLength(2);
      const page = yield* projections.getTimelinePage(threadId, { view: "activity", limit: 10 });
      expect(
        page.items.map(({ item }) => [
          item.type,
          item.runId,
          "text" in item ? item.text : undefined,
        ]),
      ).toEqual([
        ["user_message", null, "Fix the build"],
        ["reasoning", null, "Check the build log"],
        ["assistant_message", null, "Fixed it"],
      ]);
    }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("releases the ACP import lock when a native session never answers", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
    const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, "native-history-hang"));
    const opened = yield* Deferred.make<void>();
    let closed = false;
    // An agent that only resumes sessions and never answers its first session/resume.
    const adapter = {
      openSession: () =>
        Effect.suspend(() => {
          if (!closed) {
            return Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ).pipe(
              Effect.andThen(Deferred.succeed(opened, undefined)),
              Effect.andThen(Effect.never),
            );
          }
          return Effect.succeed({
            readThreadSnapshot: ({ providerThread }) =>
              Effect.succeed({
                providerThread,
                providerTurns: [],
                runtimeRequests: [],
                messages: [
                  {
                    createdBy: "user",
                    creationSource: "provider",
                    id: MessageId.make("replayed:hang"),
                    threadId,
                    runId: null,
                    nodeId: null,
                    role: "user",
                    text: "Fix the build",
                    attachments: [],
                    streaming: false,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              }),
          } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">);
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
    const importer = yield* makeImporter([], Effect.void, () => Effect.succeed(adapter));
    const importHistory = coordinator.withSessionMutation(
      importer.importNativeHistory({ threadId, workspaceRoot: "/workspace/project" }),
    );

    const importing = yield* importHistory.pipe(Effect.flip, Effect.forkChild);
    yield* Deferred.await(opened);
    // Any other ACP import or delete waits for the same lock.
    const next = yield* coordinator
      .withSessionMutation(Effect.succeed("next"))
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("2 minutes");

    expect((yield* Fiber.join(importing))._tag).toBe("TimeoutError");
    expect(closed).toBe(true);
    expect(yield* Fiber.join(next)).toBe("next");
    expect(
      (yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin,
    ).toBeUndefined();
    expect(yield* importHistory).toBe(1);
    expect((yield* projections.getThreadRecords(threadId, [])).thread.historyOrigin).toBe(
      "v1_import",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(persistence, AcpRegistryRuntimeCoordinator.layer)),
  ),
);

/**
 * Runs a thread command that read the thread before the history load ended and
 * writes once the importer is about to commit, as an unserialized write would.
 */
const importDuringCommand = Effect.fn(function* (
  name: string,
  command: (thread: OrchestrationV2AppThread) => ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = yield* seedOwner(candidate(CODEX_MODEL_SELECTION, name));
  const lock = yield* KeyedLock.make<ThreadId>();
  const loaded = yield* Deferred.make<void>();
  const importerCommitting = yield* Deferred.make<void>();
  const commandWritten = yield* Deferred.make<void>();
  const committing = Deferred.succeed(importerCommitting, undefined);
  const adapter = {
    openSession: () =>
      Effect.succeed({
        readThreadSnapshot: ({ providerThread }) =>
          Deferred.await(loaded).pipe(
            Effect.as({
              providerThread,
              providerTurns: [],
              runtimeRequests: [],
              messages: [
                {
                  createdBy: "user" as const,
                  creationSource: "provider" as const,
                  id: MessageId.make(`replayed:${name}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user" as const,
                  text: "Fix the build",
                  attachments: [],
                  streaming: false,
                  createdAt: now,
                  updatedAt: now,
                },
              ],
            }),
          ),
      } as Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const importer = yield* makeImporter(
    [],
    committing.pipe(Effect.andThen(Deferred.await(commandWritten))),
    () => Effect.succeed(adapter),
    {
      ...lock,
      withLock: (key, effect) => committing.pipe(Effect.andThen(lock.withLock(key, effect))),
    },
  );
  const commanding = yield* Effect.forkScoped(
    lock.withLock(
      threadId,
      Effect.gen(function* () {
        const { thread } = yield* projections.getThreadRecords(threadId, []);
        yield* Deferred.succeed(loaded, undefined);
        yield* Deferred.await(importerCommitting);
        yield* sink.write({ events: command(thread) });
        yield* Deferred.succeed(commandWritten, undefined);
      }),
    ),
  );
  const imported = yield* importer.importNativeHistory({
    threadId,
    workspaceRoot: "/workspace/project",
  });
  yield* Fiber.join(commanding);
  const records = yield* projections.getThreadRecords(threadId, ["runs"]);
  const page = yield* projections.getTimelinePage(threadId, { view: "messages", limit: 10 });
  return { imported, thread: records.thread, runs: records.runs, items: page.items };
});

it.effect("keeps a thread edit made while the native history loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("renamed-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:renamed`),
        type: "thread.metadata-updated",
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title: "Renamed" },
      },
    ]);
    expect(result.imported).toBe(1);
    expect(result.thread.title).toBe("Renamed");
    expect(result.thread.historyOrigin).toBe("v1_import");
    expect(result.items).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("skips the native history when a run starts while it loads", () =>
  Effect.gen(function* () {
    const result = yield* importDuringCommand("run-during-load", (thread) => [
      {
        id: EventId.make(`${thread.id}:run`),
        type: "run.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          id: RunId.make(`${thread.id}:run`),
          threadId: thread.id,
          ordinal: 1,
          providerInstanceId: thread.providerInstanceId,
          modelSelection: thread.modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${thread.id}:prompt`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "queued",
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    ]);
    expect(result.imported).toBe(0);
    expect(result.runs).toHaveLength(1);
    expect(result.thread.historyOrigin).toBeUndefined();
    expect(result.items).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("imports under a policy ceiling in the project's default, kept under the ceiling", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    const source = candidate(CODEX_MODEL_SELECTION, "ceiling");
    const threadId = importId(source);
    const importer = yield* makeImporter(
      [source],
      Effect.void,
      undefined,
      undefined,
      ServerSettings.layerTest(
        { defaultRuntimeMode: "full-access" },
        {
          organization: "Example Corp",
          lockedSettings: [],
          limits: { maxRuntimeMode: "auto-accept-edits" },
        },
      ),
    );
    expect(yield* importer.run).toEqual({ importedCount: 1, skippedCount: 0 });
    expect((yield* projections.getThread(threadId)).runtimeMode).toBe("auto-accept-edits");
    expect(Option.getOrThrow(yield* runtimes.getByThreadId({ threadId })).runtimeMode).toBe(
      "auto-accept-edits",
    );
  }).pipe(Effect.scoped, Effect.provide(persistence)),
);

it.effect("repeated imports reach linked-worktree sessions behind the scan budget", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-worktree-budget-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const worktreeGitDir = path.join(repo, ".git", "worktrees", "feature");
    yield* fs.makeDirectory(worktreeGitDir, { recursive: true });
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(repo, ".git", "config"), "[core]\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "commondir"), "../..\n");
    yield* fs.writeFileString(path.join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n");
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "01");
    yield* fs.makeDirectory(sessions, { recursive: true });
    const nowMs = DateTime.toEpochMillis(now);
    yield* TestClock.setTime(nowMs);
    // One more session than the 100-transcript scan budget, all run in the linked worktree.
    for (let index = 0; index < 101; index++) {
      const file = path.join(sessions, `rollout-${String(index).padStart(3, "0")}.jsonl`);
      const records = [
        { type: "session_meta", payload: { id: `session-${index}`, cwd: worktree } },
        { type: "event_msg", payload: { type: "user_message", message: `Request ${index}` } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Done" }],
          },
        },
      ];
      yield* fs.writeFileString(
        file,
        records.map((record) => JSON.stringify(record) + "\n").join(""),
      );
      const modifiedAtSeconds = nowMs / 1000 - (index + 1);
      yield* fs.utimes(file, modifiedAtSeconds, modifiedAtSeconds);
    }

    const scannerContext = yield* Layer.build(
      AgentSessionScanner.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(claudeHome, { prefix: "t3-import-budget-config-" }),
            ServerSettings.layerTest({
              providerInstances: {
                [ProviderInstanceId.make("claudeAgent")]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: claudeHome },
                },
                [ProviderInstanceId.make("codex")]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: { homePath: codexHome },
                },
                // Keeps the default Pi instance off the developer's real ~/.pi.
                [ProviderInstanceId.make("pi")]: {
                  driver: ProviderDriverKind.make("pi"),
                  enabled: false,
                  config: {},
                },
              },
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
            Layer.succeed(
              ProviderSessionRuntime.ProviderSessionRuntimeRepository,
              yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository,
            ),
          ),
        ),
      ),
    );
    const importer = yield* makeImporter([], Effect.void, undefined, undefined, undefined, {
      workspaceRoot: repo,
      scanner: Context.get(scannerContext, AgentSessionScanner.AgentSessionScanner),
    });

    expect(yield* importer.run).toEqual({ importedCount: 100, skippedCount: 1 });
    expect(yield* importer.run).toEqual({ importedCount: 101, skippedCount: 0 });
    const oldest = yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.getThread(ThreadId.make("import:codex:session-100")),
      ),
    );
    expect(oldest.worktreePath).toBe(worktree);
  }).pipe(Effect.scoped, Effect.provide(Layer.merge(persistence, NodeServices.layer))),
);
