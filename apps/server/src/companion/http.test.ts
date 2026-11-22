import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
import { getCompanionStore } from "./store.ts";

class CompanionTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.companions,
) {}

const layerTestAuth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("companion-http-test-session"),
      subject: "companion-http-test",
      method: "bearer-access-token",
      scopes: new Set(
        request.headers["x-test-admin"] === "1" ? [AuthAccessWriteScope] : [AuthSettingsWriteScope],
      ),
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
  return { settings, request, server, store };
});

const admin = { "x-test-admin": "1" };
const deviceInfo = { name: "Windows test", info: { os: "win32" } };

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
    const taskPoll = yield* request("/poll", { headers: auth, body: deviceInfo });
    expect(yield* Effect.promise(() => taskPoll.json())).toEqual({
      name: "Updated",
      job: { id: task.id, action: "open-notepad", threadId: "test-thread", params: {} },
    });
    const result = yield* request("/result", {
      headers: auth,
      body: { id: task.id, status: "done", message: "OK" },
    });
    expect(yield* Effect.promise(() => result.json())).toEqual({ ok: true });

    yield* settings.updateSettings({ windowsCompanionEnabled: false });
    const list = yield* request("", { method: "GET", headers: admin });
    expect(yield* Effect.promise(() => list.json())).toMatchObject({
      devices: [{ deviceId, name: "Updated", recentTasks: [{ id: task.id, status: "done" }] }],
    });
    expect((yield* request("/poll", { headers: auth, body: deviceInfo })).status).toBe(404);
    expect((yield* request("/revoke", { headers: auth, body: {} })).status).toBe(200);

    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    expect((yield* request("/poll", { headers: auth, body: deviceInfo })).status).toBe(401);
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
