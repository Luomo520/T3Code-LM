import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { expect, it, onTestFinished, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { V2ItemInspector } from "./V2ItemInspector";

const { previewUrl, refresh } = vi.hoisted(() => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Y9sAAAAASUVORK5CYII=";
  return {
    previewUrl: `data:image/png;base64,${png}`,
    refresh: vi.fn(async () => `data:image/png;base64,${png}`),
  };
});

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success" as const,
    url: previewUrl,
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () =>
    Option.some({ httpBaseUrl: "https://thread.test" }) as ReturnType<
      typeof import("~/state/session").usePreparedConnection
    >,
}));
vi.mock(import("./CommandOutputPanel"), async (original) => ({
  ...(await original()),
  useCommandOutputStreaming: () => false,
}));

it("previews a stored screenshot and hands off the unmodified PNG only after Save", async () => {
  const threadId = ThreadId.make("screenshot-thread");
  const itemId = TurnItemId.make("screenshot-result");
  const summary = "书房 PC · 窗口 记事本 · 拍摄时间 2026-11-23T02:14:02.100Z";
  const projectedItem = {
    position: 1,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-23T02:15:00Z"),
      type: "dynamic_tool",
      toolName: "t3-code-direct.t3_companion_result",
      input: {},
      output: {
        content: [{ type: "image", mimeType: "image/png" }],
        structuredContent: { summary },
      },
    },
  } satisfies OrchestrationV2ProjectedTurnItem;
  const openPreview = vi.fn();
  const savedNames: string[] = [];
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    savedNames.push(this.download);
  });
  const createObjectUrl = vi.spyOn(URL, "createObjectURL");
  onTestFinished(() => {
    clicked.mockRestore();
    createObjectUrl.mockRestore();
  });

  await using screen = await render(
    <V2ItemInspector
      projectedItem={projectedItem}
      environmentId={EnvironmentId.make("environment-screenshot")}
      onImageExpand={openPreview}
    />,
    { router: false },
  );
  await expect.element(screen.getByText(summary)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Preview 设备截图" }));
  expect(openPreview).toHaveBeenCalledOnce();
  expect(refresh).not.toHaveBeenCalled();
  expect(clicked).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "保存到我的设备" }));
  await expect.poll(() => savedNames.length).toBe(1);
  expect(savedNames).toEqual(["截图-creenshot-result.png"]);
  expect(refresh).toHaveBeenCalledOnce();
  const blob = createObjectUrl.mock.calls.at(-1)?.[0];
  expect(blob).toBeInstanceOf(Blob);
  expect(await (blob as Blob).arrayBuffer()).toEqual(await (await fetch(previewUrl)).arrayBuffer());
});

function syntheticRecording() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 16;
  const context = canvas.getContext("2d")!;
  const frames = Array.from({ length: 25 }, (_, index) => `hsl(${index * 37}, 90%, 50%)`).map(
    (color) => {
      context.fillStyle = color;
      context.fillRect(0, 0, canvas.width, canvas.height);
      return Uint8Array.from(atob(canvas.toDataURL("image/jpeg").split(",")[1]!), (byte) =>
        byte.charCodeAt(0),
      );
    },
  );
  const indexStart =
    224 + frames.reduce((size, frame) => size + 8 + frame.length + (frame.length % 2), 0);
  const bytes = new Uint8Array(indexStart + 8 + frames.length * 16);
  const view = new DataView(bytes.buffer);
  const u32 = (offset: number, value: number) => view.setUint32(offset, value, true);
  const tag = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  tag(0, "RIFF");
  u32(4, bytes.length - 8);
  tag(8, "AVI LIST");
  u32(16, 192);
  tag(20, "hdrlavih");
  u32(28, 56);
  u32(32, 200_000);
  u32(48, frames.length);
  u32(56, 1);
  u32(64, canvas.width);
  u32(68, canvas.height);
  tag(88, "LIST");
  u32(92, 116);
  tag(96, "strlstrh");
  u32(104, 56);
  tag(108, "vidsMJPG");
  u32(128, 1);
  u32(132, 5);
  u32(140, frames.length);
  tag(164, "strf");
  u32(168, 40);
  u32(172, 40);
  u32(176, canvas.width);
  u32(180, canvas.height);
  tag(188, "MJPG");
  tag(212, "LIST");
  u32(216, indexStart - 220);
  tag(220, "movi");
  tag(indexStart, "idx1");
  u32(indexStart + 4, frames.length * 16);
  let offset = 224;
  frames.forEach((frame, index) => {
    const indexEntry = indexStart + 8 + index * 16;
    tag(offset, "00dc");
    u32(offset + 4, frame.length);
    bytes.set(frame, offset + 8);
    tag(indexEntry, "00dc");
    u32(indexEntry + 4, 16);
    u32(indexEntry + 8, offset - 220);
    u32(indexEntry + 12, frame.length);
    offset += 8 + frame.length + (frame.length % 2);
  });
  return bytes;
}

const recordingPath =
  "/api/assets/test-payload.test-signature/a0000000-0000-4000-a000-000000000000.avi";

function projectedRecording(expiresAt: number, taskId?: string): OrchestrationV2ProjectedTurnItem {
  const threadId = ThreadId.make("recording-thread");
  const itemId = TurnItemId.make("recording-result");
  const metadata = {
    action: "record-screen",
    status: "done",
    ...(taskId
      ? {
          id: taskId,
          deviceName: "书房 PC",
          captureScope: "window",
          capture: { label: "记事本", capturedAt: "2026-11-23T02:14:05.120Z" },
          updatedAt: "2026-11-23T02:15:00.000Z",
        }
      : {}),
    recording: { url: `http://127.0.0.1:3000${recordingPath}`, expiresAt },
  };
  return {
    position: 1,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: itemId,
    item: {
      id: itemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-23T02:15:00Z"),
      type: "dynamic_tool",
      toolName: "t3-code-direct.t3_companion_result",
      input: {},
      output: {
        content: [{ type: "text", text: JSON.stringify(metadata) }],
        structuredContent: metadata,
      },
    },
  };
}

function mockRecordingRequest(response: Response) {
  const original = globalThis.fetch;
  const requests = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((url, init) =>
      typeof url === "string" && url.includes(recordingPath)
        ? requests(url, init)
        : original(url, init),
    );
  onTestFinished(() => fetchSpy.mockRestore());
  return requests;
}

it("plays and stops a companion recording in the tool result on demand", async () => {
  const recording = syntheticRecording();
  const requests = mockRecordingRequest(new Response(recording));
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click");
  onTestFinished(() => {
    clicked.mockRestore();
  });

  await using screen = await render(
    <V2ItemInspector
      projectedItem={projectedRecording(Number.MAX_SAFE_INTEGER)}
      environmentId={EnvironmentId.make("recording-environment")}
    />,
    { router: false },
  );
  const play = screen.getByRole("button", { name: "播放录屏" });
  await expect.element(play).toBeVisible();
  expect(requests).not.toHaveBeenCalled();
  await userEvent.click(play);
  expect(requests).toHaveBeenCalledExactlyOnceWith(
    `https://thread.test${recordingPath}`,
    expect.objectContaining({ credentials: "omit", redirect: "error", cache: "no-store" }),
  );
  const frame = screen.getByRole("img", { name: "Windows 主屏幕录屏" });
  await expect.poll(() => (frame.query() as HTMLImageElement | null)?.naturalWidth ?? 0).toBe(16);
  await userEvent.click(screen.getByRole("button", { name: "停止播放" }));
  await expect.element(frame).not.toBeInTheDocument();
  await expect.element(play).toBeVisible();
  expect(clicked).not.toHaveBeenCalled();
});

it.each([
  [1, "录像链接已过期，请在此会话重新获取录像。", false],
  [Number.MAX_SAFE_INTEGER, "无法播放录像，请检查连接后重试。", true],
])("shows the recording failure inside the tool result", async (expiresAt, message, requested) => {
  const requests = mockRecordingRequest(new Response(null, { status: 404 }));
  await using screen = await render(
    <V2ItemInspector
      projectedItem={projectedRecording(expiresAt)}
      environmentId={EnvironmentId.make("recording-environment")}
    />,
    { router: false },
  );

  await userEvent.click(screen.getByRole("button", { name: "播放录屏" }));
  await expect.element(screen.getByText(message)).toBeVisible();
  expect(requests).toHaveBeenCalledTimes(requested ? 1 : 0);
});

it("renews the archived clip in the original thread when the stored link has expired", async () => {
  const requests = mockRecordingRequest(new Response(syntheticRecording()));
  const taskId = "a0000000-0000-4000-a000-000000000000";
  refresh.mockResolvedValueOnce(`https://thread.test${recordingPath}`);
  await using screen = await render(
    <V2ItemInspector
      projectedItem={projectedRecording(1, taskId)}
      environmentId={EnvironmentId.make("recording-environment")}
    />,
    { router: false },
  );

  await expect
    .element(screen.getByText("书房 PC · 窗口 记事本 · 录制开始 2026-11-23T02:14:05.120Z"))
    .toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "播放录屏" }));
  await expect.element(screen.getByRole("img", { name: "Windows 窗口录屏" })).toBeVisible();
  expect(requests).toHaveBeenCalledTimes(1);
});
