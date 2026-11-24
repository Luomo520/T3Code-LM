import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("expo-secure-store", () => ({}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import { MobileSecureStorage } from "./mobile-secure-storage";
import { createHeaderUsageHistoryStore } from "../features/usage/headerUsageHistoryStore";
import { presentHeaderUsageHistory } from "../features/usage/headerUsageHistory";

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase(path = ":memory:") {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(path);
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => sqliteDatabase());
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
        "None",
      );
      expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
        "Some",
      );
    }),
  );

  it.effect(
    "restores account and current-thread samples after closing and reopening the SQLite file",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* Effect.promise(() => import("node:fs/promises"));
          const { tmpdir } = yield* Effect.promise(() => import("node:os"));
          const { join } = yield* Effect.promise(() => import("node:path"));
          const directory = yield* Effect.acquireRelease(
            Effect.promise(() => fs.mkdtemp(join(tmpdir(), "t3-header-history-"))),
            (path) => Effect.promise(() => fs.rm(path, { recursive: true, force: true })),
          );
          const path = join(directory, "history.sqlite");
          const target = {
            environmentId,
            providerInstanceId: "codex",
            threadId: "current-thread",
            home: false,
          };
          const at = "2026-10-31T10:00:00.000Z";
          const counters = {
            tokens: 0,
            cacheRate: 0,
            recentRate: 0,
            lastRate: 0,
            recentSpeed: 150,
            lastSpeed: 150,
            speedSampleAt: at,
            speedSamples: 1,
            recentSamples: 1,
            partial: false,
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.promise(() => sqliteDatabase(path));
              const database = yield* MobileDatabase.make;
              yield* Effect.promise(() =>
                createHeaderUsageHistoryStore(database).save(
                  target,
                  {
                    providerInstanceId: "codex",
                    providerLabel: "Codex",
                    readAt: at,
                    localReadAt: at,
                    localRefreshing: false,
                    account: {
                      balance: 0,
                      balanceKind: "balance",
                      currency: "USD",
                      totalTokens: 0,
                      todayCost: 0,
                      readAt: at,
                      stale: false,
                      message: "",
                      refreshSeconds: 60,
                      sourceId: "cc:accountA",
                    },
                    conversation: counters,
                    allConversations: { ...counters, tokens: 10000 },
                  },
                  true,
                ),
              );
            }),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.promise(() => sqliteDatabase(path));
              const database = yield* MobileDatabase.make;
              const reopened = createHeaderUsageHistoryStore(database);
              const history = yield* Effect.promise(() => reopened.load(target));
              const view = presentHeaderUsageHistory(history, null, "codex", "Codex", false);
              expect(view.data?.account.balance).toBe(0);
              expect(view.data?.account.sourceId).toBe("cc:accountA");
              expect(view.data?.conversation.tokens).toBe(0);
              expect(view.data?.conversation.recentSpeed).toBe(150);
              expect(view.historicalFields.tokens).toBe(at);
              expect(view.historicalFields.recentSpeed).toBe(at);
              expect(
                yield* Effect.promise(() =>
                  reopened.resolveProvider({
                    environmentId,
                    home: false,
                    threadId: "current-thread",
                  }),
                ),
              ).toBe("codex");
              expect(
                (yield* Effect.promise(() =>
                  reopened.load({ ...target, threadId: "other-thread" }),
                )).local,
              ).toBeNull();
              expect(
                (yield* Effect.promise(() => reopened.load({ ...target, home: true }))).local,
              ).toBeNull();
              yield* database.clearEnvironmentCache(environmentId);
              expect((yield* Effect.promise(() => reopened.load(target))).account.entries).toEqual(
                [],
              );
            }),
          );
        }),
      ),
  );

  it.effect("keeps the selected usage range when clearing an environment's cached windows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => sqliteDatabase());
        const database = yield* MobileDatabase.make;
        const preferences = yield* MobilePreferences.MobilePreferencesStore.pipe(
          Effect.provide(MobilePreferences.layer),
          Effect.provideService(MobileDatabase.MobileDatabase, database),
          Effect.provideService(
            MobileSecureStorage,
            MobileSecureStorage.of({
              getItem: () => Effect.succeed(null),
              removeItem: () => Effect.void,
              setItem: () => Effect.void,
            }),
          ),
        );
        expect(yield* preferences.load).toEqual({});
        yield* preferences.savePatch({ usageWindowDays: 90 });
        yield* database.saveCache(otherEnvironment, "usage-summary", "UTC:30", 1, "other");
        yield* database.saveCache(environmentId, "usage-summary", "UTC:30", 1, "30 days");
        yield* database.saveCache(environmentId, "usage-summary", "UTC:90", 1, "90 days");
        expect(yield* database.loadCache(environmentId, "usage-summary", "UTC:30")).toEqual(
          Option.some("30 days"),
        );
        expect(yield* database.loadCache(environmentId, "usage-summary", "UTC:90")).toEqual(
          Option.some("90 days"),
        );
        expect(yield* database.loadCache(environmentId, "usage-summary", "UTC:7")).toEqual(
          Option.none(),
        );
        for (let index = 0; index < 18; index++) {
          yield* database.saveCache(environmentId, "usage-summary", `hour:${index}`, 1, "{}");
        }
        expect(yield* database.listCache("usage-summary")).toHaveLength(17);
        yield* database.clearEnvironmentCache(environmentId);
        expect(yield* database.listCache("usage-summary")).toEqual(["other"]);
        expect(yield* preferences.load).toEqual({ usageWindowDays: 90 });
      }),
    ),
  );

  it.effect("bounds total header history rows and bytes across environments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlite = yield* Effect.promise(() => sqliteDatabase());
        const database = yield* MobileDatabase.make;
        for (let index = 0; index < 270; index++)
          yield* database.saveCache(
            index % 2 ? environmentId : otherEnvironment,
            "header-usage",
            String(index),
            1,
            "{}",
          );
        expect(
          sqlite
            .prepare("SELECT COUNT(*) AS count FROM client_cache WHERE kind = 'header-usage'")
            .get(),
        ).toEqual({ count: 256 });
        yield* database.clearAllCaches;
        for (let index = 0; index < 90; index++)
          yield* database.saveCache(
            environmentId,
            "header-usage",
            String(index),
            1,
            "x".repeat(60_000),
          );
        const row = sqlite
          .prepare(
            "SELECT SUM(LENGTH(CAST(payload AS BLOB))) AS bytes FROM client_cache WHERE kind = 'header-usage'",
          )
          .get() as { bytes: number };
        expect(row.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
        yield* database.saveCache(
          environmentId,
          "header-usage",
          "oversized",
          1,
          "x".repeat(70_000),
        );
        expect(yield* database.loadCache(environmentId, "header-usage", "oversized")).toEqual(
          Option.none(),
        );
      }),
    ),
  );
});
