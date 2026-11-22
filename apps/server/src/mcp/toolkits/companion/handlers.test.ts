import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { getCompanionStore } from "../../../companion/store.ts";
import { ServerConfig, layerTest } from "../../../config.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { layerCompanionToolkit, layerInProcessMcpServer } from "../../McpHttpServer.ts";
import { McpInvocationContext, type McpInvocationScope } from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const owner = ThreadId.make("companion-test-owner");
const other = ThreadId.make("companion-test-other");
const restricted = ThreadId.make("companion-test-restricted");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("companion-test"),
  capabilities: new Set(),
  issuedAt: 1,
  requestNamespace: "companion-test",
  thread: {
    threadId: owner,
    providerSessionId: "companion-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "companion-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "companion-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const testLayer = layerCompanionToolkit.pipe(
  Layer.provideMerge(layerInProcessMcpServer),
  Layer.provideMerge(
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(
          liveThreadShell(id, { runtimeMode: id === restricted ? "auto" : "full-access" }),
        ),
    }),
  ),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(layerTest(process.cwd(), { prefix: "t3-companion-mcp-" })),
  Layer.provide(NodeServices.layer),
);

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";
const deviceName = "Test desktop";
const info = { os: "win32" };

const setup = Effect.fnUntraced(function* () {
  const server = yield* McpServer.McpServer;
  const { stateDir } = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const store = getCompanionStore(stateDir);
  yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
  const { code } = store.pair();
  const identity = store.enroll(code, deviceName, info);
  const call = (name: string, args: Record<string, string>, invocation = scope) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  return { ...identity, call, store, settings };
});

it.effect("returns image bytes only to the thread that requested the screenshot", () =>
  Effect.gen(function* () {
    const { call, store, deviceId, token, settings } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const input = { deviceId, action: "screenshot", clientRequestId: "screenshot-once" };
    const queued = yield* call("t3_companion_enqueue", input);
    expect(queued.isError).not.toBe(true);
    const { job } = store.poll(token, deviceName, info);
    expect(job).toMatchObject({ action: "screenshot", threadId: owner });
    const id = job!.id;
    const repeated = yield* call("t3_companion_enqueue", input);
    expect(repeated.structuredContent).toMatchObject({ id, status: "running" });
    const running = yield* call("t3_companion_result", { id });
    expect(running.content.map(({ type }) => type)).toEqual(["text"]);

    store.complete(token, { id, status: "done", message: "Captured.", imageBase64: png });
    const denied = yield* call(
      "t3_companion_result",
      { id, threadId: owner },
      {
        ...scope,
        thread: { ...scope.thread!, threadId: other },
      },
    );
    expect(denied.isError).toBe(true);
    expect(denied.content.map(({ type }) => type)).toEqual(["text"]);

    const result = yield* call("t3_companion_result", { id });
    expect(result.structuredContent).toMatchObject({
      id,
      status: "done",
      deviceName,
      captureScope: "primary-display",
      screenshot: { mimeType: "image/png", width: 1, height: 1 },
    });
    expect(result.structuredContent).not.toHaveProperty("imagePath");
    expect(result.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: new Uint8Array(Buffer.from(png, "base64")),
    });
  }).pipe(Effect.provide(testLayer)),
);

it.effect("requires the beta switch and a regular thread in full-access mode to queue work", () =>
  Effect.gen(function* () {
    const { call, store, token, deviceId, settings } = yield* setup();
    const input = { deviceId, action: "open-t3", clientRequestId: "open-t3-once" };
    const disabled = yield* call("t3_companion_enqueue", input);
    expect(disabled.isError).toBe(true);

    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const outside = yield* call("t3_companion_enqueue", input, { ...scope, thread: undefined });
    const lowerMode = yield* call("t3_companion_enqueue", input, {
      ...scope,
      thread: { ...scope.thread!, threadId: restricted },
    });
    const unsupported = yield* call("t3_companion_enqueue", {
      ...input,
      action: "run-command",
    }).pipe(Effect.flip);
    expect([outside, lowerMode].map(({ isError }) => isError)).toEqual([true, true]);
    expect(unsupported).toMatchObject({ _tag: "InvalidParams" });
    expect(store.poll(token, deviceName, info).job).toBeNull();
  }).pipe(Effect.provide(testLayer)),
);
