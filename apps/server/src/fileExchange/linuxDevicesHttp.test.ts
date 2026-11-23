import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { FileExchange } from "./FileExchange.ts";
import * as LinuxDevicesHttp from "./linuxDevicesHttp.ts";

class LinuxDevicesTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.linuxDevices,
) {}

it.effect(
  "exposes queue and aliases only with access read, and gates cached diagnostics separately",
  () =>
    Effect.gen(function* () {
      const target = {
        deviceId: "linux-test",
        sftpAliases: ["linux-files"],
        diagnosticAliases: ["linux-diagnostics"],
        waiting: 2,
        active: "ssh-diagnostics" as const,
      };
      const lastDiagnostic = {
        result: { check: "uptime" as const, uptimeSeconds: 120 },
        checkedAt: "2026-11-23T00:00:00Z",
      };
      const routes = HttpApiBuilder.layer(LinuxDevicesTestApi).pipe(
        Layer.provide(LinuxDevicesHttp.layer),
        Layer.provide(
          Layer.succeed(FileExchange, {
            listDevices: Effect.succeed([{ ...target, lastDiagnostic }]),
            inspect: () => Effect.die("Listing must not run diagnostics"),
            transfer: () => Effect.die("Listing must not start a file transfer"),
          }),
        ),
        Layer.provide(
          Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              return yield* Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("linux-devices-http-test"),
                subject: "device-operator",
                method: "bearer-access-token",
                scopes: new Set([
                  ...(request.headers["x-test-access"] === "1" ? [AuthAccessReadScope] : []),
                  ...(request.headers["x-test-diagnostics"] === "1"
                    ? [AuthDiagnosticsReadScope]
                    : []),
                ]),
              });
            }),
          ),
        ),
        Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const server = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (server) => Effect.promise(() => server.dispose()),
      );
      const request = (headers: Record<string, string>) =>
        Effect.promise(() =>
          server.handler(new Request("http://localhost/api/linux-devices", { headers })),
        );
      expect((yield* request({ "x-test-diagnostics": "1" })).status).toBe(403);
      const metadata = yield* request({ "x-test-access": "1" });
      expect(metadata.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.promise(() => metadata.json())).toEqual({ devices: [target] });
      const diagnostics = yield* request({ "x-test-access": "1", "x-test-diagnostics": "1" });
      expect(yield* Effect.promise(() => diagnostics.json())).toEqual({
        devices: [{ ...target, lastDiagnostic }],
      });
    }),
);
