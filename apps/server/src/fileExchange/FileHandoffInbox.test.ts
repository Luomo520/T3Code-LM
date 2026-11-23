import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  ThreadId,
  type AuthClientSession,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { EnvironmentAuth, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readFileHandoff, stageThreadFileHandoff, startFileHandoff } from "./FileHandoff.ts";
import { indexFileHandoff, indexedFileHandoffs } from "./FileHandoffInbox.ts";

const sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

const session = (name: string): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(name),
  subject: "owner",
  method: "bearer-access-token",
  scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
});

const client = (value: AuthenticatedSession): AuthClientSession => ({
  ...value,
  issuedAt: DateTime.makeUnsafe(0),
  expiresAt: DateTime.makeUnsafe(253402300799000),
  connected: true,
  current: false,
  lastConnectedAt: null,
  client: { label: value.sessionId, deviceType: "mobile" },
});

it.effect("lists only indexed explicit deliveries for the authenticated recipient", () => {
  const sender = session("sender");
  const receiver = session("phone");
  const other = session("other");
  const firstThread = ThreadId.make("first-thread");
  const otherThread = ThreadId.make("second-thread");
  const id = "00000000-0000-0000-0000-000000000201";
  const manualId = "00000000-0000-0000-0000-000000000202";
  const uploadId = "00000000-0000-0000-0000-000000000203";
  const cancelledId = "00000000-0000-0000-0000-000000000204";
  let scannedClients = 0;
  const inbox = (actor: AuthenticatedSession) => readFileHandoff({ _tag: "inbox" }, actor);
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const sourcePath = path.join(config.stateDir, "original.bin");
    const root = path.join(config.stateDir, "file-handoff");
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(sourcePath, "abc");
    const delivery = {
      threadId: firstThread,
      id,
      requester: sender.sessionId,
      recipient: receiver.sessionId,
      name: "original.bin",
      sourcePath,
      autoReceive: true as const,
    };
    yield* stageThreadFileHandoff(delivery);
    yield* stageThreadFileHandoff({ ...delivery, threadId: otherThread });
    yield* stageThreadFileHandoff({ ...delivery, id: cancelledId });
    yield* stageThreadFileHandoff({ ...delivery, recipient: other.sessionId, id: manualId });
    yield* stageThreadFileHandoff({
      threadId: otherThread,
      id: manualId,
      requester: sender.sessionId,
      recipient: receiver.sessionId,
      name: "manual.bin",
      sourcePath,
    });
    yield* startFileHandoff(
      {
        threadId: otherThread,
        id: uploadId,
        recipient: receiver.sessionId,
        name: "upload.bin",
        sizeBytes: 3,
        sha256,
      },
      sender,
    );
    const calls = scannedClients;
    expect(yield* inbox(receiver)).toMatchObject({
      _tag: "inbox",
      transfers: [
        { threadId: firstThread, id, name: "original.bin", sha256, autoReceive: true },
        { threadId: firstThread, id: cancelledId },
        { threadId: otherThread, id },
      ],
    });
    expect(scannedClients).toBe(calls);
    expect(yield* inbox(sender)).toEqual({ _tag: "inbox", transfers: [] });
    expect(yield* inbox(other)).toMatchObject({ transfers: [{ id: manualId }] });
    expect(yield* Effect.result(inbox({ ...receiver, scopes: [] }))).toMatchObject({
      _tag: "Failure",
    });

    // 一个仅有检查点的条目必须等待原记录完成。另一个设备的条目也要核对实际接收端。
    const expiresAt = 7 * 24 * 60 * 60 * 1000;
    yield* Effect.promise(() =>
      indexFileHandoff(root, receiver.sessionId, "0".repeat(64), {
        threadId: firstThread,
        id: manualId,
        expiresAt,
      }),
    );
    expect(yield* inbox(receiver)).toMatchObject({
      transfers: [{ id }, { id: cancelledId }, { id }],
    });

    yield* readFileHandoff(
      {
        _tag: "confirmSaved",
        threadId: firstThread,
        id,
        sizeBytes: 3,
        sha256,
        savedPath: "Download/t3code/original.bin",
      },
      receiver,
    );
    yield* readFileHandoff({ _tag: "cancel", threadId: firstThread, id: cancelledId }, sender);
    expect(yield* inbox(receiver)).toMatchObject({ transfers: [{ threadId: otherThread, id }] });
    const indexed = yield* Effect.promise(() => indexedFileHandoffs(root, receiver.sessionId, 0));
    expect(indexed).toHaveLength(2);

    yield* TestClock.adjust("8 days");
    expect(yield* inbox(receiver)).toEqual({ _tag: "inbox", transfers: [] });
    expect(yield* Effect.promise(() => indexedFileHandoffs(root, receiver.sessionId, 0))).toEqual(
      [],
    );
    expect(yield* fs.readFileString(sourcePath)).toBe("abc");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth)({
          listSessions: () =>
            Effect.sync(() => {
              scannedClients++;
              return [client(sender), client(receiver), client(other)];
            }),
        }),
        Layer.mock(AssetSigner)({ sign: () => Effect.succeed("fixture-signature") }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-file-inbox-test-" }),
        ServerSettingsService.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
});
