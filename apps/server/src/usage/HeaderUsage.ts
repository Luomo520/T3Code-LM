import { headerUsageRequestTiming } from "./headerUsageRequestTiming.ts";
import * as Option from "effect/Option";
import {
  CodexSettings,
  type HeaderUsageInput,
  type HeaderUsageSummary,
  UsageReadError,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerSettings from "../serverSettings.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { ServerConfig } from "../config.ts";
import { HeaderUsageTimingHistory } from "./headerUsageTimingHistory.ts";
import { headerUsageTiming } from "./headerUsageTiming.ts";
import {
  aggregateHeaderRequests,
  HeaderTranscriptCache,
  type HeaderTurnRef,
} from "./headerUsageScan.ts";
import { BillingCache, emptyAccount, object, querySub2Api, usageUrl } from "./sub2api.ts";
import {
  billingSourceId,
  CcSwitchBillingSource,
  type HeaderBillingSource,
} from "./ccSwitchBilling.ts";

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const encodeDirectories = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);

export const makeHeaderUsage = Effect.fn("makeHeaderUsage")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const hostEnvironment = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const clock = yield* Clock.Clock;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  const serverConfig = yield* ServerConfig;
  const billing = new BillingCache(() => clock.currentTimeMillisUnsafe());
  const ccSwitch = new CcSwitchBillingSource({
    home,
    platform,
    environment: hostEnvironment,
    now: () => clock.currentTimeMillisUnsafe(),
  });
  const transcripts = new HeaderTranscriptCache();
  const timingHistory = new HeaderUsageTimingHistory(serverConfig.providerLogsDir);
  const local = new Map<
    string,
    {
      due: number;
      activeUntil: number;
      readAt: string | null;
      pending?: Promise<void> | undefined;
      records: Awaited<ReturnType<HeaderTranscriptCache["scan"]>>;
    }
  >();

  const readReferences = yield* sql<{
    thread_id: string;
    instance_id: string;
    driver: string;
    native_session: string | null;
    native_turn: string | null;
    status: string;
    updated_at: string;
  }>`SELECT t.thread_id, p.provider_instance_id AS instance_id, p.driver,
      COALESCE(json_extract(a.payload_json, '$.nativeThreadId'), json_extract(p.payload_json, '$.nativeThreadRef.nativeId')) AS native_session,
      json_extract(t.payload_json, '$.nativeTurnRef.nativeId') AS native_turn,
      t.status, p.updated_at
      FROM orchestration_v2_projection_provider_turns t
      JOIN orchestration_v2_projection_provider_threads p ON t.provider_thread_id = p.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id AND a.thread_id = t.thread_id
      ORDER BY p.updated_at DESC, t.ordinal DESC`.pipe(
    NodeSqliteClient.readOnly,
    Effect.mapError(
      () =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Could not read conversation usage references.",
        }),
    ),
    Effect.cachedWithTTL("2 seconds"),
  );

  const read = Effect.fn("HeaderUsage.read")(function* (input: HeaderUsageInput) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read usage configuration.",
          }),
      ),
    );
    const rows = yield* readReferences;
    const configured = Object.entries(settings.providerInstances).filter(
      ([, instance]) =>
        object(instance.config).billingSource === "ccSwitch" ||
        (typeof object(instance.config).billingUrl === "string" &&
          Boolean(object(instance.config).billingUrl)),
    );
    const current =
      input.providerInstanceId ??
      (input.threadId
        ? rows.find((row) => row.thread_id === input.threadId)?.instance_id
        : undefined) ??
      rows.find((row) => configured.some(([id]) => id === row.instance_id))?.instance_id ??
      configured[0]?.[0] ??
      rows[0]?.instance_id ??
      null;
    const instance = Object.entries(settings.providerInstances).find(([id]) => id === current)?.[1];
    const config = object(instance?.config);
    const environment = yield* mergeProviderInstanceEnvironment(
      instance?.environment,
      hostEnvironment,
    );
    const seconds = config.billingRefreshSeconds === "30" ? 30 : 60;
    const manualUrl = typeof config.billingUrl === "string" ? config.billingUrl.trim() : "";
    // An explicit query endpoint needs an explicit query key; never send an ambient unrelated key there.
    const manualKey = typeof config.billingKey === "string" ? config.billingKey : "";
    const automaticUrl =
      instance?.driver === "codex"
        ? (environment.OPENAI_BASE_URL ?? "")
        : instance?.driver === "claudeAgent"
          ? (environment.ANTHROPIC_BASE_URL ?? "")
          : "";
    const automaticKey =
      instance?.driver === "codex" ? environment.OPENAI_API_KEY : environment.ANTHROPIC_AUTH_TOKEN;
    const address = manualUrl || automaticUrl;
    const key = manualUrl ? manualKey : automaticKey;
    const source: HeaderBillingSource =
      config.billingSource === "ccSwitch"
        ? instance?.driver === "codex"
          ? yield* Effect.promise(() => ccSwitch.read())
          : {
              sourceId: billingSourceId("ccSwitch", current, "unsupported-driver"),
              sourceLabel: "CC Switch · Codex",
              message: "CC Switch 余额跟随目前仅支持 Codex 实例。",
            }
        : {
            sourceId: billingSourceId("environment", current, address, key ?? ""),
            sourceLabel: instance?.displayName ?? "当前环境",
            url: address,
            ...(key ? { key } : {}),
          };
    let account = emptyAccount(source.message, seconds);
    if (!source.message && source.url && source.key) {
      const url = yield* Effect.try({
        try: () => usageUrl(source.url!),
        catch: () => new UsageReadError({ reason: "invalidWindow", detail: "Invalid billing URL" }),
      }).pipe(Effect.option);
      account = Option.isSome(url)
        ? billing.read(
            source.sourceId,
            () => querySub2Api(url.value, source.key!, seconds),
            seconds,
            undefined,
            input.refresh === true,
          )
        : emptyAccount("查询网址无效，请在供应商设置检查。", seconds);
    }
    account = { ...account, sourceId: source.sourceId, sourceLabel: source.sourceLabel };
    const relevant = rows.filter((row) => row.instance_id === current && row.driver === "codex");
    const refs: HeaderTurnRef[] = rows
      .filter((row) => row.driver === "codex" && row.native_session && row.native_turn)
      .map((row) => ({
        threadId: row.thread_id,
        providerInstanceId: row.instance_id,
        sessionId: row.native_session!,
        turnId: row.native_turn!,
      }));
    const directories: string[] = [];
    if (instance?.driver === "codex" || (!instance && current === "codex")) {
      const codex = yield* decodeCodexSettings(instance?.config ?? {}).pipe(
        Effect.mapError(
          () =>
            new UsageReadError({
              reason: "scanFailed",
              detail: "Could not decode Codex usage configuration.",
            }),
        ),
      );
      const environmentHome = environment.CODEX_HOME?.trim();
      const layout = yield* resolveCodexHomeLayout(
        codex.setupMode !== "managed" &&
          !codex.homePath.trim() &&
          !codex.shadowHomePath.trim() &&
          environmentHome
          ? { ...codex, homePath: environmentHome }
          : codex,
      );
      directories.push(
        path.join(layout.sharedHomePath, "sessions"),
        path.join(layout.sharedHomePath, "archived_sessions"),
      );
    }
    const localKey = encodeDirectories([current, ...directories]);
    let entry = local.get(localKey);
    if (!entry) {
      entry = { due: 0, activeUntil: 0, readAt: null, records: { records: [], partial: true } };
      local.set(localKey, entry);
      if (local.size > 16) local.delete(local.keys().next().value!);
    }
    const now = clock.currentTimeMillisUnsafe();
    if (relevant.some((row) => row.status === "running")) entry.activeUntil = now + 15000;
    if (directories.length && now >= entry.due && !entry.pending) {
      const target = entry;
      target.pending = Promise.all([
        transcripts.scan(
          directories,
          new Set(
            refs.filter((ref) => ref.providerInstanceId === current).map((ref) => ref.sessionId),
          ),
        ),
        timingHistory.scan(refs),
      ])
        .then(
          ([records]) => {
            target.records = records;
            target.readAt = DateTime.formatIso(
              DateTime.makeUnsafe(clock.currentTimeMillisUnsafe()),
            );
          },
          () => {
            target.records = { ...target.records, partial: true };
          },
        )
        .finally(() => {
          const completedAt = clock.currentTimeMillisUnsafe();
          target.due = completedAt + (completedAt <= target.activeUntil ? 2000 : 12_000);
          target.pending = undefined;
        });
    }
    // A cold client must not receive an empty placeholder while recoverable
    // backend history is still loading. Later refreshes keep the cached result.
    const initialRead = entry.readAt === null ? entry.pending : undefined;
    if (initialRead) yield* Effect.promise(() => initialRead);
    const records = entry.records.records;
    const partial =
      entry.records.partial ||
      directories.length === 0 ||
      relevant.some((row) => !row.native_session || !row.native_turn);
    const conversation = aggregateHeaderRequests(
      records,
      refs,
      input.threadId,
      partial,
      current ?? undefined,
      (request) => headerUsageTiming.lookup(request) ?? timingHistory.lookup(request),
      (request) => headerUsageRequestTiming.lookup(request) ?? timingHistory.lookupRequest(request),
      now,
    );
    return {
      providerInstanceId: current,
      providerLabel: instance?.displayName ?? current ?? "未选择供应商",
      readAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      localReadAt: entry.readAt,
      localRefreshing: Boolean(entry.pending),
      account,
      conversation,
      allConversations: aggregateHeaderRequests(
        records,
        refs,
        undefined,
        partial,
        current ?? undefined,
        (request) => headerUsageTiming.lookup(request) ?? timingHistory.lookup(request),
        (request) =>
          headerUsageRequestTiming.lookup(request) ?? timingHistory.lookupRequest(request),
        now,
      ),
    } satisfies HeaderUsageSummary;
  });
  return Object.assign(read, {
    awaitIdle: async () => {
      await Promise.all([...local.values()].map((entry) => entry.pending));
      await billing.awaitIdle();
    },
  });
});
