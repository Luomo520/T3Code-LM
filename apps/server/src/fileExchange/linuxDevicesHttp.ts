import {
  AuthAccessReadScope,
  AuthDiagnosticsReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { requireEnvironmentScope } from "../auth/http.ts";
import { FileExchange } from "./FileExchange.ts";

export const layer = HttpApiBuilder.group(EnvironmentHttpApi, "linuxDevices", (handlers) =>
  Effect.gen(function* () {
    const exchange = yield* FileExchange;
    return handlers.handle("list", () =>
      Effect.gen(function* () {
        const principal = yield* requireEnvironmentScope(AuthAccessReadScope);
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
        );
        const devices = yield* exchange.listDevices;
        return {
          devices: principal.scopes.has(AuthDiagnosticsReadScope)
            ? devices
            : devices.map(({ lastDiagnostic: _lastDiagnostic, ...device }) => device),
        };
      }),
    );
  }),
);
