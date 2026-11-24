import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constant } from "effect/Function";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

// 保留已有调用接口。初始化、记录和关闭均不读取身份、不排队、不联网。
export const layer = Layer.succeed(AnalyticsService, {
  record: constant(Effect.void),
  flush: Effect.void,
});
