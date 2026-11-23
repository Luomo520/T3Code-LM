import { expect, it } from "@effect/vitest";
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as DeviceService from "./DeviceService.ts";
import * as DeviceHubProxy from "./DeviceHubProxy.ts";

it.effect.each([
  { name: "forwards binary simulator frames", mode: "other", expected: [[0x83], [3, 1], [3, 2]] },
  {
    name: "rejects input after a real-device lease is released",
    mode: "physical",
    expected: [[0x83], '{"type":"back"}', '{"type":"reset-video","ack":false}'],
  },
  {
    name: "lets a read-only real-device viewer receive frames",
    mode: "viewer",
    expected: [[0x83], '{"type":"reset-video","ack":false}'],
  },
] as const)("$name", ({ mode, expected }) =>
  Effect.gen(function* () {
    const hub = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
      (server) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              for (const client of server.clients) client.terminate();
              server.close(() => resolve());
            }),
        ),
    );
    if (!hub.address())
      yield* Effect.promise(() => new Promise<void>((resolve) => hub.once("listening", resolve)));
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    hub.on("connection", (socket) => {
      socket.send(Uint8Array.of(0x83));
      socket.on("message", (data, binary) => socket.send(data, { binary }));
    });
    let leased = true;
    const services = yield* Layer.build(
      HttpRouter.serve(DeviceHubProxy.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(
          Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: AuthSessionId.make("test"),
                subject: "test",
                method: "bearer-access-token",
                scopes:
                  mode === "other"
                    ? [AuthOrchestrationOperateScope]
                    : mode === "viewer"
                      ? [AuthOrchestrationReadScope]
                      : [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              }),
          } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Layer.provide(
          Layer.mock(DeviceService.DeviceService)({
            physicalInputMode: () => Effect.succeed(mode === "other" ? "other" : "physical"),
            allowsPhysicalInput: (_host, _device, _auth, lease) =>
              Effect.succeed(leased && lease === "lease"),
            currentReadiness: () =>
              Effect.succeed({
                hostId: LOCAL_DEVICE_HOST_ID,
                hub: { origin: `http://127.0.0.1:${address.port}` },
                nodePath: "node",
                helpers: { serveSimAxSettings: null, serveSimCli: null },
                run: () => Effect.die("unexpected ADB command"),
                devices: {
                  list: Effect.die("unexpected list"),
                  boot: () => Effect.die("unexpected boot"),
                  attach: () => Effect.die("unexpected attach"),
                  shutdown: () => Effect.die("unexpected shutdown"),
                  screenshot: () => Effect.die("unexpected screenshot"),
                },
              }),
          }),
        ),
      ),
    );
    const origin = HttpServer.formatAddress(
      Context.get(services, HttpServer.HttpServer).address,
    ).replace(/^http/, "ws");
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new WebSocket(
            `${origin}/api/device-hub/vendor/${mode === "other" ? "serve-sim/helper" : "serve-emu"}/ws?device=test&wsTicket=test`,
          ),
      ),
      (socket) => Effect.sync(() => socket.close()),
    );
    client.binaryType = "arraybuffer";
    const frames: Array<number[] | string> = [];
    const received = Promise.withResolvers<void>();
    client.addEventListener("error", () => received.reject(new Error("Proxy failed")));
    client.addEventListener("message", ({ data }) => {
      frames.push(
        typeof data === "string" ? data : Array.from(new Uint8Array(data as ArrayBuffer)),
      );
      if (frames.length === 1) {
        if (mode === "other") {
          client.send(Uint8Array.of(0x03, 1));
          client.send(Uint8Array.of(0x03, 2));
        } else {
          client.send('{"type":"back","t3InputLease":"expired"}');
          client.send('{"type":"back","t3InputLease":"lease"}');
          if (mode === "viewer") client.send('{"type":"reset-video","ack":false}');
        }
      } else if (frames.length === 2 && mode === "physical") {
        leased = false;
        client.send('{"type":"back","t3InputLease":"lease"}');
        client.send('{"type":"reset-video","ack":false}');
      }
      if (frames.length === expected.length) received.resolve();
    });
    yield* Effect.promise(() => received.promise);
    expect(frames).toEqual(expected);
  }),
);

it.live("closes an upstream socket that is still connecting without an unhandled error", () =>
  Effect.gen(function* () {
    const dialed = Promise.withResolvers<NodeNet.Socket>();
    // Accepts the connection and never answers the WebSocket handshake.
    const hub = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeNet.Server>((resolve) => {
            const server = NodeNet.createServer((socket) => dialed.resolve(socket));
            server.listen(0, "127.0.0.1", () => resolve(server));
          }),
      ),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    const address = hub.address();
    if (typeof address !== "object" || !address) throw new Error("Missing hub port");
    // Handshake headers, as Simlock's routes send, select the `ws` package over the global WebSocket.
    const upstream = yield* Socket.makeWebSocket(`ws://127.0.0.1:${address.port}`, {
      headers: { authorization: "Bearer test" },
    }).pipe(Effect.provide(DeviceHubProxy.upstreamWebSocketConstructor));
    const reading = yield* Effect.forkChild(
      Effect.scoped(Effect.flatMap(upstream.reader, ({ pull }) => pull)),
    );
    const connection = yield* Effect.promise(() => dialed.promise);
    const abandoned = new Promise<void>((resolve) => connection.once("close", () => resolve()));
    yield* Fiber.interrupt(reading);
    yield* Effect.promise(() => abandoned);
  }),
);
