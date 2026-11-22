import { USAGE_SUMMARY_QUERY_LABEL } from "@t3tools/client-runtime/state/server";
import { EnvironmentQueryStore } from "@t3tools/client-runtime/state/query-persistence";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { MobileDatabase } from "../persistence/mobile-database";

const usageKeyPrefix = JSON.stringify([USAGE_SUMMARY_QUERY_LABEL]).slice(0, -1) + ",";
const queryKind = (key: string) =>
  key.startsWith(usageKeyPrefix) ? "usage-summary" : "pull-request";

export const layer = Layer.effect(
  EnvironmentQueryStore,
  Effect.gen(function* () {
    const database = yield* MobileDatabase;
    return {
      load: (environmentId, key) =>
        database
          .loadCache(environmentId, queryKind(key), `v1:${key}`)
          .pipe(Effect.catch(() => Effect.succeedNone)),
      save: (environmentId, key, payload) =>
        database
          .saveCache(environmentId, queryKind(key), `v1:${key}`, 1, payload)
          .pipe(Effect.catch(() => Effect.logWarning("Offline query database save failed"))),
    } satisfies NonNullable<typeof EnvironmentQueryStore.Service>;
  }),
);
