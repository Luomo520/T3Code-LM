import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { DesktopUpdateState, DesktopUpdateStatusReport } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as DesktopAppUpdate from "./DesktopAppUpdate.ts";

function makeState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "idle",
    channel: "latest",
    currentVersion: "1.2.3",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
    omittedReleaseCount: 0,
    ...overrides,
  };
}

function report(
  requestId: string,
  state: DesktopUpdateState,
  terminal?: {
    readonly outcome: DesktopUpdateStatusReport["outcome"];
    readonly reason?: string;
  },
): DesktopUpdateStatusReport {
  return {
    version: 1,
    type: "desktopUpdateStatus",
    requestId,
    ...(terminal?.outcome === undefined ? {} : { outcome: terminal.outcome }),
    ...(terminal?.reason === undefined ? {} : { reason: terminal.reason }),
    state,
  };
}

interface HarnessOptions {
  readonly mode?: "web" | "desktop";
  readonly controlFd?: number | undefined;
  readonly reports?: (requestId: string, attempt: number) => readonly DesktopUpdateStatusReport[];
  readonly keepOpen?: boolean;
}

const makeHarness = Effect.fn("test.make_desktop_app_update_harness")(function* (
  options: HarnessOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-app-update-test-" });
  let requestIdDeferred = yield* Deferred.make<string>();
  const requested: string[] = [];
  const cancelled: string[] = [];
  const baseConfig = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );
  const config: ServerConfig.ServerConfig["Service"] = {
    ...baseConfig,
    mode: options.mode ?? "desktop",
    ...("controlFd" in options
      ? { desktopTelemetryControlFd: options.controlFd }
      : { desktopTelemetryControlFd: 5 }),
  };
  const reportsForRun = options.reports ?? (() => []);

  const service = yield* DesktopAppUpdate.make().pipe(
    Effect.provide(
      Layer.mergeAll(
        DesktopTelemetryReceiver.layerTest({
          requestDesktopUpdate: (requestId) =>
            Effect.sync(() => void requested.push(requestId)).pipe(
              Effect.andThen(Deferred.succeed(requestIdDeferred, requestId)),
              Effect.asVoid,
            ),
          cancelDesktopUpdate: (requestId) =>
            Effect.gen(function* () {
              cancelled.push(requestId);
              requestIdDeferred = yield* Deferred.make<string>();
            }),
          desktopUpdates: Effect.sync(() => ({
            latest: Option.none<DesktopUpdateStatusReport>(),
            changes: Stream.unwrap(
              Deferred.await(requestIdDeferred).pipe(
                Effect.map((requestId) => {
                  const emitted = Stream.fromIterable(
                    reportsForRun(requestId, requested.indexOf(requestId) + 1),
                  );
                  return options.keepOpen ? Stream.concat(emitted, Stream.never) : emitted;
                }),
              ),
            ),
          })),
        }),
        ServerConfig.layer(config),
      ),
    ),
  );
  return { service, requested, cancelled };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("desktop app update", (it) => {
  it.effect("forwards distinct download percentages and signals installation", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "checking" })),
          report(requestId, makeState({ status: "available", availableVersion: "1.2.4" })),
          report(requestId, makeState({ status: "downloading", downloadPercent: 40 })),
          report(requestId, makeState({ status: "downloading", downloadPercent: 40 })),
          report(requestId, makeState({ status: "downloading", downloadPercent: 85 })),
          report("other-run", makeState({ status: "error", message: "unrelated" })),
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
        ],
      });
      const progress: Array<[string, number | undefined]> = [];
      const result = yield* service.run((stage, download) =>
        Effect.sync(() => void progress.push([stage, download?.downloadPercent])),
      );
      expect(result).toEqual({
        targetVersion: "1.2.4",
        method: "desktop-app",
        desktopUpdateToken: expect.any(String),
      });
      expect(progress).toEqual([
        ["downloading", undefined],
        ["downloading", 40],
        ["downloading", 85],
        ["installing", undefined],
      ]);

      const retry = yield* service.run(() => Effect.void).pipe(Effect.flip);
      expect(retry.reason).not.toBe("A desktop app update is already in progress.");
    }),
  );

  it.effect.each(["1.2.5", null])(
    "cancels a prepared update with downloaded version %s and permits a matching retry",
    (mismatchedVersion) =>
      Effect.gen(function* () {
        const confirmedVersion = "1.2.4";
        const { service, requested, cancelled } = yield* makeHarness({
          reports: (requestId, attempt) => [
            report(
              requestId,
              makeState({
                status: "downloaded",
                availableVersion: confirmedVersion,
                downloadedVersion: attempt === 1 ? mismatchedVersion : confirmedVersion,
              }),
              { outcome: "ready-to-install" },
            ),
          ],
        });

        const rejected = yield* service
          .run(() => Effect.void, undefined, confirmedVersion)
          .pipe(Effect.flip);
        expect(rejected.reason).toContain(confirmedVersion);
        expect(cancelled).toEqual([requested[0]]);

        const prepared = yield* service.run(() => Effect.void, undefined, confirmedVersion);
        expect(prepared).toEqual({
          targetVersion: confirmedVersion,
          method: "desktop-app",
          desktopUpdateToken: requested[1],
        });
        expect(prepared.desktopUpdateToken).not.toBe(cancelled[0]);
      }),
  );

  it.effect("succeeds without an install when a track switch finds the host current", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "up-to-date", currentVersion: "1.2.3" }), {
            outcome: "up-to-date",
          }),
        ],
      });
      const trackSwitch = { channel: "latest" as const, targetVersion: "1.2.3" };

      expect(yield* service.run(() => Effect.void, trackSwitch)).toEqual({
        targetVersion: "1.2.3",
        method: "desktop-app",
      });
    }),
  );

  it.effect("replays a retained commit failure for the preparation token", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [
          report(requestId, makeState({ status: "downloaded", downloadedVersion: "1.2.4" }), {
            outcome: "ready-to-install",
          }),
          report(
            requestId,
            makeState({
              status: "downloaded",
              downloadedVersion: "1.2.4",
              errorContext: "install",
              message: "installer refused",
            }),
            { outcome: "failed", reason: "installer refused" },
          ),
        ],
      });
      const prepared = yield* service.run(() => Effect.void);

      expect(
        (yield* service.commit(prepared.desktopUpdateToken ?? "missing").pipe(Effect.flip)).reason,
      ).toBe("installer refused");
    }),
  );

  it.effect("fails when the desktop stops reporting before a terminal outcome", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({
        reports: (requestId) => [report(requestId, makeState({ status: "checking" }))],
      });
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "The desktop app stopped reporting its update.",
      );
    }),
  );

  it.effect("allows only one desktop update at a time", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness({ reports: () => [], keepOpen: true });
      const first = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(first);

      const retry = yield* Effect.forkChild(
        service.run(() => Effect.void),
        {
          startImmediately: true,
        },
      );
      yield* Effect.yieldNow;
      expect((yield* service.run(() => Effect.void).pipe(Effect.flip)).reason).toBe(
        "A desktop app update is already in progress.",
      );
      yield* Fiber.interrupt(retry);
    }),
  );
});
