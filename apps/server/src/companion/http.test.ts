import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as CompanionHttp from "./http.ts";
import { createAndroidCaptureStore, getAndroidCaptureStore } from "./androidCaptureStore.ts";
import { getCompanionStore } from "./store.ts";
import { archivedCapturePath, captureArchiveDirectory } from "./captureArchive.ts";

class CompanionTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.companions,
) {}

const layerTestAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make(
        request.headers["x-test-session"] ?? "companion-http-test-session",
      ),
      subject: "companion-http-test",
      method: request.headers["x-test-cookie"] ? "browser-session-cookie" : "bearer-access-token",
      scopes: new Set([
        request.headers["x-test-admin"] === "1" ? AuthAccessWriteScope : AuthSettingsWriteScope,
        ...(request.headers["x-test-operate"] ? [AuthOrchestrationOperateScope] : []),
        ...(request.headers["x-test-read-thread"] === "1" ? [AuthOrchestrationReadScope] : []),
      ]),
    });
  }),
);

const setup = Effect.fnUntraced(function* () {
  const layerSettings = ServerSettingsService.layerTest();
  const settings = Context.get(yield* Layer.build(layerSettings), ServerSettingsService);
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-companion-http-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const config = Context.get(yield* Layer.build(layerConfig), ServerConfig.ServerConfig);
  const routes = HttpApiBuilder.layer(CompanionTestApi).pipe(
    Layer.provide(CompanionHttp.layer),
    Layer.provide(layerTestAuth),
    Layer.provide(Layer.succeed(ServerSettingsService, settings)),
    Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    (web) => Effect.promise(() => web.dispose()),
  );
  const request = (
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; method?: "GET" | "POST" },
  ) =>
    Effect.promise(() =>
      server.handler(
        new Request("http://localhost/api/companions" + path, {
          method: options?.method ?? "POST",
          headers: {
            ...(options?.body === undefined ? {} : { "content-type": "application/json" }),
            ...options?.headers,
          },
          ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      ),
    );
  const store = yield* Effect.acquireRelease(
    Effect.sync(() => getCompanionStore(config.stateDir)),
    (store) => Effect.sync(() => store.close()),
  );
  return { settings, request, server, store, config };
});

const admin = { "x-test-admin": "1" };
const deviceInfo = {
  name: "Windows test",
  info: { os: "win32", network1: "LAN · MAC 02-11-22-33-44-55 · IP 192.0.2.1" },
};

it.effect("authorizes management separately and keeps revoke available after disabling", () =>
  Effect.gen(function* () {
    const { settings, request, store } = yield* setup();
    expect((yield* request("/pair", { headers: admin })).status).toBe(404);
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    expect((yield* request("/pair")).status).toBe(403);

    const pair = yield* request("/pair", { headers: admin });
    expect(pair.status).toBe(200);
    expect(pair.headers.get("cache-control")).toBe("no-store");
    const { code } = (yield* Effect.promise(() => pair.json())) as { code: string };
    const enrolled = yield* request("/enroll", { body: { code, ...deviceInfo } });
    expect(enrolled.status).toBe(200);
    const { deviceId, token } = (yield* Effect.promise(() => enrolled.json())) as {
      deviceId: string;
      token: string;
    };
    const auth = { authorization: `Bearer ${token}` };
    const poll = yield* request("/poll", { headers: auth, body: deviceInfo });
    expect(poll.status).toBe(200);
    expect(yield* Effect.promise(() => poll.json())).toEqual({ name: deviceInfo.name, job: null });
    expect(
      (yield* request(`/${deviceId}/rename`, { headers: admin, body: { name: "Updated" } })).status,
    ).toBe(200);
    const renamedPoll = yield* request("/poll", { headers: auth, body: deviceInfo });
    expect(yield* Effect.promise(() => renamedPoll.json())).toEqual({ name: "Updated", job: null });
    const task = store.enqueue("test-thread", deviceId, "open-notepad", "request-1");
    expect((yield* request("/check", { headers: admin, body: { info: {} } })).status).toBe(401);
    expect(
      (yield* request("/check", {
        headers: { ...auth, origin: "https://example.test" },
        body: { info: {} },
      })).status,
    ).toBe(403);
    const check = yield* request("/check", { headers: auth, body: { info: { memory: "32 GiB" } } });
    expect(check.status).toBe(200);
    expect(check.headers.get("cache-control")).toBe("no-store");
    expect(yield* Effect.promise(() => check.json())).toMatchObject({
      name: "Updated",
      detailsUpdatedAt: expect.any(String),
    });
    const renameFromDevice = yield* request("/check", {
      headers: auth,
      body: { name: "Windows local name", info: { memory: "32 GiB" } },
    });
    expect(renameFromDevice.status).toBe(200);
    expect(store.result("test-thread", task.id)).toMatchObject({ status: "queued" });
    const switchedNetwork = {
      ...deviceInfo.info,
      network1: "LAN · MAC 02-11-22-33-44-55 · IP 192.0.2.4",
    };
    const taskPoll = yield* request("/poll", {
      headers: auth,
      body: { ...deviceInfo, info: switchedNetwork },
    });
    expect(yield* Effect.promise(() => taskPoll.json())).toEqual({
      name: "Windows local name",
      job: { id: task.id, action: "open-notepad", threadId: "test-thread", params: {} },
    });
    const result = yield* request("/result", {
      headers: auth,
      body: { id: task.id, status: "done", message: "OK" },
    });
    expect(yield* Effect.promise(() => result.json())).toEqual({ ok: true });

    yield* settings.updateSettings({ windowsCompanionEnabled: false });
    const list = yield* request("", { method: "GET", headers: admin });
    const listBody = (yield* Effect.promise(() => list.json())) as {
      devices: { recentTasks: unknown[] }[];
    };
    expect(listBody).toMatchObject({
      devices: [
        {
          deviceId,
          name: "Windows local name",
          info: switchedNetwork,
          recentTasks: [{ id: task.id, status: "done" }],
        },
      ],
    });
    expect(listBody.devices[0]?.recentTasks[0]).not.toHaveProperty("threadId");
    const listWithThread = yield* request("", {
      method: "GET",
      headers: { ...admin, "x-test-read-thread": "1" },
    });
    expect(yield* Effect.promise(() => listWithThread.json())).toMatchObject({
      devices: [{ deviceId, recentTasks: [{ id: task.id, threadId: "test-thread" }] }],
    });
    expect((yield* request("/poll", { headers: auth, body: deviceInfo })).status).toBe(404);
    expect((yield* request("/check", { headers: auth, body: { info: {} } })).status).toBe(404);
    expect((yield* request("/revoke", { headers: auth, body: {} })).status).toBe(200);

    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    expect((yield* request("/poll", { headers: auth, body: deviceInfo })).status).toBe(401);
  }),
);

it.effect(
  "accepts a Windows close progress update and exit receipt through the result endpoint",
  () =>
    Effect.gen(function* () {
      const { settings, request, store } = yield* setup();
      yield* settings.updateSettings({ windowsCompanionEnabled: true });
      const enrolled = yield* request("/enroll", {
        body: { code: store.pair().code, ...deviceInfo },
      });
      const { token, deviceId } = (yield* Effect.promise(() => enrolled.json())) as {
        token: string;
        deviceId: string;
      };
      const headers = { authorization: `Bearer ${token}` };
      const close = store.enqueue("thread", deviceId, "close-window", "close");
      yield* request("/poll", { headers, body: deviceInfo });
      const report = (status: string, closeState: string) =>
        request("/result", {
          headers,
          body: { id: close.id, status, closeState, message: "回执" },
        });
      expect((yield* report("done", "waiting-for-exit")).status).toBe(400);
      expect((yield* report("running", "waiting-for-exit")).status).toBe(200);
      expect(store.result("thread", close.id).status).toBe("running");
      expect((yield* report("done", "exited")).status).toBe(200);
      expect(store.result("thread", close.id).status).toBe("done");
    }),
);

it.effect("rejects web origins and untrusted or oversized request bodies", () =>
  Effect.gen(function* () {
    const { settings, request, server } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const pair = yield* request("/pair", { headers: admin });
    const { code } = (yield* Effect.promise(() => pair.json())) as { code: string };
    const body = { code, ...deviceInfo };
    expect(
      (yield* request("/enroll", { headers: { origin: "https://example.test" }, body })).status,
    ).toBe(403);
    expect((yield* request("/result", { body: "invalid" })).status).toBe(401);
    expect(
      (yield* request("/enroll", { headers: { "content-type": "text/plain" }, body })).status,
    ).toBe(415);
    const oversized = yield* Effect.promise(() =>
      server.handler(
        new Request("http://localhost/api/companions/enroll", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
              controller.close();
            },
          }),
          duplex: "half",
        }),
      ),
    );
    expect(oversized.status).toBe(413);
    expect((yield* request("/enroll", { body })).status).toBe(200);
  }),
);

it.effect("limits repeated anonymous pairing attempts", () =>
  Effect.gen(function* () {
    const { settings, request } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const body = { code: "0000000000", ...deviceInfo };
    const attempts = yield* Effect.forEach(Array.from({ length: 30 }), () =>
      request("/enroll", { body }),
    );
    expect(attempts.map((attempt) => attempt.status)).toEqual(
      Array.from({ length: 30 }, () => 401),
    );
    expect((yield* request("/enroll", { body })).status).toBe(429);
  }),
);

it.effect("serves the selected and unchanged file only to the companion with the claimed job", () =>
  Effect.gen(function* () {
    const { config, settings, request, store } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const id = "example-thread-e30a45f0-3082-49b5-84bd-46005ec67796-txt";
    const fileName = "hello.txt";
    const filePath = path.join(config.attachmentsDir, id + ".txt");
    yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
    yield* fs.writeFileString(filePath, "hello");
    const target = store.enroll(store.pair().code, "Windows target", deviceInfo.info);
    const other = store.enroll(store.pair().code, "Other Windows device", deviceInfo.info);
    const sha256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const task = store.enqueue("test-thread", target.deviceId, "receive-file", "transfer", {
      attachmentId: id,
      fileName,
      sha256,
    });
    const headers = { authorization: `Bearer ${target.token}` };
    const body = { id: task.id };
    expect((yield* request("/read-transfer", { headers, body })).status).toBe(404);
    expect(store.poll(target.token, "Windows target", {}).job?.id).toBe(task.id);
    expect(
      (yield* request("/read-transfer", {
        headers: { authorization: `Bearer ${other.token}` },
        body,
      })).status,
    ).toBe(404);
    const download = yield* request("/read-transfer", { headers, body });
    expect(download.headers.get("cache-control")).toBe("no-store");
    expect(yield* Effect.promise(() => download.json())).toEqual({
      name: fileName,
      data: "aGVsbG8=",
      sha256,
    });
    yield* fs.writeFileString(filePath, "Hello");
    expect((yield* request("/read-transfer", { headers, body })).status).toBe(409);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("binds Android approval and uploads to the authenticated phone before archiving", () =>
  Effect.gen(function* () {
    const { config, request } = yield* setup();
    const phone = { "x-test-operate": "1", "x-test-session": "phone-one" };
    const other = { ...phone, "x-test-session": "phone-two" };
    const send = (headers: Record<string, string>, body: object) =>
      request("/android-capture", { headers, body });
    const listen = { _tag: "listen", name: "Test phone" };
    expect((yield* send({}, listen)).status).toBe(403);
    expect((yield* send({ ...phone, "x-test-cookie": "1" }, listen)).status).toBe(403);
    expect((yield* send({ ...phone, origin: "http://localhost" }, listen)).status).toBe(403);
    expect((yield* send(phone, listen)).status).toBe(200);
    expect((yield* send(other, listen)).status).toBe(200);
    const store = getAndroidCaptureStore(config.stateDir);
    const job = store.enqueue("original", "android:phone-one", "screenshot", "capture-1", 10);
    const returned = yield* send(phone, listen);
    expect(yield* Effect.promise(() => returned.json())).toMatchObject({
      _tag: "pending",
      job: { id: job.id, action: "screenshot", threadId: "original" },
    });
    const otherList = yield* send(other, listen);
    expect(yield* Effect.promise(() => otherList.json())).toEqual({ _tag: "pending", job: null });
    const complete = {
      _tag: "complete",
      id: job.id,
      media:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC",
    };
    expect((yield* send(phone, complete)).status).toBe(409);
    expect((yield* send(other, { _tag: "approve", id: job.id })).status).toBe(404);
    expect((yield* send(phone, { _tag: "approve", id: job.id })).status).toBe(200);
    expect((yield* send(other, complete)).status).toBe(404);
    // 模拟媒体已落盘、SQLite 尚未记下完成状态时服务退出。
    const archive = captureArchiveDirectory(config.stateDir, ThreadId.make("original"));
    const archivePath = archivedCapturePath(archive, job.id, "png")!;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(archive, { recursive: true });
    yield* fs.writeFileString(archivePath, "unrelated");
    expect((yield* send(phone, complete)).status).toBe(409);
    expect(yield* fs.readFileString(archivePath)).toBe("unrelated");
    yield* fs.writeFile(archivePath, Buffer.from(complete.media, "base64"));
    expect((yield* send(phone, complete)).status).toBe(200);
    expect((yield* send(phone, complete)).status).toBe(200);
    expect(store.result("original", job.id)).toMatchObject({ status: "done" });
    expect(() => store.result("other", job.id)).toThrow();
    for (const reason of ["denied", "locked", "revoked"] as const) {
      const pending = store.enqueue("original", "android:phone-one", "record-screen", reason, 10);
      expect((yield* send(phone, { _tag: "reject", id: pending.id, reason })).status).toBe(200);
      expect(store.result("original", pending.id)).toMatchObject({ status: "failed" });
      const result = yield* send(phone, { _tag: "approve", id: pending.id });
      expect(yield* Effect.promise(() => result.json())).toEqual({ _tag: "inactive" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains a paired Android phone and its queued request while the app is in the background",
  () =>
    Effect.gen(function* () {
      const { config } = yield* setup();
      let time = 1_000_000;
      const store = yield* Effect.acquireRelease(
        Effect.sync(() => createAndroidCaptureStore(config.stateDir, () => time)),
        (captures) => Effect.sync(() => captures.close()),
      );
      const device = "android:background-phone";
      expect(store.listen(device, "Android", "background").job).toBeNull();
      expect(store.list()).toEqual([]);
      store.listen(device, "Android", "background-ready");
      time += 60_000;
      expect(store.list()).toEqual([
        {
          deviceId: device,
          name: "Android",
          online: false,
          backgroundReady: true,
          platform: "android",
        },
      ]);
      const pending = store.enqueue("original", device, "record-screen", "handoff", 10);
      time += 120_000;
      expect(store.result("original", pending.id).message).toContain("等待手机接收");
      expect(() => store.progress("android:other", pending.id, "received")).toThrow();
      store.progress(device, pending.id, "received");
      expect(store.result("original", pending.id).message).toContain("已收到");
      expect(store.listen(device, "Android", "background").job?.id).toBe(pending.id);
      expect(store.listen(device, "Android", "background").job?.id).toBe(pending.id);
      expect(store.result("original", pending.id).status).toBe("queued");
      expect(store.enqueue("original", device, "record-screen", "handoff", 10).id).toBe(pending.id);
      expect(store.listen(device, "Android", "background-ready").job?.id).toBe(pending.id);
      expect(store.approve(device, pending.id)._tag).toBe("active");
      expect(store.listen(device, "Android", "background").job).toBeNull();
      store.progress(device, pending.id, "recording");
      store.progress(device, pending.id, "received");
      expect(store.result("original", pending.id).message).toContain("已开始录屏");
      store.listen(device, "Android", "unavailable");
      expect(store.list()).toEqual([]);
      expect(store.result("original", pending.id)).toMatchObject({ status: "failed" });
      expect(store.approve(device, pending.id)._tag).toBe("inactive");
    }),
);

it.effect("expires Android requests before approval and during a capture", () =>
  Effect.gen(function* () {
    const { config } = yield* setup();
    let time = 1_000_000;
    const store = yield* Effect.acquireRelease(
      Effect.sync(() => createAndroidCaptureStore(config.stateDir, () => time)),
      (captures) => Effect.sync(() => captures.close()),
    );
    const device = "android:expiry-test";
    store.listen(device, "Android");
    const first = store.enqueue("original", device, "screenshot", "not-approved", 10);
    time += 45_001;
    expect(store.approve(device, first.id)).toEqual({ _tag: "inactive" });
    expect(store.result("original", first.id)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("过期"),
    });
    store.listen(device, "Android");
    const second = store.enqueue("original", device, "record-screen", "approved", 10);
    expect(store.approve(device, second.id)._tag).toBe("active");
    time += 90_001;
    expect(store.status(device, second.id)).toEqual({ _tag: "inactive" });
    expect(store.result("original", second.id)).toMatchObject({
      status: "failed",
      message: expect.stringContaining("过期"),
    });
    expect(() => store.complete(device, second.id, "eA==")).toThrow(/no longer active/u);
  }),
);
