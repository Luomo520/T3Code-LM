// @effect-diagnostics nodeBuiltinImport:off -- Intercepts the spawn electron-updater requires natively.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { NsisUpdater, autoUpdater } from "electron-updater";
import type * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import { vi } from "vite-plus/test";

// electron-updater requires Electron natively, outside vi.mock's reach, and builds its
// autoUpdater singleton as soon as it is imported.
vi.hoisted(() => {
  const NodeModule = process.getBuiltinModule("node:module");
  const NodeEvents = process.getBuiltinModule("node:events");
  const require = NodeModule.createRequire(import.meta.url);
  const electronPath = NodeModule.createRequire(require.resolve("electron-updater")).resolve(
    "electron",
  );
  const electronModule = new NodeModule.Module(electronPath);
  electronModule.filename = electronPath;
  electronModule.loaded = true;
  electronModule.exports = {
    app: {
      getVersion: () => "1.0.0",
      getName: () => "T3 Code",
      isPackaged: true,
      quit: () => undefined,
      once: () => undefined,
    },
    autoUpdater: new NodeEvents.EventEmitter(),
  };
  require.cache[electronPath] = electronModule;
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process") as {
  spawn: (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => NodeChildProcess.ChildProcess;
};

it.live("hands the verified Windows download to the existing NSIS install cache", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-nsis-download-" });
    const updater = new NsisUpdater();
    updater.logger = null;
    updater.autoInstallOnAppQuit = false;
    const installer = "installer fixture";
    const url = new URL("https://example.test/update.exe");
    Object.assign(updater, {
      app: { name: "T3 Code", baseCachePath: directory },
      configOnDisk: {
        value: Promise.resolve({ publisherName: "Publisher", updaterCacheDirName: "cache" }),
      },
      updateInfoAndProvider: {
        info: { version: "1.0.1", files: [{ url: "update.exe" }] },
        provider: {
          fileExtraDownloadHeaders: null,
          resolveFiles: () => [
            {
              url,
              info: {
                url: "update.exe",
                sha512: NodeCrypto.createHash("sha512").update(installer).digest("base64"),
              },
            },
          ],
        },
      },
    });
    Object.defineProperty(updater, "netSession", {
      value: {
        fetch: async () =>
          new Response(installer, { headers: { "content-length": String(installer.length) } }),
      },
    });
    const verify = vi.fn().mockResolvedValue(null);
    updater.verifyUpdateCodeSignature = verify;
    const progress: number[] = [];
    const downloaded: string[] = [];
    updater.on("download-progress", (event) => progress.push(event.percent));
    updater.on("update-downloaded", (event) => downloaded.push(event.downloadedFile));
    const [path] = yield* Effect.promise(() => ElectronUpdater.downloadWindowsInstaller(updater));
    assert.isDefined(path);
    assert.deepEqual(downloaded, [path]);
    assert.deepEqual(progress, [0, 100]);
    assert.deepEqual(verify.mock.calls[0]?.[0], ["Publisher"]);
    assert.equal(yield* fileSystem.readFileString(path!), installer);
  }).pipe(Effect.provide(NodeServices.layer)),
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "ElectronUpdater AppImage install",
  () => {
    it.live("relaunches the installed AppImage without the updating process's descriptors", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-appimage-install-" });
        const appImagePath = path.join(dir, "T3-Code.AppImage");
        const stagedPath = path.join(dir, "T3-Code-1.0.1.AppImage");
        const fdReportPath = path.join(dir, "relaunched-fds.txt");
        yield* fileSystem.writeFileString(appImagePath, "old AppImage");
        yield* fileSystem.writeFileString(
          stagedPath,
          `#!/bin/sh\nls /proc/self/fd > '${fdReportPath}'\n`,
        );
        yield* fileSystem.chmod(stagedPath, 0o755);

        yield* Effect.acquireRelease(
          Effect.sync(() => vi.stubEnv("APPIMAGE", appImagePath)),
          () => Effect.sync(() => vi.unstubAllEnvs()),
        );

        autoUpdater.logger = null;
        Object.assign(autoUpdater, {
          downloadedUpdateHelper: {
            file: stagedPath,
            downloadedFileInfo: { isAdminRightsRequired: false },
          },
        });

        // Electron's main process holds the AppImage runtime's keepalive pipe and some
        // Chromium files without O_CLOEXEC. Node cannot hold such a descriptor, so the
        // relaunch runs with fd 7 opened that way to stand in for them.
        const relaunched = yield* Deferred.make<void>();
        const realSpawn = childProcess.spawn;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            childProcess.spawn = (command, args, options) => {
              const child = realSpawn(
                "bash",
                ["-c", 'exec 7</dev/null; exec "$@"', "leaky-parent", command, ...args],
                options,
              );
              child.once("exit", () => Deferred.doneUnsafe(relaunched, Effect.void));
              return child;
            };
            NodeModule.syncBuiltinESMExports();
          }),
          () =>
            Effect.sync(() => {
              childProcess.spawn = realSpawn;
              NodeModule.syncBuiltinESMExports();
            }),
        );

        const electronUpdater = yield* ElectronUpdater.ElectronUpdater;
        yield* electronUpdater.quitAndInstall({ isSilent: true, isForceRunAfter: true });
        yield* Deferred.await(relaunched);

        const descriptors = (yield* fileSystem.readFileString(fdReportPath)).trim().split("\n");
        assert.notInclude(
          descriptors,
          "7",
          `relaunched AppImage inherited the updating process's fd 7 (open fds: ${descriptors.join(" ")})`,
        );
      }).pipe(Effect.provide([ElectronUpdater.layer, NodeServices.layer])),
    );
  },
);
