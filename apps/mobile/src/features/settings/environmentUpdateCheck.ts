import type { EnvironmentId, ServerNpmRelease } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { findEnvironmentUpdate } from "./environment-maintenance";

export interface EnvironmentReleaseCheck {
  readonly fromVersion: string;
  readonly targetVersion: string | null;
  readonly manualCheckRequired: boolean;
}

export interface EnvironmentReleaseCheckRequest {
  readonly readServerVersion: (signal: AbortSignal) => Promise<string>;
  readonly lookupRelease?: (signal: AbortSignal) => Promise<ServerNpmRelease | null>;
}

export class EnvironmentUpdateCheckError extends Schema.TaggedError<EnvironmentUpdateCheckError>()(
  "EnvironmentUpdateCheckError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const asError = (cause: unknown) =>
  new EnvironmentUpdateCheckError({
    message: cause instanceof Error ? cause.message : "Could not check for updates.",
    cause,
  });

/** User-initiated only; screen disposal interrupts the remote lookup and its RPC. */
export const environmentReleaseCheckAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.fn((request: EnvironmentReleaseCheckRequest) =>
    Effect.tryPromise({
      try: async (signal) => {
        const fromVersion = await request.readServerVersion(signal);
        const result = await findEnvironmentUpdate(fromVersion, signal, request.lookupRelease);
        return { fromVersion, ...result } satisfies EnvironmentReleaseCheck;
      },
      catch: asError,
    }).pipe(
      Effect.timeoutOrElse({
        duration: "20 seconds",
        orElse: () =>
          Effect.fail(
            new EnvironmentUpdateCheckError({
              message: "检查更新超时，请重试。",
            }),
          ),
      }),
    ),
  ).pipe(Atom.withLabel(`mobile:environment-release-check:${environmentId}`)),
);

export function releaseCheckValue(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): EnvironmentReleaseCheck | null {
  return AsyncResult.getOrElse(result, () => null);
}

export function releaseCheckError(
  result: AsyncResult.AsyncResult<EnvironmentReleaseCheck, Error>,
): string | null {
  if (!AsyncResult.isFailure(result) || result.waiting) return null;
  return Option.getOrNull(AsyncResult.error(result))?.message ?? null;
}
