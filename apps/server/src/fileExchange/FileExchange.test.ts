// @effect-diagnostics nodeBuiltinImport:off - 测试使用真实 SFTP 子系统和隔离的本地目录。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";
import * as FileExchange from "./FileExchange.ts";
import { exchangeWorkspaceKey, isWindowsExchangeName, readTargets } from "./config.ts";
import { SftpSession } from "./SftpSession.ts";
import { openWindowsExchangeDirectory } from "./WindowsExchangeDirectory.ts";

const sftpServer = ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"].find(
  (entry) => NodeFS.existsSync(entry),
);

const fixture = Effect.fn("FileExchange.test.fixture")(function* (
  onSession?: Parameters<typeof FileExchange.layerForSftpTest>[2],
) {
  if (sftpServer === undefined) throw new Error("OpenSSH sftp-server was not installed.");
  const directory = yield* Effect.acquireRelease(
    Effect.promise(async () =>
      NodeFSP.mkdtemp(NodePath.join(await NodeFSP.realpath(NodeOS.tmpdir()), "t3-sftp-")),
    ),
    (path) => Effect.promise(() => NodeFSP.rm(path, { force: true, recursive: true })),
  );
  const workspaceRoot = NodePath.join(directory, "work");
  const local = NodePath.join(workspaceRoot, "exchange");
  const remote = NodePath.join(directory, "remote");
  yield* Effect.promise(() =>
    Promise.all([NodeFSP.mkdir(local, { recursive: true }), NodeFSP.mkdir(remote)]),
  );
  return {
    directory,
    local,
    remote,
    workspaceRoot,
    layer: FileExchange.layerForSftpTest(
      [
        {
          deviceId: "fixture-device",
          sshAlias: "fixture",
          workspaceRoot,
          localDirectory: "exchange",
          remoteDirectory: remote,
        },
      ],
      sftpServer,
      onSession,
    ),
  };
});

describe("Windows SFTP workspace registration", () => {
  const target = {
    deviceId: "fixture-device",
    sshAlias: "fixture",
    workspaceRoot: "C:/Work/Project",
    localDirectory: "exchange",
    remoteDirectory: "/exchange",
  };

  it("accepts a drive path and preserves case in registered directory names", () => {
    expect(readTargets(JSON.stringify([target]), "win32")).toEqual([target]);
    expect(exchangeWorkspaceKey("c:/Work/Project/", "win32")).toBe(
      exchangeWorkspaceKey(target.workspaceRoot, "win32"),
    );
    expect(exchangeWorkspaceKey("C:/Work/project", "win32")).not.toBe(
      exchangeWorkspaceKey(target.workspaceRoot, "win32"),
    );
    expect(
      readTargets(
        JSON.stringify([target, { ...target, workspaceRoot: "c:/Work/Project" }]),
        "win32",
      ),
    ).toEqual([]);
  });

  it("rejects Win32 devices, streams and paths outside a drive root", () => {
    for (const workspaceRoot of [
      "/exchange",
      "C:project",
      "C:/Work/../outside",
      String.raw`\\host\share`,
      String.raw`\\?\C:\Work`,
      "C:/Work/aux.txt",
    ]) {
      expect(readTargets(JSON.stringify([{ ...target, workspaceRoot }]), "win32")).toEqual([]);
    }
    for (const fileName of [
      "name.txt:stream",
      "NUL.txt",
      "COM¹",
      "name. ",
      "name.",
      "outside/nested",
    ]) {
      expect(isWindowsExchangeName(fileName)).toBe(false);
    }
    expect(isWindowsExchangeName("报告 1.bin")).toBe(true);
  });
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "Windows exchange file handles",
  () => {
    it.live("pins directories, detects hard links and publishes only an unused name", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.acquireRelease(
            Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-win-sftp-"))),
            (path) => Effect.promise(() => NodeFSP.rm(path, { force: true, recursive: true })),
          );
          yield* Effect.promise(async () => {
            const exchange = NodePath.join(root, "exchange");
            const outside = NodePath.join(root, "outside");
            const path = (name: string) => NodePath.join(exchange, name);
            await Promise.all([NodeFSP.mkdir(exchange), NodeFSP.mkdir(outside)]);
            await NodeFSP.symlink(outside, NodePath.join(root, "junction"), "junction");
            const target = {
              deviceId: "fixture",
              sshAlias: "fixture",
              workspaceRoot: root,
              localDirectory: "exchange",
              remoteDirectory: "/exchange",
            };
            await expect(
              openWindowsExchangeDirectory({ ...target, localDirectory: "junction" }),
            ).rejects.toThrow("reparse points");
            const bytes = NodeCrypto.randomBytes(9 * 1024 * 1024 + 3);
            await NodeFSP.writeFile(path("源.bin"), bytes);
            await NodeFSP.writeFile(path("linked.bin"), "hard link source");
            await NodeFSP.link(path("linked.bin"), path("alias.bin"));

            const local = await openWindowsExchangeDirectory(target);
            try {
              await expect(
                NodeFSP.rename(exchange, NodePath.join(root, "moved")),
              ).rejects.toThrow();
              const linked = await local.source("alias.bin");
              try {
                expect((await linked.stat()).nlink).toBe(2);
              } finally {
                await linked.close();
              }

              const source = await local.source("源.bin");
              const stage = await local.stage(".t3-stage");
              try {
                const hash = NodeCrypto.createHash("sha256");
                const buffer = Buffer.alloc(64 * 1024);
                for (let offset = 0; offset < bytes.length;) {
                  const { bytesRead } = await source.read(
                    buffer,
                    0,
                    Math.min(buffer.length, bytes.length - offset),
                    offset,
                  );
                  expect(bytesRead).toBeGreaterThan(0);
                  expect((await stage.file.write(buffer, 0, bytesRead, offset)).bytesWritten).toBe(
                    bytesRead,
                  );
                  hash.update(buffer.subarray(0, bytesRead));
                  offset += bytesRead;
                }
                expect(hash.digest("hex")).toBe(
                  NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
                );
                await stage.file.sync();
                expect((await stage.file.stat()).size).toBe(bytes.length);
                await expect(stage.publish("源.bin")).rejects.toThrow();
                await stage.publish("received.bin");
              } finally {
                await source.close();
                await stage.close();
              }
              expect((await NodeFSP.readFile(path("received.bin"))).equals(bytes)).toBe(true);
              expect((await NodeFSP.readFile(path("源.bin"))).equals(bytes)).toBe(true);
              const abandoned = await local.stage(".t3-abandoned");
              await abandoned.close();
              expect((await NodeFSP.readdir(exchange)).sort()).toEqual([
                "alias.bin",
                "linked.bin",
                "received.bin",
                "源.bin",
              ]);
            } finally {
              await local.close();
            }
          });
        }),
      ),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux" || sftpServer === undefined)(
  "OpenSSH SFTP file exchange",
  () => {
    it.live(
      "transfers binary data both ways, verifies digests, and leaves the original intact",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { local, remote, workspaceRoot, layer } = yield* fixture();
            const bytes = NodeCrypto.randomBytes(9 * 1024 * 1024);
            const source = NodePath.join(local, "报告 1.bin");
            const expectedSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
            yield* Effect.promise(() => NodeFSP.writeFile(source, bytes));
            yield* Effect.gen(function* () {
              const service = yield* FileExchange.FileExchange;
              const base = { deviceId: "fixture-device", workspaceRoot, expectedSha256 };
              const sent = yield* service.transfer({
                ...base,
                direction: "send",
                localName: "报告 1.bin",
                remoteName: "remote copy.bin",
              });
              expect(sent).toEqual({
                deviceId: "fixture-device",
                direction: "send",
                workspacePath: "exchange/报告 1.bin",
                remoteName: "remote copy.bin",
                sha256: expectedSha256,
                sizeBytes: bytes.length,
              });
              const received = yield* service.transfer({
                ...base,
                direction: "receive",
                localName: "第二份.bin",
                remoteName: "remote copy.bin",
              });
              expect(received.sha256).toBe(expectedSha256);
              expect(received.sizeBytes).toBe(bytes.length);
            }).pipe(Effect.provide(layer));
            const [original, copy, uploaded, remoteEntries] = yield* Effect.promise(() =>
              Promise.all([
                NodeFSP.readFile(source),
                NodeFSP.readFile(NodePath.join(local, "第二份.bin")),
                NodeFSP.readFile(NodePath.join(remote, "remote copy.bin")),
                NodeFSP.readdir(remote),
              ]),
            );
            expect(original.equals(bytes)).toBe(true);
            expect(copy.equals(bytes)).toBe(true);
            expect(uploaded.equals(bytes)).toBe(true);
            expect(remoteEntries).toEqual(["remote copy.bin"]);
          }),
        ),
    );

    for (const direction of ["send", "receive"] as const) {
      it.live(`resumes a large ${direction} from its confirmed offset after SFTP disconnects`, () =>
        Effect.scoped(
          Effect.gen(function* () {
            const offsets =
              direction === "send"
                ? vi.spyOn(SftpSession.prototype, "writeChunks")
                : vi.spyOn(SftpSession.prototype, "readChunks");
            yield* Effect.addFinalizer(() => Effect.sync(() => offsets.mockRestore()));
            let sessions = 0;
            const { local, remote, workspaceRoot, layer } = yield* fixture((child) => {
              if (++sessions !== 1) return;
              let responseBytes = 0;
              const threshold = direction === "send" ? 2_400 : 2 * 1024 * 1024;
              child.stdout.on("data", (chunk: Buffer) => {
                responseBytes += chunk.length;
                if (responseBytes > threshold) child.kill("SIGKILL");
              });
            });
            const bytes = NodeCrypto.randomBytes(9 * 1024 * 1024 + 3);
            const expectedSha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
            const fileName = "resume.bin";
            const source = NodePath.join(direction === "send" ? local : remote, fileName);
            const destination = NodePath.join(direction === "send" ? remote : local, fileName);
            yield* Effect.promise(() => NodeFSP.writeFile(source, bytes));

            const receipt = yield* Effect.gen(function* () {
              const service = yield* FileExchange.FileExchange;
              return yield* service.transfer({
                deviceId: "fixture-device",
                workspaceRoot,
                expectedSha256,
                direction,
                localName: fileName,
              });
            }).pipe(Effect.provide(layer));

            const confirmedOffsets = offsets.mock.calls.map((args) =>
              direction === "send" ? Number(args[1]) : Number(args[2]),
            );
            expect(sessions).toBe(2);
            expect(confirmedOffsets[0]).toBe(0);
            expect(confirmedOffsets[1]).toBeGreaterThan(0);
            expect(receipt).toMatchObject({ sizeBytes: bytes.length, sha256: expectedSha256 });
            expect((yield* Effect.promise(() => NodeFSP.readFile(destination))).equals(bytes)).toBe(
              true,
            );
            expect(yield* Effect.promise(() => NodeFSP.readdir(local))).toEqual([fileName]);
            expect(yield* Effect.promise(() => NodeFSP.readdir(remote))).toEqual([fileName]);
          }),
        ),
      );
    }

    it.live("moves a verified file in both directions and leaves it on destination failure", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { local, remote, workspaceRoot, layer } = yield* fixture();
          const name = "move.bin";
          const bytes = Buffer.from("move only after verification");
          const source = NodePath.join(local, name);
          const target = NodePath.join(remote, name);
          yield* Effect.promise(() => NodeFSP.writeFile(source, bytes));
          yield* Effect.gen(function* () {
            const exchange = yield* FileExchange.FileExchange;
            const input = {
              deviceId: "fixture-device",
              workspaceRoot,
              localName: name,
              mode: "move" as const,
            };
            const invalid = yield* Effect.result(
              exchange.transfer({
                ...input,
                direction: "send",
                expectedSha256: "0".repeat(64),
              }),
            );
            expect(invalid._tag).toBe("Failure");
            expect(yield* Effect.promise(() => NodeFSP.readFile(source))).toEqual(bytes);
            expect(
              (yield* exchange.transfer({ ...input, direction: "send" })).sourceDisposition,
            ).toEqual({ status: "removed" });
            expect(yield* Effect.promise(() => NodeFSP.readdir(local))).toEqual([]);
            expect(yield* Effect.promise(() => NodeFSP.readFile(target))).toEqual(bytes);
            expect(
              (yield* exchange.transfer({ ...input, direction: "receive" })).sourceDisposition,
            ).toEqual({ status: "removed" });
          }).pipe(Effect.provide(layer));
          expect(yield* Effect.promise(() => NodeFSP.readdir(remote))).toEqual([]);
          expect(yield* Effect.promise(() => NodeFSP.readFile(source))).toEqual(bytes);
        }),
      ),
    );

    it.live("retains a same-content replacement before removing a local source", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { local, remote, workspaceRoot, layer } = yield* fixture();
          const filename = "move.bin";
          const before = NodePath.join(local, filename);
          const replacement = NodePath.join(local, "replacement.bin");
          const target = NodePath.join(remote, filename);
          const bytes = Buffer.from("same bytes in two different files");
          yield* Effect.promise(() =>
            Promise.all([NodeFSP.writeFile(before, bytes), NodeFSP.writeFile(replacement, bytes)]),
          );
          const link = SftpSession.prototype.link;
          const hook = vi.spyOn(SftpSession.prototype, "link").mockImplementation(async function (
            this: SftpSession,
            existing,
            destination,
          ) {
            await link.call(this, existing, destination);
            if (destination === target) await NodeFSP.rename(replacement, before);
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()));
          const result = yield* Effect.gen(function* () {
            const exchange = yield* FileExchange.FileExchange;
            return yield* exchange.transfer({
              deviceId: "fixture-device",
              workspaceRoot,
              localName: filename,
              direction: "send",
              mode: "move",
            });
          }).pipe(Effect.provide(layer));
          expect(result.sourceDisposition?.status).toBe("retained");
          expect(yield* Effect.promise(() => NodeFSP.readFile(before))).toEqual(bytes);
          expect(yield* Effect.promise(() => NodeFSP.readFile(target))).toEqual(bytes);
        }),
      ),
    );

    it.live.each([false, true])(
      "preserves a same-content remote replacement when its name is occupied: %s",
      (occupied) =>
        Effect.scoped(
          Effect.gen(function* () {
            const { local, remote, workspaceRoot, layer } = yield* fixture();
            const filename = "move.bin";
            const selected = NodePath.join(remote, filename);
            const replacement = NodePath.join(remote, "replacement.bin");
            const target = NodePath.join(local, filename);
            const bytes = Buffer.from("same content, different remote inode");
            yield* Effect.promise(() =>
              Promise.all([
                NodeFSP.writeFile(selected, bytes),
                NodeFSP.writeFile(replacement, bytes),
              ]),
            );
            const replacementInode = yield* Effect.promise(
              async () => (await NodeFSP.stat(replacement)).ino,
            );
            const rename = SftpSession.prototype.atomicRename;
            const hook = vi
              .spyOn(SftpSession.prototype, "atomicRename")
              .mockImplementation(async function (this: SftpSession, existing, destination) {
                if (existing === selected) await NodeFSP.rename(replacement, selected);
                await rename.call(this, existing, destination);
                if (occupied && existing === selected) {
                  await NodeFSP.writeFile(selected, "concurrent new source");
                }
              });
            yield* Effect.addFinalizer(() => Effect.sync(() => hook.mockRestore()));
            const result = yield* Effect.gen(function* () {
              const exchange = yield* FileExchange.FileExchange;
              return yield* exchange.transfer({
                deviceId: "fixture-device",
                workspaceRoot,
                localName: filename,
                direction: "receive",
                mode: "move",
              });
            }).pipe(Effect.provide(layer));
            expect(result.sourceDisposition?.status).toBe("retained");
            expect(yield* Effect.promise(() => NodeFSP.readFile(target))).toEqual(bytes);
            if (occupied) {
              expect(yield* Effect.promise(() => NodeFSP.readFile(selected, "utf8"))).toBe(
                "concurrent new source",
              );
              const disposition = result.sourceDisposition;
              if (disposition?.status !== "retained" || disposition.recoveryPath === undefined) {
                throw new Error("The replacement needs a recovery path.");
              }
              const recoveryPath = disposition.recoveryPath;
              const preservedInode = yield* Effect.promise(
                async () => (await NodeFSP.stat(recoveryPath)).ino,
              );
              expect(preservedInode).toBe(replacementInode);
            } else {
              expect(yield* Effect.promise(async () => (await NodeFSP.stat(selected)).ino)).toBe(
                replacementInode,
              );
              expect(yield* Effect.promise(() => NodeFSP.readdir(remote))).toEqual([filename]);
            }
          }),
        ),
    );

    it.live(
      "blocks workspace escapes, symbolic links, checksum mismatches and existing destinations",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { directory, local, remote, workspaceRoot, layer } = yield* fixture();
            const outside = NodePath.join(directory, "outside");
            const localDestination = NodePath.join(local, "occupied.txt");
            const remoteDestination = NodePath.join(remote, "occupied.txt");
            yield* Effect.promise(() =>
              Promise.all([
                NodeFSP.writeFile(outside, "private"),
                NodeFSP.writeFile(localDestination, "existing local data"),
                NodeFSP.writeFile(remoteDestination, "existing remote data"),
                NodeFSP.symlink(outside, NodePath.join(local, "link.txt")),
                NodeFSP.symlink(outside, NodePath.join(remote, "link.txt")),
              ]),
            );
            yield* Effect.gen(function* () {
              const service = yield* FileExchange.FileExchange;
              const base = { deviceId: "fixture-device", workspaceRoot, localName: "occupied.txt" };
              for (const input of [
                { ...base, direction: "send", workspaceRoot: directory },
                { ...base, direction: "send", remoteName: "../outside" },
                { ...base, direction: "send", localName: "link.txt", remoteName: "new.txt" },
                {
                  ...base,
                  direction: "send",
                  remoteName: "new.txt",
                  expectedSha256: "0".repeat(64),
                },
                { ...base, direction: "receive", localName: "new.txt", remoteName: "link.txt" },
                {
                  ...base,
                  direction: "receive",
                  localName: "new.txt",
                  remoteName: "occupied.txt",
                  expectedSha256: "0".repeat(64),
                },
                { ...base, direction: "send" },
                { ...base, direction: "receive" },
              ] as const) {
                const result = yield* Effect.result(service.transfer(input));
                expect(result._tag, JSON.stringify(input)).toBe("Failure");
              }
            }).pipe(Effect.provide(layer));
            const [outsideContent, localContent, remoteContent, localEntries, remoteEntries] =
              yield* Effect.promise(() =>
                Promise.all([
                  NodeFSP.readFile(outside, "utf8"),
                  NodeFSP.readFile(localDestination, "utf8"),
                  NodeFSP.readFile(remoteDestination, "utf8"),
                  NodeFSP.readdir(local),
                  NodeFSP.readdir(remote),
                ]),
              );
            expect(outsideContent).toBe("private");
            expect(localContent).toBe("existing local data");
            expect(remoteContent).toBe("existing remote data");
            expect(localEntries.sort()).toEqual(["link.txt", "occupied.txt"]);
            expect(remoteEntries.sort()).toEqual(["link.txt", "occupied.txt"]);
          }),
        ),
    );
  },
);
