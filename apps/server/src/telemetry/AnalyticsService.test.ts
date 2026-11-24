import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { AnalyticsService, layer } from "./AnalyticsService.ts";

it("旧版设置无法启用产品上报，服务也无需文件系统、账号或 HTTP 服务", async () => {
  const send = vi.fn(() => {
    throw new Error("unexpected telemetry request");
  });
  vi.stubGlobal("fetch", send);
  vi.stubEnv("T3CODE_TELEMETRY_ENABLED", "true");
  vi.stubEnv("T3CODE_POSTHOG_HOST", "https://telemetry.invalid");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const analytics = yield* AnalyticsService;
        yield* analytics.record("client.turn.requested", { model: "test-model" });
        yield* analytics.flush;
      }).pipe(Effect.provide(layer)),
    );
    expect(send).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
});
