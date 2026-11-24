import {
  AndroidCaptureInput,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  COMPANION_MAX_IMAGE_BASE64_LENGTH,
  CompanionCheckInput,
  CompanionEnrollInput,
  CompanionPollInput,
  CompanionRenameInput,
  CompanionResultInput,
  CompanionTransferReadInput,
  CompanionUnbindInput,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { failEnvironmentInternal, requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { getAndroidCaptureStore } from "./androidCaptureStore.ts";
import { CompanionError, getCompanionStore } from "./store.ts";
import { readCompanionTransferFile } from "./transferFile.ts";

const MAX_DEVICE_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BODY_BYTES = COMPANION_MAX_IMAGE_BASE64_LENGTH + MAX_DEVICE_BODY_BYTES;
const PAIRING_ATTEMPT_WINDOW_MS = 60_000;
const PAIRING_ATTEMPTS_PER_SOURCE = 30;
const PAIRING_ATTEMPTS_TOTAL = 300;
const ok = { ok: true } as const;

const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "cache-control", "no-store")),
);

const requireNativeClient = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined
    ? Effect.fail(new CompanionError(403, "Windows companion requests require a native client."))
    : Effect.void;

const readJson = Effect.fnUntraced(function* <S extends Schema.Top>(
  request: HttpServerRequest.HttpServerRequest,
  maxBytes: number,
  schema: S,
) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return yield* Effect.fail(new CompanionError(415, "Content-Type must be application/json."));
  }
  const tooLarge = new CompanionError(413, "Companion request is too large.");
  if (Number(request.headers["content-length"]) > maxBytes) {
    return yield* Effect.fail(tooLarge);
  }
  // 分块传输没有 Content-Length，由底层读取器执行同样的字节限制。
  const bytes = yield* request.arrayBuffer.pipe(
    Effect.provideService(HttpServerRequest.MaxBodySize, ByteSize.bytes(maxBytes)),
    Effect.mapError((error) =>
      error.reason._tag === "RequestParseError" && error.reason.reason === "BodyTooLarge"
        ? tooLarge
        : new CompanionError(400, "Could not read companion request."),
    ),
  );
  if (bytes.byteLength > maxBytes) {
    return yield* Effect.fail(tooLarge);
  }
  const invalid = new CompanionError(400, "Invalid companion request.");
  const text = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () => invalid,
  });
  return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(() => invalid),
  );
});

const respond = <A, E, R>(effect: Effect.Effect<A, E | CompanionError, R>) =>
  noStore.pipe(
    Effect.andThen(effect),
    Effect.catchIf(
      (error): error is CompanionError => error instanceof CompanionError,
      (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe({ error: error.message }, { status: error.status }),
        ),
    ),
  );

class UnexpectedCompanionFailure extends Schema.TaggedError<UnexpectedCompanionFailure>()(
  "UnexpectedCompanionFailure",
  {},
) {}

const operate = <A>(operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) => (error instanceof CompanionError ? error : new UnexpectedCompanionFailure()),
  }).pipe(
    Effect.catchTags({
      UnexpectedCompanionFailure: () => failEnvironmentInternal("internal_error"),
    }),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "companions",
  Effect.fnUntraced(function* (handlers) {
    const { stateDir, attachmentsDir } = yield* ServerConfig.ServerConfig;
    const settings = yield* ServerSettingsService;
    const store = () => getCompanionStore(stateDir);
    const requireAdministrator = requireEnvironmentScope(AuthAccessWriteScope);
    let pairingWindowEndsAt = 0;
    let pairingAttemptsTotal = 0;
    const pairingAttempts = new Map<string, number>();
    const limitPairingAttempts = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= pairingWindowEndsAt) {
        pairingWindowEndsAt = now + PAIRING_ATTEMPT_WINDOW_MS;
        pairingAttemptsTotal = 0;
        pairingAttempts.clear();
      }
      // 真实对端地址由 HTTP 运行时提供。总次数上限也限制分布式尝试和内存占用。
      const source = Option.getOrElse(request.peerAddress, () => "");
      const attempts = pairingAttempts.get(source) ?? 0;
      if (
        attempts >= PAIRING_ATTEMPTS_PER_SOURCE ||
        pairingAttemptsTotal >= PAIRING_ATTEMPTS_TOTAL
      ) {
        return yield* Effect.fail(
          new CompanionError(429, "Too many companion pairing attempts. Try again later."),
        );
      }
      pairingAttemptsTotal += 1;
      pairingAttempts.set(source, attempts + 1);
    });
    const disabled = () => new CompanionError(404, "Windows companion is disabled.");
    const requireEnabled = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.catch(() => failEnvironmentInternal("internal_error")),
      );
      if (!current.windowsCompanionEnabled) {
        return yield* Effect.fail(disabled());
      }
    });
    // 请求体读取期间可能关闭功能。执行前在设置写锁下复核，避免与关停交错。
    const operateWhenEnabled = <A>(operation: () => A) =>
      settings
        .withSettingsSnapshot((current) =>
          current.windowsCompanionEnabled ? operate(operation) : Effect.fail(disabled()),
        )
        .pipe(
          Effect.catchTags({
            ServerSettingsError: () => failEnvironmentInternal("internal_error"),
          }),
        );
    const authenticateDevice = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const token = /^Bearer ([A-Za-z0-9._~-]{1,256})$/i.exec(
        request.headers.authorization ?? "",
      )?.[1];
      if (token === undefined) {
        return yield* Effect.fail(new CompanionError(401, "Invalid companion device token."));
      }
      yield* operate(() => store().authorize(token));
      return token;
    });

    return handlers
      .handleRaw("androidCapture", ({ request }) =>
        respond(
          Effect.gen(function* () {
            const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
            if (
              principal.method === "browser-session-cookie" ||
              request.headers.origin !== undefined ||
              request.headers["sec-fetch-site"] !== undefined
            ) {
              return yield* Effect.fail(
                new CompanionError(403, "Android capture requires a paired native client."),
              );
            }
            const input = yield* readJson(request, MAX_RESULT_BODY_BYTES, AndroidCaptureInput);
            const deviceId = `android:${principal.sessionId}`;
            return yield* operate(() => {
              const captures = getAndroidCaptureStore(stateDir);
              switch (input._tag) {
                case "listen":
                  return captures.listen(deviceId, input.name, input.delivery);
                case "approve":
                  return captures.approve(deviceId, input.id);
                case "status":
                  return captures.status(deviceId, input.id);
                case "reject":
                  captures.reject(deviceId, input.id, input.reason);
                  break;
                case "complete":
                  captures.complete(deviceId, input.id, input.media);
                  break;
              }
              return { _tag: "accepted" as const };
            });
          }),
        ),
      )
      .handle("pair", () =>
        respond(
          Effect.gen(function* () {
            yield* requireAdministrator;
            return yield* operateWhenEnabled(() => store().pair());
          }),
        ),
      )
      .handle("list", () =>
        respond(
          Effect.gen(function* () {
            const principal = yield* requireAdministrator;
            const devices = yield* operate(() =>
              store().list(principal.scopes.has(AuthOrchestrationReadScope)),
            );
            return { devices };
          }),
        ),
      )
      .handleRaw("rename", ({ request, params }) =>
        respond(
          Effect.gen(function* () {
            yield* requireAdministrator;
            const { name } = yield* readJson(request, 4096, CompanionRenameInput);
            yield* operate(() => store().rename(params.deviceId, name));
            return ok;
          }),
        ),
      )
      .handle("revoke", ({ params }) =>
        respond(
          Effect.gen(function* () {
            yield* requireAdministrator;
            yield* operate(() => store().revoke(params.deviceId));
            return ok;
          }),
        ),
      )
      .handleRaw("enroll", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            yield* requireEnabled;
            yield* limitPairingAttempts(request);
            const { code, name, info } = yield* readJson(
              request,
              MAX_DEVICE_BODY_BYTES,
              CompanionEnrollInput,
            );
            return yield* operateWhenEnabled(() => store().enroll(code, name, info));
          }),
        ),
      )
      .handleRaw("poll", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            yield* requireEnabled;
            const token = yield* authenticateDevice(request);
            const { name, info, watchRecordingId, watchTaskId, recordingReceiptV1 } =
              yield* readJson(request, MAX_DEVICE_BODY_BYTES, CompanionPollInput);
            return yield* operateWhenEnabled(() =>
              store().poll(token, name, info, watchRecordingId, watchTaskId, recordingReceiptV1),
            );
          }),
        ),
      )
      .handleRaw("checkDevice", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            yield* requireEnabled;
            const token = yield* authenticateDevice(request);
            const { name, info } = yield* readJson(
              request,
              MAX_DEVICE_BODY_BYTES,
              CompanionCheckInput,
            );
            return yield* operateWhenEnabled(() => store().checkDevice(token, info, name));
          }),
        ),
      )
      .handleRaw("readTransfer", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            yield* requireEnabled;
            const token = yield* authenticateDevice(request);
            const { id } = yield* readJson(
              request,
              MAX_DEVICE_BODY_BYTES,
              CompanionTransferReadInput,
            );
            return yield* operateWhenEnabled(() => {
              const transfer = store().receiveTransfer(token, id);
              const { attachmentId, fileName, sha256 } = transfer;
              if (!attachmentId || !fileName || !sha256) {
                throw new CompanionError(404, "No file was selected for this transfer.");
              }
              const file = readCompanionTransferFile(attachmentsDir, attachmentId);
              if (file.sha256 !== sha256) {
                throw new CompanionError(409, "The thread file changed. Create a new transfer.");
              }
              return { name: fileName, ...file };
            });
          }),
        ),
      )
      .handleRaw("result", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            yield* requireEnabled;
            const token = yield* authenticateDevice(request);
            const result = yield* readJson(request, MAX_RESULT_BODY_BYTES, CompanionResultInput);
            yield* operateWhenEnabled(() => store().complete(token, result));
            return ok;
          }),
        ),
      )
      .handleRaw("unbind", ({ request }) =>
        respond(
          Effect.gen(function* () {
            yield* requireNativeClient(request);
            const token = yield* authenticateDevice(request);
            yield* readJson(request, 4096, CompanionUnbindInput);
            yield* operate(() => store().unbind(token));
            return ok;
          }),
        ),
      );
  }),
);
