import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { MobileDatabase } from "../../persistence/mobile-database";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import {
  AccountUsageHistory,
  LocalUsageHistory,
  emptyHeaderUsageHistory,
  mergeHeaderUsageHistory,
  type HeaderUsageHistory,
  type HistoryUsageSummary,
} from "./headerUsageHistory";

export interface HeaderUsageHistoryTarget {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: string;
  readonly home: boolean;
  readonly threadId?: string;
}

export type HeaderUsageHistoryRequest = Omit<HeaderUsageHistoryTarget, "providerInstanceId"> & {
  readonly providerInstanceId?: string;
};

function decode<A>(schema: Schema.Codec<A>, payload: string | null): A | null {
  if (!payload || payload.length > 65_536) return null;
  try {
    return Schema.decodeUnknownSync(schema)(JSON.parse(payload));
  } catch {
    return null;
  }
}

export function createHeaderUsageHistoryStore(
  database: Pick<MobileDatabase["Service"], "loadCache" | "saveCache">,
) {
  const queue = new SerializedAsyncQueue();
  const key = (target: HeaderUsageHistoryTarget, account: boolean) =>
    JSON.stringify(
      account
        ? ["v1", target.providerInstanceId, "account"]
        : [
            "v1",
            target.providerInstanceId,
            target.home ? "home" : "thread",
            target.home ? null : target.threadId,
          ],
    );
  const aliasKey = (target: HeaderUsageHistoryRequest) =>
    JSON.stringify([
      "v1",
      "auto",
      target.home ? "home" : "thread",
      target.home ? null : target.threadId,
    ]);
  const read = async (target: HeaderUsageHistoryTarget): Promise<HeaderUsageHistory> => {
    const load = (account: boolean) =>
      Effect.runPromise(
        database.loadCache(target.environmentId, "header-usage", key(target, account)),
      ).then(Option.getOrNull);
    const [account, local] = await Promise.all([
      load(true),
      target.home || target.threadId ? load(false) : Promise.resolve(null),
    ]);
    return {
      account: decode(AccountUsageHistory, account) ?? emptyHeaderUsageHistory().account,
      local: decode(LocalUsageHistory, local),
    };
  };
  return {
    resolveProvider: (request: HeaderUsageHistoryRequest) =>
      queue.run(async () => {
        if (request.providerInstanceId) return request.providerInstanceId;
        const payload = await Effect.runPromise(
          database.loadCache(request.environmentId, "header-usage", aliasKey(request)),
        ).then(Option.getOrNull);
        return decode(Schema.String, payload);
      }),
    load: (target: HeaderUsageHistoryTarget) => queue.run(() => read(target)),
    save: (target: HeaderUsageHistoryTarget, incoming: HistoryUsageSummary, automatic = false) =>
      queue.run(async () => {
        const previous = await read(target);
        if (incoming.providerInstanceId !== target.providerInstanceId) return previous;
        const next = mergeHeaderUsageHistory(previous, incoming, target.home);
        const encodeAccount = Schema.encodeSync(AccountUsageHistory);
        const encodeLocal = Schema.encodeSync(LocalUsageHistory);
        for (const account of [true, false]) {
          if (!account && !target.home && !target.threadId) continue;
          const payload = account
            ? JSON.stringify(encodeAccount(next.account))
            : next.local
              ? JSON.stringify(encodeLocal(next.local))
              : null;
          const old = account
            ? JSON.stringify(encodeAccount(previous.account))
            : previous.local
              ? JSON.stringify(encodeLocal(previous.local))
              : null;
          if (payload === null || payload === old) continue;
          await Effect.runPromise(
            database.saveCache(
              target.environmentId,
              "header-usage",
              key(target, account),
              1,
              payload,
            ),
          );
        }
        if (automatic) {
          const payload = JSON.stringify(incoming.providerInstanceId);
          const old = await Effect.runPromise(
            database.loadCache(target.environmentId, "header-usage", aliasKey(target)),
          ).then(Option.getOrNull);
          if (payload !== old)
            await Effect.runPromise(
              database.saveCache(
                target.environmentId,
                "header-usage",
                aliasKey(target),
                1,
                payload,
              ),
            );
        }
        return next;
      }),
  };
}
