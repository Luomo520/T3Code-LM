import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AuthClientSession,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { AssetSigner } from "../assets/AssetSigner.ts";
import { EnvironmentAuth, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  readFileHandoff,
  readThreadFileHandoffStatus,
  stageThreadFileHandoff,
} from "./FileHandoff.ts";

it.effect("preserves the original and reports a saved receipt for the requesting device", () => {
  const scopes = [AuthOrchestrationOperateScope, AuthOrchestrationReadScope];
  const session = (label: string): AuthenticatedSession => ({
    sessionId: AuthSessionId.make(label),
    subject: "owner",
    method: "bearer-access-token",
    scopes,
  });
  const client = (session: AuthenticatedSession): AuthClientSession => ({
    ...session,
    issuedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(253402300799000),
    connected: true,
    current: false,
    lastConnectedAt: null,
    client: { label: session.sessionId, deviceType: "desktop" },
  });
  const target = session("recipient");
  const other = session("other");
  const threadId = ThreadId.make("original-resource");
  const id = "00000000-0000-0000-0000-000000000041";
  const savedPath = "Download/t3code/original.bin";

  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig;
    const sourcePath = path.join(config.stateDir, "original.bin");
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(sourcePath, "abc");
    const request = {
      threadId,
      id,
      requester: target.sessionId,
      recipient: target.sessionId,
      name: "original.bin",
      sourcePath,
    };
    const staged = yield* stageThreadFileHandoff(request);
    expect(staged.status).toBe("awaiting_save");
    expect(yield* stageThreadFileHandoff(request)).toEqual(staged);

    const received = yield* readFileHandoff({ _tag: "list", threadId }, target);
    expect(received).toMatchObject({
      _tag: "list",
      transfers: [{ outgoing: false, sizeBytes: 3 }],
    });
    const receipt = {
      _tag: "confirmSaved" as const,
      id,
      threadId,
      sizeBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      savedPath,
    };
    expect(yield* Effect.result(readFileHandoff(receipt, other))).toMatchObject({
      _tag: "Failure",
    });
    expect(yield* readFileHandoff(receipt, target)).toEqual({
      _tag: "finished",
      disposition: "saved",
    });
    expect(yield* readThreadFileHandoffStatus(threadId, id)).toEqual({
      id,
      name: "original.bin",
      recipientLabel: "recipient",
      status: "saved",
      savedPath,
    });
    expect(yield* stageThreadFileHandoff(request)).toMatchObject({ status: "saved", savedPath });
    expect(yield* fs.readFileString(sourcePath)).toBe("abc");

    const apkId = "00000000-0000-0000-0000-000000000042";
    const apk = {
      ...request,
      id: apkId,
      name: "t3.apk",
      requester: other.sessionId,
      expectedSourceSha256: receipt.sha256,
    };
    expect(
      yield* Effect.result(
        stageThreadFileHandoff({ ...apk, expectedSourceSha256: "0".repeat(64) }),
      ),
    ).toMatchObject({
      _tag: "Failure",
    });
    yield* stageThreadFileHandoff(apk);
    expect(yield* readFileHandoff({ _tag: "list", threadId }, other)).toMatchObject({
      _tag: "list",
      transfers: [{ id: apkId, outgoing: true }],
    });

    const installReceipt = {
      _tag: "reportInstall" as const,
      id: apkId,
      threadId,
      sha256: receipt.sha256,
      installation: {
        status: "verified" as const,
        packageName: "app.t3code",
        version: "0.2.4",
        versionCode: "9223372036854775807",
      },
    };
    expect(yield* Effect.result(readFileHandoff(installReceipt, target))).toMatchObject({
      _tag: "Failure",
    });
    yield* readFileHandoff({ ...receipt, id: apkId, savedPath: "Download/t3code/t3.apk" }, target);
    expect(yield* Effect.result(readFileHandoff({ ...installReceipt, id }, target))).toMatchObject({
      _tag: "Failure",
    });
    expect(yield* Effect.result(readFileHandoff(installReceipt, other))).toMatchObject({
      _tag: "Failure",
    });
    expect(
      yield* Effect.result(readFileHandoff({ ...installReceipt, sha256: "0".repeat(64) }, target)),
    ).toMatchObject({
      _tag: "Failure",
    });
    const cancelled = { ...installReceipt, installation: { status: "cancelled" as const } };
    yield* readFileHandoff(cancelled, target);
    expect(yield* readThreadFileHandoffStatus(threadId, apkId)).toMatchObject({
      installation: { status: "cancelled" },
    });
    expect(yield* readFileHandoff(installReceipt, target)).toEqual({
      _tag: "finished",
      disposition: "saved",
    });
    yield* readFileHandoff(cancelled, target);
    expect(yield* readThreadFileHandoffStatus(threadId, apkId)).toMatchObject({
      status: "saved",
      installation: installReceipt.installation,
    });
    expect(yield* readFileHandoff({ _tag: "list", threadId }, target)).toMatchObject({
      _tag: "list",
      transfers: expect.arrayContaining([
        expect.objectContaining({
          id: apkId,
          outgoing: false,
          installation: installReceipt.installation,
        }),
      ]),
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(AssetSigner)({}),
        Layer.mock(EnvironmentAuth)({
          listSessions: () => Effect.succeed([client(target), client(other)]),
        }),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-save-test-" }),
        ServerSettingsService.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
});
