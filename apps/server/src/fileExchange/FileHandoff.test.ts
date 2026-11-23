// @effect-diagnostics nodeBuiltinImport:off -- 测试独立计算发送源文件的摘要。
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  FILE_HANDOFF_CHUNK_BYTES,
  ThreadId,
  type AuthClientSession,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { expect, it } from "vite-plus/test";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { layerFileHandoffRoutes } from "../http.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { readFileHandoff, startFileHandoff } from "./FileHandoff.ts";

it("limits receipt to the designated device and resumes a file with the original digest", async () => {
  const threadId = ThreadId.make("handoff-test");
  const source = AuthSessionId.make("sender");
  const target = AuthSessionId.make("receiver");
  const other = AuthSessionId.make("other");
  const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
  const makeSession = (sessionId: AuthSessionId): EnvironmentAuth.AuthenticatedSession => ({
    sessionId,
    subject: "owner",
    method: "bearer-access-token",
    scopes,
  });
  const paired = [source, target, other].map((id): AuthClientSession => ({
    ...makeSession(id),
    issuedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(253402300799000),
    connected: id !== target,
    current: false,
    lastConnectedAt: null,
    client: { label: id, deviceType: "desktop" },
  }));
  let active = paired;
  const id = NodeCrypto.randomUUID();
  const cancelledId = NodeCrypto.randomUUID();
  const bytes = new Uint8Array(FILE_HANDOFF_CHUNK_BYTES + 3).fill(42);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  const finish = (path: `/${string}`, transferId: string, actor: AuthSessionId, digest?: string) =>
    HttpRouter.add(
      "POST",
      path,
      readFileHandoff(
        digest === undefined
          ? { _tag: "cancel", threadId, id: transferId }
          : {
              _tag: "confirmSaved",
              threadId,
              id: transferId,
              sizeBytes: bytes.length,
              sha256: digest,
            },
        makeSession(actor),
      ).pipe(
        Effect.flatMap((result) => HttpServerResponse.json(result)),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 409 })),
      ),
    );
  const controls = Layer.mergeAll(
    finish("/test/confirm", id, target, sha256),
    finish("/test/invalid-hash", id, target, "0".repeat(64)),
    finish("/test/invalid-device", id, other, sha256),
    finish("/test/cancel", cancelledId, source),
    finish("/test/invalid-cancel", cancelledId, target),
    HttpRouter.add(
      "GET",
      "/test/list",
      readFileHandoff({ _tag: "list", threadId }, makeSession(source)).pipe(
        Effect.flatMap((result) => HttpServerResponse.json(result)),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/test/copy-state",
      Effect.gen(function* () {
        const { stateDir } = yield* ServerConfig.ServerConfig;
        const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
        const pendingPath = (transferId: string) =>
          NodePath.join(stateDir, "file-handoff", key, transferId + ".bytes");
        return yield* HttpServerResponse.json({
          saved: NodeFS.existsSync(pendingPath(id)),
          cancelled: NodeFS.existsSync(pendingPath(cancelledId)),
        });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/test/start-cancel",
      startFileHandoff(
        {
          threadId,
          id: cancelledId,
          recipient: target,
          name: "pending.bin",
          sizeBytes: bytes.length,
          sha256,
        },
        makeSession(source),
      ).pipe(Effect.flatMap((upload) => HttpServerResponse.json(upload))),
    ),

    HttpRouter.add(
      "GET",
      "/test/start",
      Effect.gen(function* () {
        const upload = yield* startFileHandoff(
          {
            threadId,
            id,
            recipient: target,
            name: "中文.bin",
            sizeBytes: bytes.length,
            sha256,
          },
          makeSession(source),
        );
        return yield* HttpServerResponse.json(upload);
      }),
    ),
    HttpRouter.add(
      "GET",
      "/test/changed-same-name",
      startFileHandoff(
        {
          threadId,
          id,
          recipient: target,
          name: "中文.bin",
          sizeBytes: bytes.length,
          sha256: "0".repeat(64),
        },
        makeSession(source),
      ).pipe(
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 409 })),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/test/receive",
      readFileHandoff({ _tag: "receive", threadId, id }, makeSession(target)).pipe(
        Effect.flatMap((link) => HttpServerResponse.json(link)),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
      ),
    ),
    HttpRouter.add(
      "GET",
      "/test/other",
      readFileHandoff({ _tag: "receive", threadId, id }, makeSession(other)).pipe(
        Effect.as(HttpServerResponse.empty({ status: 200 })),
        Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 })),
      ),
    ),
  );
  const layerApp = Layer.merge(controls, layerFileHandoffRoutes).pipe(
    Layer.provideMerge(AssetSigner.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          listSessions: () => Effect.sync(() => active),
        }),
        ServerSecretStore.layer,
        ServerSettingsService.layerTest({ attachmentMaxFileSizeMiB: 2 }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-file-handoff-test-" })),
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, NodeCryptoLayer.layer, NodeHttpPlatform.layer),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
  const request = (path: string, options?: RequestInit) =>
    handler(new Request("http://127.0.0.1" + path, options), undefined);
  const getUpload = async () => {
    const response = await request("/test/start");
    expect(response.status).toBe(200);
    return (await response.json()) as { relativeUrl: string; offset: number; ready: boolean };
  };
  const post = (url: string, offset: number, body: Uint8Array<ArrayBuffer>) =>
    request(url + "?offset=" + offset, { method: "POST", body });

  try {
    const upload = await getUpload();
    const cancelled = (await (await request("/test/start-cancel")).json()) as {
      relativeUrl: string;
    };
    expect(
      (await post(cancelled.relativeUrl, 0, bytes.subarray(0, FILE_HANDOFF_CHUNK_BYTES))).status,
    ).toBe(204);
    expect((await request("/test/invalid-cancel", { method: "POST" })).status).toBe(409);
    expect(await (await request("/test/copy-state")).json()).toEqual({
      saved: false,
      cancelled: true,
    });
    expect(await (await request("/test/cancel", { method: "POST" })).json()).toEqual({
      _tag: "finished",
      disposition: "cancelled",
    });
    expect(
      (
        await post(
          cancelled.relativeUrl,
          FILE_HANDOFF_CHUNK_BYTES,
          bytes.subarray(FILE_HANDOFF_CHUNK_BYTES),
        )
      ).status,
    ).toBe(404);
    expect(await (await request("/test/copy-state")).json()).toEqual({
      saved: false,
      cancelled: false,
    });
    expect(upload.offset).toBe(0);
    expect((await request("/test/receive")).status).toBe(404);
    expect((await post(upload.relativeUrl, 0, bytes.subarray(0, 17))).status).toBe(400);
    expect((await getUpload()).offset).toBe(0);
    const chunk = bytes.subarray(0, FILE_HANDOFF_CHUNK_BYTES);
    expect((await post(upload.relativeUrl, 0, chunk)).status).toBe(204);
    expect((await post(upload.relativeUrl, 0, chunk)).status).toBe(409);
    expect((await request("/test/changed-same-name")).status).toBe(409);
    const resumed = await getUpload();
    expect(resumed.offset).toBe(FILE_HANDOFF_CHUNK_BYTES);
    expect(
      (await post(resumed.relativeUrl, resumed.offset, bytes.subarray(resumed.offset))).status,
    ).toBe(204);
    expect((await getUpload()).ready).toBe(true);

    expect((await request("/test/other")).status).toBe(404);
    const response = await request("/test/receive");
    expect(response.status).toBe(200);
    const link = (await response.json()) as { relativeUrl: string; sha256: string };
    expect(link.sha256).toBe(sha256);
    const head = await request(link.relativeUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe('"sha256-' + sha256 + '"');
    const first = await request(link.relativeUrl, { headers: { Range: "bytes=0-17" } });
    expect(first.status).toBe(206);
    expect(await first.bytes()).toEqual(bytes.subarray(0, 18));
    const rest = await request(link.relativeUrl, {
      headers: { Range: "bytes=18-", "If-Range": head.headers.get("etag") ?? "" },
    });
    expect(rest.status).toBe(206);
    expect(await rest.bytes()).toEqual(bytes.subarray(18));
    active = paired.filter((item) => item.sessionId !== target);
    expect((await request(link.relativeUrl, { method: "HEAD" })).status).toBe(404);
    active = paired;
    expect((await request("/test/invalid-device", { method: "POST" })).status).toBe(409);
    expect((await request("/test/invalid-hash", { method: "POST" })).status).toBe(409);
    expect(await (await request("/test/copy-state")).json()).toEqual({
      saved: true,
      cancelled: false,
    });
    for (const _ of [1, 2]) {
      expect(await (await request("/test/confirm", { method: "POST" })).json()).toEqual({
        _tag: "finished",
        disposition: "saved",
      });
    }
    expect((await request(link.relativeUrl, { method: "HEAD" })).status).toBe(404);
    expect(await (await request("/test/copy-state")).json()).toEqual({
      saved: false,
      cancelled: false,
    });
    expect(await (await request("/test/list")).json()).toMatchObject({
      transfers: expect.arrayContaining(
        [
          { id, disposition: "saved", expiresAt: expect.any(Number) },
          { id: cancelledId, disposition: "cancelled", expiresAt: expect.any(Number) },
        ].map((entry) => expect.objectContaining(entry)),
      ),
    });
  } finally {
    await dispose();
  }
});
