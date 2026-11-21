// @effect-diagnostics nodeBuiltinImport:off - Place Windows installer checkpoints alongside the updater cache.
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { AppImageUpdater, NsisUpdater, autoUpdater } from "electron-updater";
import type { DownloadExecutorTask } from "electron-updater/out/AppUpdater.js";
import { downloadToFile } from "../downloads/ResumableDownload.ts";

type AutoUpdater = typeof autoUpdater;
type SpawnLog = (cmd: string, args?: Array<string>, ...rest: Array<unknown>) => Promise<boolean>;
type InstallerDownloadOptions = Parameters<DownloadExecutorTask["task"]>[1];

/** @internal */
export async function downloadWindowsInstaller(updater: NsisUpdater): Promise<Array<string>> {
  // Keep NSIS's installer selection, Authenticode check and cache/install hand-off. Only
  // replace the transfer at the executor boundary in electron-updater 6.8.9.
  const { httpExecutor } = updater as unknown as {
    httpExecutor: {
      download: (
        url: URL,
        destination: string,
        options: InstallerDownloadOptions,
      ) => Promise<string>;
    };
  };
  const originalDownload = httpExecutor.download;
  const originalDifferential = updater.disableDifferentialDownload;
  const originalWebInstaller = updater.disableWebInstaller;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  httpExecutor.download = async (url, destination, options) => {
    const sha512 = options.sha512;
    const sha256 = options.sha2;
    const algorithm = sha512 ? "sha512" : "sha256";
    const expectedHex = sha512
      ? /^[0-9a-f]{128}$/i.test(sha512)
        ? sha512.toLowerCase()
        : /^[A-Za-z0-9+/]{86}==$/.test(sha512)
          ? Buffer.from(sha512, "base64").toString("hex")
          : undefined
      : sha256 && /^[0-9a-f]{64}$/i.test(sha256)
        ? sha256.toLowerCase()
        : undefined;
    if (expectedHex === undefined)
      throw new Error("The update manifest has no valid installer checksum.");

    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== undefined) headers.set(name, String(value));
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.cancellationToken.once("cancel", cancel);
    if (options.cancellationToken.cancelled) cancel();
    let previousPercent = -1;
    let previousBytes = 0;
    let previousTime = performance.now();
    try {
      // electron-updater clears its pending directory after a failed download.
      const cacheRoot = NodePath.dirname(NodePath.dirname(destination));
      await downloadToFile({
        fetch: (input, init) => updater.netSession.fetch(input, init),
        url: url.href,
        destination,
        stagingDirectory: NodePath.join(cacheRoot, "t3-installer-download"),
        source: expectedHex,
        headers,
        checksums: [{ algorithm, expectedHex }],
        signal: controller.signal,
        onProgress: ({ receivedBytes, totalBytes }) => {
          if (totalBytes === 0 || !options.onProgress) return;
          const percent = Math.floor((100 * receivedBytes) / totalBytes);
          if (percent === previousPercent) return;
          const now = performance.now();
          const delta =
            previousPercent < 0 || receivedBytes < previousBytes
              ? 0
              : receivedBytes - previousBytes;
          options.onProgress({
            total: totalBytes,
            transferred: receivedBytes,
            delta,
            percent,
            bytesPerSecond: Math.round((delta * 1000) / Math.max(1, now - previousTime)),
          });
          previousPercent = percent;
          previousBytes = receivedBytes;
          previousTime = now;
        },
      });
      return destination;
    } finally {
      options.cancellationToken.removeListener("cancel", cancel);
    }
  };
  try {
    return await updater.downloadUpdate();
  } finally {
    httpExecutor.download = originalDownload;
    updater.disableDifferentialDownload = originalDifferential;
    updater.disableWebInstaller = originalWebInstaller;
  }
}

// Electron holds the AppImage runtime's keepalive pipe and some files without O_CLOEXEC; a
// relaunched AppImage inherits them, so old runtimes and FUSE mounts never exit. bash (AppRun
// already needs it; dash cannot close multi-digit fds) closes them before exec'ing the AppImage.
// -p skips BASH_ENV and exported functions in the helper only; the AppImage still receives both.
const CLOSE_INHERITED_FDS_THEN_EXEC =
  'for fd in /proc/self/fd/*; do fd=${fd##*/}; case $fd in *[!0-9]*|[012]) ;; *) eval "exec $fd>&-" ;; esac; done; exec "$@"';

const relaunchWithoutInheritedDescriptors = (updater: AppImageUpdater) => {
  const spawnLog = (AppImageUpdater.prototype as unknown as { spawnLog: SpawnLog }).spawnLog;
  (updater as unknown as { spawnLog: SpawnLog }).spawnLog = function (cmd, args = [], ...rest) {
    return spawnLog.call(
      this,
      "bash",
      ["-p", "-c", CLOSE_INHERITED_FDS_THEN_EXEC, cmd, cmd, ...args],
      ...rest,
    );
  };
};

export type ElectronUpdaterFeedUrl = Parameters<AutoUpdater["setFeedURL"]>[0];

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")(function (options) {
    return Effect.suspend(() => {
      autoUpdater.setFeedURL(options);
      return Effect.void;
    });
  }),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoDownload = value;
      return Effect.void;
    });
  }),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.autoInstallOnAppQuit = value;
      return Effect.void;
    });
  }),
  setChannel: Effect.fn("ElectronUpdater.setChannel")(function (channel) {
    return Effect.suspend(() => {
      autoUpdater.channel = channel;
      return Effect.void;
    });
  }),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowPrerelease = value;
      return Effect.void;
    });
  }),
  allowDowngrade: Effect.sync(() => autoUpdater.allowDowngrade),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.allowDowngrade = value;
      return Effect.void;
    });
  }),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")(function (value) {
    return Effect.suspend(() => {
      autoUpdater.fullChangelog = value;
      return Effect.void;
    });
  }),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    function (value) {
      return Effect.suspend(() => {
        autoUpdater.disableDifferentialDownload = value;
        return Effect.void;
      });
    },
  ),
  checkForUpdates: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () => autoUpdater.checkForUpdates(),
      catch: (cause) => new ElectronUpdaterCheckForUpdatesError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  downloadUpdate: Effect.suspend(() => {
    const channel = autoUpdater.channel;
    return Effect.tryPromise({
      try: () =>
        autoUpdater instanceof NsisUpdater
          ? downloadWindowsInstaller(autoUpdater)
          : autoUpdater.downloadUpdate(),
      catch: (cause) => new ElectronUpdaterDownloadUpdateError({ channel, cause }),
    }).pipe(Effect.asVoid);
  }),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(function ({
    isSilent,
    isForceRunAfter,
  }) {
    return Effect.suspend(() => {
      const channel = autoUpdater.channel;
      if (autoUpdater instanceof AppImageUpdater) relaunchWithoutInheritedDescriptors(autoUpdater);
      return Effect.try({
        try: () => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      });
    });
  }),
  on: Effect.fn("ElectronUpdater.on")(function (eventName, listener) {
    const eventTarget = autoUpdater as unknown as {
      on: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
      removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => void;
    };
    const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
    return Effect.acquireRelease(
      Effect.sync(() => {
        eventTarget.on(eventName, untypedListener);
      }),
      () =>
        Effect.sync(() => {
          eventTarget.removeListener(eventName, untypedListener);
        }),
    ).pipe(Effect.asVoid);
  }),
});

export const layer = Layer.succeed(ElectronUpdater, make);
