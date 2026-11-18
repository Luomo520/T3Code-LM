class CodexLocalSyncReadError extends Schema.TaggedError<CodexLocalSyncReadError>()("CodexLocalSyncReadError", { cause: Schema.Unknown }) {}
const readLocal = <A>(read: () => PromiseLike<A>) => Effect.tryPromise({ try: read, catch: (cause) => new CodexLocalSyncReadError({ cause }) });
// @effect-diagnostics nodeBuiltinImport:off - local read-only history adapter and stable non-secret event hashes.
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  CodexSettings,
  ProviderDriverKind,
  EventId,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import { type AgentSessionThreadMessage } from "./AgentSessionScanner.ts";
import {
  codexTitle,
  isRepairableCodexTitle,
  findAppendStart,
  readLocalCodexCatalog,
  readLocalCodexArchiveStates,
  readLocalCodexMessages,
  readLocalCodexRollout,
  readLocalCodexVersion,
} from "./CodexLocalHistory.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tailDigest = (messages: ReadonlyArray<{ role: string; text: string }>) =>
  messages
    .slice(-8)
    .map((message) => digest(message.role + "\0" + message.text.trim()))
    .join(":");
const normalize = (value: string) =>
  normalizeProjectPathForComparison(value.replace(/^\\\\\?\\/, ""));

/** Local disk only. One server-lifetime loop; no provider requests or Codex writes. */
export const makeCodexLocalSync = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const hostHome = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  const seen = new Map<string, string>();
  // Stable mismatches and verified final tails; never cache a rejected EventSink commit.
  const deferredRollouts = new Map<string, string>();

  return Effect.gen(function* () {
    const config = yield* settings.getSettings;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    let rolloutReadsRemaining = 2;
    const roots = yield* projects.list();
    const homes = new Map<string, { home: string; instances: string[] }>();
    const instances = Object.entries(config.providerInstances).filter(
      ([, v]) => v.driver === "codex" && resolveProviderInstanceEnabled(v),
    );
    if (!Object.hasOwn(config.providerInstances, "codex"))
      instances.unshift(["codex", { driver: ProviderDriverKind.make("codex") }]);
    for (const [instance, provider] of instances) {
      const decoded = yield* Schema.decodeEffect(CodexSettings)(provider.config ?? {});
      const homeOverride =
        provider.environment?.findLast((v) => v.name === "CODEX_HOME")?.value ??
        environment.CODEX_HOME;
      const layout = yield* resolveCodexHomeLayout(
        !decoded.homePath.trim() && typeof homeOverride === "string" && homeOverride ? { ...decoded, homePath: homeOverride } : decoded,
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, hostHome),
        Effect.provideService(Path.Path, path),
      );
      const home = layout.sharedHomePath;
      const group = homes.get(normalize(home));
      if (group) group.instances.push(instance);
      else homes.set(normalize(home), { home, instances: [instance] });
    }
    for (const { home, instances: homeInstances } of homes.values()) {
      const instance = homeInstances[0]!;
      // Query known imports directly: absence from the paginated recent catalog
      // does not distinguish an archive from a missing or old source thread.
      const importedOwners = yield* sql<{
        thread_id: string;
        provider_thread_id: string;
        native_id: string;
        archived_at: string | null;
      }>`SELECT t.thread_id,t.archived_at,p.provider_thread_id,
          json_extract(p.payload_json,'$.nativeThreadRef.nativeId') AS native_id
        FROM orchestration_v2_projection_threads t
        JOIN orchestration_v2_projection_provider_threads p
          ON p.provider_thread_id=t.active_provider_thread_id AND p.thread_id=t.thread_id
        WHERE t.deleted_at IS NULL
          AND json_extract(t.payload_json,'$.historyOrigin')='v1_import'
          AND p.driver='codex' AND p.provider_instance_id IN ${sql.in(homeInstances)}
          AND json_extract(p.payload_json,'$.nativeThreadRef.nativeId') IS NOT NULL`;
      const archiveStates = yield* readLocal(() =>
        readLocalCodexArchiveStates(home, [...new Set(importedOwners.map((row) => row.native_id))]),
      ).pipe(Effect.orElseSucceed(() => []));
      for (const source of archiveStates) {
        const owners = importedOwners.filter((row) => row.native_id === source.id);
        if (owners.length !== 1 || (source.archived !== 0 && source.archived !== 1)) continue;
        const owner = owners[0]!;
        if ((source.archived === 1) === (owner.archived_at !== null)) continue;
        const id = ThreadId.make(owner.thread_id);
        yield* Effect.gen(function* () {
          const sequence = yield* sink.latestSequence({ threadId: id });
          const current = yield* orchestrator.getThreadRecords(id, [
            "messages",
            "runs",
            "providerThreads",
          ]);
          const provider = current.providerThreads.find(
            (row) => row.id === owner.provider_thread_id,
          );
          if (
            current.thread.historyOrigin !== "v1_import" ||
            current.thread.deletedAt ||
            current.thread.activeProviderThreadId !== owner.provider_thread_id ||
            provider?.driver !== "codex" ||
            provider.nativeThreadRef?.nativeId !== source.id ||
            provider.status === "active" ||
            (provider.pendingBackgroundTasks?.length ?? 0) > 0 ||
            current.messages.some((message) => message.streaming) ||
            current.runs.some((run) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
            )
          )
            return;
          const shouldArchive = source.archived === 1;
          if (shouldArchive === (current.thread.archivedAt !== null)) return;
          if (!shouldArchive) {
            // A source restore may only undo this synchronizer's own archive;
            // a deliberate T3 archive remains under the user's control.
            const lastLifecycle = yield* sql<{ event_id: string; archived_at: string | null }>`
              SELECT event_id,json_extract(payload_json,'$.archivedAt') AS archived_at
              FROM orchestration_events WHERE aggregate_kind='thread' AND stream_id=${id}
                AND application_event_version=2 AND event_type IN ('thread.archived','thread.unarchived')
              ORDER BY sequence DESC LIMIT 1`;
            if (
              !lastLifecycle[0]?.event_id.startsWith("codex-local:archive:") ||
              lastLifecycle[0].archived_at !== DateTime.formatIso(current.thread.archivedAt!)
            )
              return;
          }
          const at = yield* DateTime.now;
          const committed = yield* sink.write({
            events: [
              {
                id: EventId.make(
                  `codex-local:${shouldArchive ? "archive" : "restore"}:` +
                    digest(id + ":" + sequence + ":" + source.archived),
                ),
                type: shouldArchive ? "thread.archived" : "thread.unarchived",
                threadId: id,
                occurredAt: at,
                payload: { ...current.thread, archivedAt: shouldArchive ? at : null },
              },
            ],
            guardIdleThread: {
              threadId: id,
              updatedAt: current.thread.updatedAt,
              archivedAt: current.thread.archivedAt,
              messageCount: current.messages.length,
              sequence,
            },
          });
          if (committed.length) seen.delete(instance + ":" + source.id);
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Codex archive sync deferred a session", { sessionId: source.id }),
          ),
        );
      }
      const catalog = yield* readLocal(() => readLocalCodexCatalog(home, nowMs)).pipe(
        Effect.orElseSucceed(() => []),
      );
      const historyVersion = yield* readLocal(() => readLocalCodexVersion(home)).pipe(
        Effect.option,
      );
      if (historyVersion._tag === "None") continue;
      for (const row of catalog) {
        const project = roots.find((p) => normalize(p.workspaceRoot) === normalize(row.cwd));
        if (!project) continue;
        const key = instance + ":" + row.id;
        const version = !row.rollout_path
          ? historyVersion
          : yield* readLocal(() => readLocalCodexVersion(home, row.rollout_path)).pipe(
              Effect.option,
            );
        if (version._tag === "None") continue;
        const fingerprint = digest(
          row.updated_at +
            "\0" +
            row.name +
            "\0" +
            row.title +
            "\0" +
            row.first_user_message +
            "\0" +
            version.value +
            "\0" +
            project.projectId,
        );
        if (seen.get(key) === fingerprint) continue;
        yield* Effect.gen(function* () {
          const owners = yield* sql<{
            thread_id: string;
            provider_instance_id: string;
          }>`SELECT thread_id,provider_instance_id FROM orchestration_v2_projection_provider_threads
            WHERE driver='codex' AND provider_instance_id IN ${sql.in(homeInstances)}
            AND json_extract(payload_json,'$.nativeThreadRef.nativeId')=${row.id}`;
          if (new Set(owners.map((o) => o.thread_id)).size > 1) return;
          const id = ThreadId.make(owners[0]?.thread_id ?? `import:${instance}:${row.id}`);
          const prior = yield* Effect.option(
            orchestrator.getThreadRecords(id, ["messages", "turnItems", "runs", "providerThreads"]),
          );
          if (
            prior._tag === "Some" &&
            (prior.value.thread.deletedAt || prior.value.thread.archivedAt)
          ) {
            seen.delete(key);
            return;
          }
          if (
            prior._tag === "Some" &&
            (prior.value.runs.some((r) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(r.status),
            ) ||
              prior.value.messages.some((m) => m.streaming))
          )
            return;
          const title = codexTitle(row.name, row.title, row.first_user_message);
          // A stale Codex turn or divergent transcript must not block a safe
          // metadata repair. This pass never marks the history synchronized.
          if (
            prior._tag === "Some" &&
            prior.value.thread.historyOrigin === "v1_import" &&
            isRepairableCodexTitle(prior.value.thread.title) &&
            !isRepairableCodexTitle(title)
          ) {
            const sequence = yield* sink.latestSequence({ threadId: id });
            const current = yield* orchestrator.getThreadRecords(id, ["messages", "runs"]);
            const manual = yield* sql<{
              count: number;
            }>`SELECT count(*) AS count FROM orchestration_command_receipts
              WHERE aggregate_kind='thread' AND aggregate_id=${id} AND command_type='thread.metadata.update' AND status='accepted'`;
            if (
              current.thread.historyOrigin === "v1_import" &&
              isRepairableCodexTitle(current.thread.title) &&
              current.thread.title !== title &&
              !manual[0]?.count &&
              !current.thread.deletedAt &&
              !current.thread.archivedAt &&
              !current.messages.some((m) => m.streaming) &&
              !current.runs.some((r) =>
                ["queued", "preparing", "starting", "running", "waiting"].includes(r.status),
              )
            ) {
              const committed = yield* sink.write({
                events: [
                  {
                    id: EventId.make(
                      "codex-local:title:" + digest(id + ":" + sequence + ":" + title),
                    ),
                    type: "thread.metadata-updated",
                    threadId: id,
                    occurredAt: yield* DateTime.now,
                    payload: { ...current.thread, title },
                  },
                ],
                guardIdleThread: {
                  threadId: id,
                  updatedAt: current.thread.updatedAt,
                  messageCount: current.messages.length,
                  sequence,
                },
              });
              if (!committed.length) return;
            }
          }
          let messages: ReadonlyArray<AgentSessionThreadMessage & { nativeId?: string }> =
            yield* readLocal(async () => {
              const paginated = readLocalCodexMessages(home, row.id);
              if (paginated.length || row.history_mode === "paginated") return paginated;
              if (!row.rollout_path || rolloutReadsRemaining <= 0) return [];
              rolloutReadsRemaining--;
              return readLocalCodexRollout(row);
            });
          if (!messages.length) return;
          const sourceInstance = ProviderInstanceId.make(
            owners[0]?.provider_instance_id ?? instance,
          );
          const local = {
            active: true,
            ownerProviderInstanceIds: homeInstances.map((value) => ProviderInstanceId.make(value)),
            outcomes: [
              {
                _tag: "Importable",
                worktree: null,
                source: {
                  provider: "codex",
                  providerInstanceId: sourceInstance,
                  providerSessionId: row.id,
                  filePath:
                    row.history_mode === "paginated"
                      ? join(home, "thread_history_1.sqlite") + "#" + row.id
                      : (row.rollout_path ?? join(home, "thread_history_1.sqlite") + "#" + row.id),
                  size: messages.length,
                  mtimeMs: row.updated_at * 1000,
                  device: 0,
                  inode: null,
                  birthtimeMs: null,
                },
                thread: {
                  source: "codex",
                  providerInstanceId: sourceInstance,
                  providerSessionId: row.id,
                  title,
                  model: row.model,
                  createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at * 1000)),
                  updatedAt: DateTime.formatIso(DateTime.makeUnsafe(row.updated_at * 1000)),
                  messages,
                  omittedMessageCount: 0,
                },
              },
            ],
          } as const;
          if (prior._tag === "None") {
            const result = yield* importer.importRecentAgentThreads(
              { projectId: project.projectId },
              local,
            );
            if (result.importedCount) seen.set(key, fingerprint);
            return;
          }
          // The history commit and provider-runtime record are separate writes.
          // Repair an interrupted import before caching it as synchronized.
          if (
            prior.value.thread.historyOrigin === "v1_import" &&
            id === `import:${sourceInstance}:${row.id}`
          ) {
            const runtime =
              yield* sql`SELECT thread_id FROM provider_session_runtime WHERE thread_id=${id}`;
            if (!runtime.length) {
              const repaired = yield* importer.importRecentAgentThreads(
                { projectId: project.projectId },
                local,
              );
              if (!repaired.importedCount) return;
            }
          }
          yield* Effect.gen(function* () {
            const sequence = yield* sink.latestSequence({ threadId: id });
            const current = yield* orchestrator.getThreadRecords(id, [
              "messages",
              "turnItems",
              "runs",
            ]);
            if (
              current.thread.deletedAt ||
              current.thread.archivedAt ||
              current.runs.some((r) =>
                ["queued", "preparing", "starting", "running", "waiting"].includes(r.status),
              )
            )
              return;
            // The projection already orders by turn-item position. Wall-clock
            // timestamps can tie or move backwards between Codex messages.
            const existing = current.messages;
            let start = findAppendStart(existing, messages);
            let matchedRolloutVersion: string | null = null;
            if (
              start === null &&
              row.rollout_path &&
              current.thread.historyOrigin === "v1_import"
            ) {
              // The paginated store can describe an older/different native branch.
              // Only the catalog-selected, stable rollout with this id/cwd may repair it.
              const rolloutVersion = yield* readLocal(() =>
                readLocalCodexVersion(home, row.rollout_path, true),
              );
              const comparison = digest(rolloutVersion + tailDigest(existing));
              if (deferredRollouts.get(key) === comparison || rolloutReadsRemaining <= 0) return;
              rolloutReadsRemaining--;
              const fallback = yield* readLocal(() => readLocalCodexRollout(row)).pipe(
                Effect.orElseSucceed(() => []),
              );
              const fallbackStart = findAppendStart(existing, fallback);
              if (fallbackStart === null) {
                if (deferredRollouts.size >= 2000) deferredRollouts.clear();
                deferredRollouts.set(key, comparison);
                return;
              }
              messages = fallback;
              start = fallbackStart;
              matchedRolloutVersion = rolloutVersion;
              deferredRollouts.delete(key);
            }
            if (start === null) return;
            const ordinal = Math.max(0, ...current.turnItems.map((item) => item.ordinal));
            const events = messages.slice(start).flatMap((message, index) =>
              AgentSessionImporter.messageEvents({
                threadId: id,
                index: ordinal + index,
                message,
                identity:
                  "codex-local:" +
                  digest(
                    row.id +
                      ":" +
                      (message.nativeId ?? start + index + ":" + message.role + ":" + message.text),
                  ),
              }),
            );
            if (events.length) {
              const committed = yield* sink.write({
                events,
                guardIdleThread: {
                  threadId: id,
                  updatedAt: current.thread.updatedAt,
                  messageCount: current.messages.length,
                  sequence,
                },
              });
              if (!committed.length) return;
            }
            if (matchedRolloutVersion !== null) {
              deferredRollouts.set(key, digest(matchedRolloutVersion + tailDigest(messages)));
            }
            seen.set(key, fingerprint);
          });
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Codex local sync deferred a session", { sessionId: row.id }),
          ),
        );
      }
    }
  });
});
