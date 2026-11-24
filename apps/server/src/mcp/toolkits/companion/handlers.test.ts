import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AssetSigner } from "../../../assets/AssetSigner.ts";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { getAndroidCaptureStore } from "../../../companion/androidCaptureStore.ts";
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
  Layer.provide(
    Layer.succeed(AssetSigner, {
      sign: () => Effect.succeed("test-signature"),
      verify: (_payload, signature) => Effect.succeed(signature === "test-signature"),
    }),
  ),
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
  const call = (name: string, args: Record<string, unknown>, invocation = scope) =>
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

    const capture = { capturedAt: "2026-11-23T05:01:04.010Z", label: "记事本" };
    store.complete(token, {
      id,
      status: "done",
      message: "Captured.",
      imageBase64: png,
      captureScope: "window",
      capture,
    });
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
      captureScope: "window",
      capture,
      summary: `${deviceName} · 窗口 记事本 · 拍摄时间 ${capture.capturedAt}`,
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

it.effect("keeps a completed recording scoped to the original thread", () =>
  Effect.gen(function* () {
    const { call, store, deviceId, token, settings } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const queued = yield* call("t3_companion_enqueue", {
      deviceId,
      action: "record-screen",
      clientRequestId: "recording-once",
    });
    expect(queued.isError).not.toBe(true);
    const { job } = store.poll(token, deviceName, { ...info, recordingStop: "true" });
    expect(job).toMatchObject({ action: "record-screen", threadId: owner });
    const id = job!.id;
    const stop = yield* call("t3_companion_cancel", { id });
    expect(stop.structuredContent).toMatchObject({ id, status: "running", stopRequested: true });
    expect((yield* call("t3_companion_result", { id })).structuredContent).toMatchObject({
      id,
      status: "running",
      stopRequested: true,
    });
    const recording = Buffer.alloc(224);
    recording.write("RIFF");
    recording.writeUInt32LE(recording.length - 8, 4);
    recording.write("AVI LIST", 8);
    recording.write("hdrl", 16);
    store.complete(token, {
      id,
      status: "done",
      message: "Recorded.",
      recordingBase64: recording.toString("base64"),
    });

    const denied = yield* call(
      "t3_companion_result",
      { id },
      {
        ...scope,
        thread: { ...scope.thread!, threadId: other },
      },
    );
    expect(denied.isError).toBe(true);
    const result = yield* call(
      "t3_companion_result",
      { id },
      {
        ...scope,
        origin: "https://companion.test",
      },
    );
    expect(result.structuredContent).toMatchObject({
      status: "done",
      captureScope: "primary-display",
      recording: {
        url: expect.stringMatching(/^https:\/\/companion\.test\/api\/assets\/.+\.avi$/u),
        expiresAt: expect.any(Number),
      },
    });
    expect(result.content.map(({ type }) => type)).toEqual(["text"]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("queues the explicit Notepad text only for its paired device", () =>
  Effect.gen(function* () {
    const { call, store, deviceId, token, settings } = yield* setup();
    yield* settings.updateSettings({ windowsCompanionEnabled: true });
    const input = { deviceId, action: "write-notepad", clientRequestId: "fill-notepad" };
    expect((yield* call("t3_companion_enqueue", input)).isError).toBe(true);
    const queued = yield* call("t3_companion_enqueue", { ...input, text: "可见的测试文字" });
    expect(queued.isError).not.toBe(true);
    const { job } = store.poll(token, deviceName, info);
    expect(job).toMatchObject({
      action: "write-notepad",
      threadId: owner,
      params: { text: "可见的测试文字" },
    });
    const id = job!.id;
    store.complete(token, { id, status: "done", message: "可见的测试文字" });
    const result = yield* call("t3_companion_result", { id });
    expect(result.structuredContent).toMatchObject({ status: "done", message: "可见的测试文字" });
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "requests locally chosen Windows actions with empty parameters and thread-scoped results",
  () =>
    Effect.gen(function* () {
      const { call, store, deviceId, token, settings } = yield* setup();
      yield* settings.updateSettings({ windowsCompanionEnabled: true });
      const capable = { ...info, localToolsV1: "true" };
      store.checkDevice(token, capable);
      const withParams = {
        deviceId,
        action: "run-approved-script",
        clientRequestId: "with-params",
      };
      const unknown = yield* call("t3_companion_enqueue", {
        ...withParams,
        params: {},
      }).pipe(Effect.flip);
      expect(unknown).toMatchObject({ _tag: "InvalidParams" });
      const unrelated = yield* call("t3_companion_enqueue", { ...withParams, text: "额外参数" });
      expect(unrelated.isError).toBe(true);
      const explicitNull = yield* call("t3_companion_enqueue", {
        ...withParams,
        attachmentId: null,
      });
      expect(explicitNull.isError).toBe(true);
      expect(store.poll(token, deviceName, capable).job).toBeNull();

      const results = [
        ["inspect-window-controls", "done", "已检查本机所选窗口。"],
        ["run-approved-script", "failed", "Windows 用户取消了请求。"],
        ["open-ssh-profile", "failed", "Windows 无法打开所选配置。"],
      ] as const;
      for (const [action, status, message] of results) {
        const queued = yield* call("t3_companion_enqueue", {
          deviceId,
          action,
          clientRequestId: action,
        });
        const job = store.poll(token, deviceName, capable).job!;
        expect(job).toMatchObject({ action, threadId: owner, params: {} });
        expect(queued.structuredContent).toMatchObject({ id: job.id, action, status: "queued" });
        store.complete(token, { id: job.id, status, message });
        const result = yield* call("t3_companion_result", { id: job.id });
        expect(result.structuredContent).toMatchObject({ action, status, message });
        const denied = yield* call(
          "t3_companion_result",
          { id: job.id },
          {
            ...scope,
            thread: { ...scope.thread!, threadId: other },
          },
        );
        expect(denied.isError).toBe(true);
      }
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "routes paired Android captures and terminal results only through the originating thread",
  () =>
    Effect.gen(function* () {
      const { call } = yield* setup();
      const { stateDir } = yield* ServerConfig;
      const store = getAndroidCaptureStore(stateDir);
      const deviceId = "android:companion-test-phone";
      store.listen(deviceId, "Test Android", "background-ready");
      const list = yield* call("t3_companion_list", {});
      expect(list.structuredContent).toMatchObject({
        devices: [
          {
            deviceId,
            name: "Test Android",
            online: true,
            backgroundReady: true,
            platform: "android",
          },
        ],
      });
      const unsupported = yield* call("t3_companion_enqueue", {
        deviceId,
        action: "open-t3",
        clientRequestId: "unsupported",
      });
      expect(unsupported.isError).toBe(true);
      const queued = yield* call("t3_companion_enqueue", {
        deviceId,
        action: "screenshot",
        clientRequestId: "android-one",
      });
      expect(queued.isError).not.toBe(true);
      const id = store.listen(deviceId, "Test Android").job!.id;
      store.approve(deviceId, id);
      store.complete(deviceId, id, png);
      const denied = yield* call(
        "t3_companion_result",
        { id },
        {
          ...scope,
          thread: { ...scope.thread!, threadId: other },
        },
      );
      expect(denied.isError).toBe(true);
      const result = yield* call("t3_companion_result", { id });
      expect(result.content.map(({ type }) => type)).toEqual(["text", "image"]);
      expect(result.structuredContent).toMatchObject({
        id,
        status: "done",
        captureScope: "android-screen",
      });
    }).pipe(Effect.provide(testLayer)),
);

it.effect("returns a signed Android MP4 recording to its original conversation", () =>
  Effect.gen(function* () {
    const { call } = yield* setup();
    const { stateDir } = yield* ServerConfig;
    const store = getAndroidCaptureStore(stateDir);
    const deviceId = "android:recording-test-phone";
    store.listen(deviceId, "Test Android");
    const queued = yield* call("t3_companion_enqueue", {
      deviceId,
      action: "record-screen",
      clientRequestId: "android-video",
    });
    expect(queued.isError).not.toBe(true);
    const job = store.listen(deviceId, "Test Android").job!;
    expect(job.durationSeconds).toBe(10);
    store.approve(deviceId, job.id);
    expect(() => store.complete(deviceId, job.id, png)).toThrow(/MP4/u);
    // 测试容器边界、扩展和原会话签名。视频解码由客户端的原生播放器负责。
    const media = Buffer.from(
      "000000106674797069736F6D00000000000000086D6F6F76000000016D646174000000000000001101",
      "hex",
    ).toString("base64");
    store.complete(deviceId, job.id, media);
    const result = yield* call("t3_companion_result", { id: job.id });
    expect(result.structuredContent).toMatchObject({
      id: job.id,
      status: "done",
      captureScope: "android-screen",
      recording: { url: expect.stringMatching(/\.mp4$/u), expiresAt: expect.any(Number) },
    });
  }).pipe(Effect.provide(testLayer)),
);
