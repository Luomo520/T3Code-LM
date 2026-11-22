// @effect-diagnostics nodeBuiltinImport:off - 测试使用真实 SFTP 子系统和隔离的本地目录。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileExchange from "./FileExchange.ts";

const sftpServer = ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server"].find(
  (entry) => NodeFS.existsSync(entry),
);

const fixture = Effect.fn("FileExchange.test.fixture")(function* () {
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
    ),
  };
});

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux" || sftpServer === undefined)(
  "OpenSSH SFTP file exchange",
  () => {
    it.live(
      "transfers binary data both ways, verifies digests, and leaves the original intact",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const { local, remote, workspaceRoot, layer } = yield* fixture();
            const bytes = Buffer.alloc(160 * 1024, 0xdb);
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
            expect(original).toEqual(bytes);
            expect(copy).toEqual(bytes);
            expect(uploaded).toEqual(bytes);
            expect(remoteEntries).toEqual(["remote copy.bin"]);
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
