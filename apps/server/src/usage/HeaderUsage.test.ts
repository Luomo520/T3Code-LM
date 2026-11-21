import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import { makeHeaderUsage } from "./HeaderUsage.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const providerId = ProviderInstanceId.make("codex");
const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-header-integration-" });

it.effect(
  "follows synthetic CC Switch accounts while preserving the T3 conversation scope and redacting secrets",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const device = path.join(home, ".cc-switch");
      yield* fs.makeDirectory(device);
      const db = new NodeSqlite.DatabaseSync(path.join(device, "cc-switch.db"));
      const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
        Response.json({
          balance: String(url).includes("a.example") ? 10 : 20,
          usage: { total: { total_tokens: 99999 }, today: { actual_cost: 3 } },
        }),
      );
      try {
        db.exec(
          "CREATE TABLE providers (app_type TEXT, id TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current INTEGER)",
        );
        for (const id of ["a", "b"])
          db.prepare("INSERT INTO providers VALUES ('codex', ?, ?, ?, '{}', ?)").run(
            id,
            `Supplier ${id}`,
            encode({
              auth: { OPENAI_API_KEY: `synthetic-${id}-key` },
              config: `base_url = "https://${id}.example.test/v1"`,
            }),
            id === "a" ? 1 : 0,
          );
        const read = yield* makeHeaderUsage().pipe(
          Effect.provide(
            ServerSettings.layerTest({
              providerInstances: {
                [providerId]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: {
                    billingSource: "ccSwitch",
                    homePath: home,
                    billingUrl: "https://unrelated.example.test",
                    billingKey: "unrelated-secret",
                  },
                  environment: [
                    { name: "OPENAI_API_KEY", value: "ambient-unrelated-secret", sensitive: true },
                  ],
                },
              },
            }),
          ),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
        const coldA = yield* read({});
        yield* Effect.promise(read.awaitIdle);
        const a = yield* read({});
        expect(a.account).toMatchObject({
          balance: 10,
          totalTokens: 99999,
          sourceLabel: "CC Switch · Supplier a",
        });
        expect(coldA.account.sourceId).toBe(a.account.sourceId);
        db.exec("UPDATE providers SET is_current = (id = 'b')");
        expect((yield* read({ refresh: true })).account.sourceId).toBe(a.account.sourceId);
        yield* TestClock.adjust("2001 millis");
        const coldB = yield* read({ refresh: true });
        expect(coldB.account.balance).toBeNull();
        expect(coldB.account.sourceId).not.toBe(a.account.sourceId);
        yield* Effect.promise(read.awaitIdle);
        const b = yield* read({});
        expect(b.account.balance).toBe(20);
        expect(b.conversation).toEqual(a.conversation);
        expect(b.allConversations).toEqual(a.allConversations);
        expect(b.allConversations.tokens).not.toBe(99999);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.map(([url, options]) => [url, options?.headers])).toEqual([
          ["https://a.example.test/v1/usage", { Authorization: "Bearer synthetic-a-key" }],
          ["https://b.example.test/v1/usage", { Authorization: "Bearer synthetic-b-key" }],
        ]);
        expect(encode(b)).not.toMatch(/synthetic-|unrelated-secret|https:\/\//);
        db.exec("UPDATE providers SET settings_config = '{}' WHERE id = 'b'");
        yield* TestClock.adjust("2001 millis");
        const missing = yield* read({ refresh: true });
        expect(missing.account.balance).toBeNull();
        expect(missing.account.message).toContain("TOML");
        expect(missing.account.sourceId).not.toBe(b.account.sourceId);
        expect(fetcher).toHaveBeenCalledTimes(2);
      } finally {
        fetcher.mockRestore();
        db.close();
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(
        Layer.mergeAll(Sqlite.layerMemory, configLayer).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect(
  "serves manual billing and mapped T3 requests from shared caches without charging a model call",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(path.join(home, "sessions"), { recursive: true });
      const line = (type: string, payload: unknown) =>
        encode({ type, timestamp: "2026-10-28T12:00:00Z", payload }) + "\n";
      yield* fs.writeFileString(
        path.join(home, "sessions", "rollout-native.jsonl"),
        line("session_meta", { id: "native" }) +
          line("turn_context", { model: "test", turn_id: "turn" }) +
          line("event_msg", {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
            },
          }),
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id,thread_id,provider,status,updated_at,payload_json,driver,provider_instance_id)
      VALUES ('p','thread','codex','ready','2026-10-28T12:00:00Z',${encode({ nativeThreadRef: { nativeId: "native" } })},'codex','codex')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,payload_json)
      VALUES ('t','thread','p','node',1,'running',${encode({ nativeTurnRef: { nativeId: "turn" } })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,ordinal,provider,status,requested_at,payload_json,provider_instance_id)
      VALUES ('run','thread',1,'codex','running','2026-10-28T12:00:00Z','{}','codex')`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
      VALUES ('node','thread','run','node','root_turn','running','{}')`;
      const claudeId = ProviderInstanceId.make("claude-fixture");
      yield* fs.makeDirectory(path.join(home, "projects"));
      const claudeRequest = (timestamp: string, costUSD: number) =>
        encode({
          type: "assistant",
          sessionId: "claude-native",
          timestamp,
          costUSD,
          message: {
            id: timestamp,
            model: "claude-relay",
            usage: { input_tokens: 12, cache_read_input_tokens: 8, output_tokens: 5 },
          },
        }) + "\n";
      yield* fs.writeFileString(
        path.join(home, "projects", "claude-native.jsonl"),
        claudeRequest("2026-10-28T12:02:03Z", 0.03) + claudeRequest("2026-10-28T12:05:00Z", 7),
      );
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id,thread_id,provider,status,updated_at,payload_json,driver,provider_instance_id)
      VALUES ('claude-p','thread',${claudeId},'ready','2026-10-28T12:03:00Z',
        ${encode({ nativeThreadRef: { nativeId: "claude-native" } })},'claudeAgent',${claudeId})`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
      (provider_turn_id,thread_id,provider_thread_id,node_id,ordinal,status,started_at,completed_at,payload_json)
      VALUES ('claude-t','thread','claude-p','claude-node',1,'completed','2026-10-28T12:02:00Z',
        '2026-10-28T12:02:04Z',${encode({ nativeTurnRef: { nativeId: "claude-turn" } })})`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,ordinal,provider,status,requested_at,payload_json,provider_instance_id)
      VALUES ('claude-run','thread',2,${claudeId},'completed','2026-10-28T12:02:00Z','{}',${claudeId})`;
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id,thread_id,run_id,root_node_id,kind,status,payload_json)
      VALUES ('claude-node','thread','claude-run','claude-node','root_turn','completed','{}')`;
      const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({
          balance: 5,
          unit: "USD",
          usage: { total: { total_tokens: 123 }, today: { actual_cost: 0.2 } },
        }),
      );
      try {
        const read = yield* makeHeaderUsage().pipe(
          Effect.provide(
            ServerSettings.layerTest({
              usagePriceOverrides: {
                test: { inputCostPerMillionTokens: 2, outputCostPerMillionTokens: 4 },
              },
              providerInstances: {
                [claudeId]: {
                  driver: ProviderDriverKind.make("claudeAgent"),
                  config: { homePath: home },
                },
                [providerId]: {
                  driver: ProviderDriverKind.make("codex"),
                  config: {
                    homePath: home,
                    billingUrl: "https://manual.example.test",
                    billingKey: "test-only-query",
                  },
                  environment: [
                    { name: "OPENAI_API_KEY", value: "different-model-key", sensitive: true },
                  ],
                },
              },
            }),
          ),
        );
        const first = yield* read({ threadId: "thread", providerInstanceId: "codex" });
        expect(first.conversation.tokens).toBe(110);
        expect(first.localReadAt).not.toBeNull();
        expect(first.localRefreshing).toBe(false);
        yield* Effect.promise(read.awaitIdle);
        const result = yield* read({ threadId: "thread", providerInstanceId: "codex" });
        expect(result.account).toMatchObject({ balance: 5, totalTokens: 123, todayCost: 0.2 });
        expect(result.conversation).toMatchObject({
          tokens: 110,
          cacheRate: 0.8,
          recentRate: 0.8,
          recentSamples: 1,
          partial: false,
        });
        expect(result.allConversations.cacheRate).toBe(0.8);
        expect(result.sessionUsage).toBeUndefined();
        const usage = (yield* read({ threadId: "thread", includeSessionUsage: true })).sessionUsage;
        expect(usage?.turns).toMatchObject([
          { runId: "run", cumulativeTokens: 110, cacheRate: 0.8, costPartial: false },
          {
            runId: "claude-run",
            cumulativeTokens: 135,
            cacheRate: 0.4,
            costUsd: 0.03,
            costPartial: false,
          },
        ]);
        expect(usage?.costUsd).toBeCloseTo(0.03024, 10);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0]).toMatchObject([
          "https://manual.example.test/v1/usage",
          { headers: { Authorization: "Bearer test-only-query" } },
        ]);
        expect(encode(result)).not.toContain("test-only-query");
      } finally {
        fetcher.mockRestore();
      }
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provide(
        Layer.mergeAll(Sqlite.layerMemory, configLayer).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

it.effect(
  "stores query keys with existing secret lifecycle and preserves model credentials on redacted edits",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const saved = yield* settings.updateSettings({
        providerInstances: {
          [providerId]: {
            driver: ProviderDriverKind.make("codex"),
            config: { billingUrl: "https://example.test", billingKey: "query-secret-test" },
            environment: [{ name: "OPENAI_API_KEY", value: "model-secret-test", sensitive: true }],
          },
        },
      });
      const client = ServerSettings.redactServerSettingsForClient(saved, {
        secretReferences: false,
      });
      expect(encode(client)).not.toContain("query-secret-test");
      expect(yield* fs.readFileString(config.settingsPath)).not.toContain("query-secret-test");
      const echoed = yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: providerId,
        instance: { ...client.providerInstances[providerId]!, displayName: "renamed" },
      });
      expect(echoed.providerInstances[providerId]?.config).toMatchObject({
        billingKey: "query-secret-test",
      });
      expect(echoed.providerInstances[providerId]?.environment?.[0]?.value).toBe(
        "model-secret-test",
      );
      const changed = yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: providerId,
        instance: {
          ...client.providerInstances[providerId]!,
          config: { billingUrl: "https://other.test", billingKey: "replacement-test" },
        },
      });
      expect(changed.providerInstances[providerId]?.config).toMatchObject({
        billingKey: "replacement-test",
      });
      const cleared = yield* settings.updateProviderInstance({
        operation: "upsert",
        instanceId: providerId,
        instance: { ...client.providerInstances[providerId]!, config: {} },
      });
      expect(encode(cleared.providerInstances[providerId]?.config)).not.toContain(
        "replacement-test",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(SecretStore.layer),
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(configLayer),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);
