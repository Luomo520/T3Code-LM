import {
  EnvironmentId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
  useAssetUrlState: () => ({ _tag: "Success" as const, url: previewUrl, expiresAt: Number.MAX_SAFE_INTEGER }),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("./CommandOutputPanel"), async (original) => ({
  ...(await original()),
  useCommandOutputStreaming: () => false,
}));

it("previews a stored screenshot and hands off the unmodified PNG only after Save", async () => {
  const threadId = ThreadId.make("screenshot-thread");
  const itemId = TurnItemId.make("screenshot-result");
  const summary = "书房 PC · 主显示器 · 上报时间 2026-11-23T02:15:00Z";
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
