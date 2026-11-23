import { describe, expect, it } from "vite-plus/test";
import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  companionRecordingOutput,
  companionScreenshotOutput,
  isJsonToolText,
  threadFileSaveOutput,
  turnItemOutputImages,
  turnItemOutputText,
} from "./itemDetail.ts";

describe("isJsonToolText", () => {
  it.each([
    ['{"screenshot":{"mimeType":"image/png"}}', true],
    ['[{"threadId":"thread-1"}]', true],
    ['{\n\n  "status": "completed"\n}', true],
    ['{\n  "count": 1\n}\n\n{\n  "count": 2\n}', true],
    ["false", true],
    ["null", true],
    ["42", true],
    ['"completed"', true],
    ['{"partial":', false],
    ['{"count":1}\n\nFinished.', false],
    ["No output.", false],
    ["", false],
  ] as const)("classifies %j as JSON: %s", (text, expected) => {
    expect(isJsonToolText(text)).toBe(expected);
  });
});

function toolItem(
  output: unknown,
  toolName = "screenshots",
): Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> {
  return {
    id: TurnItemId.make("images"),
    threadId: ThreadId.make("thread"),
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
    updatedAt: DateTime.makeUnsafe("2026-10-01T00:00:00Z"),
    type: "dynamic_tool",
    toolName,
    input: {},
    output,
  };
}

describe("companion screenshot output", () => {
  const summary = "书房 PC · 主显示器 · 上报时间 2026-11-23T01:23:45Z";
  const metadata = { status: "done", captureScope: "primary-display", summary };
  const image = { type: "image", mimeType: "image/png" };
  const content = [{ type: "text", text: JSON.stringify(metadata) }, image];

  it.each([
    ["t3-code-direct.t3_companion_result", { content, structuredContent: metadata }],
    ["mcp__t3-code__t3_companion_result", content],
    ["t3-code-thread_123_t3_companion_result", content],
  ])("shows the summary for a stored PNG from %s", (name, output) => {
    const item = toolItem(output, name);
    expect(companionScreenshotOutput(item)).toEqual({
      summary,
      fileName: "截图-images.png",
    });
    expect(turnItemOutputImages(item)).toEqual([
      { _tag: "tool-output-image", threadId: "thread", itemId: "images", index: 0 },
    ]);
  });

  it("only offers an original PNG for a result with image bytes available", () => {
    expect(companionScreenshotOutput(toolItem(content, "t3.other_tool"))).toBeNull();
    expect(companionScreenshotOutput(toolItem(metadata, "t3-code.t3_companion_result"))).toBeNull();
    expect(
      companionScreenshotOutput({
        ...toolItem(content, "t3-code.t3_companion_result"),
        outputOmitted: true,
      }),
    ).toBeNull();
  });
});

describe("companion recording capture time", () => {
  const reportedAt = "2026-11-23T09:12:05.123Z";
  const original = {
    status: "done",
    action: "record-screen",
    deviceName: "书房 PC",
    captureScope: "window",
    updatedAt: reportedAt,
    recording: { url: "/api/assets/signed", expiresAt: 5 },
  };
  const tool = "t3-code-direct.t3_companion_result";

  it("shows the selected window and the original first-frame time", () => {
    const capture = { capturedAt: "2026-11-23T09:09:05.123Z", label: "记事本" };
    const item = toolItem({ structuredContent: { ...original, capture } }, tool);
    expect(companionRecordingOutput(item)?.caption).toBe(
      "书房 PC · 窗口 记事本 · 录制开始 2026-11-23T09:09:05.123Z",
    );
  });

  it("labels the timestamp in older recording results as the report time", () => {
    const item = toolItem([{ type: "text", text: JSON.stringify(original) }], tool);
    expect(companionRecordingOutput(item)?.caption).toBe(
      `书房 PC · 所选窗口 · 上报时间 ${reportedAt}`,
    );
  });
});

describe("thread file save receipt", () => {
  it("renders the device's verified Android version code without truncating it", () => {
    const result = {
      name: "t3-code.apk",
      recipientLabel: "手机",
      status: "saved",
      installation: {
        status: "verified",
        packageName: "app.t3code",
        version: "0.2.4",
        versionCode: "9223372036854775807",
      },
    };
    const tool = "mcp__t3-code__t3_thread_file_save_status";
    const item = toolItem([{ type: "text", text: JSON.stringify(result) }], tool);
    expect(threadFileSaveOutput(item)).toEqual({
      status: "saved",
      id: null,
      text: "手机 已核验安装 app.t3code 0.2.4（9223372036854775807）。",
    });
  });

  it.each(["t3-code.t3_thread_file_save", "t3-code.t3_thread_save_workspace_file"])(
    "shows a receipt for %s",
    (tool) => {
      const item = toolItem(
        {
          name: "t3-code.apk",
          recipientLabel: "手机",
          status: "awaiting_save",
        },
        tool,
      );
      expect(threadFileSaveOutput(item)).toMatchObject({ status: "awaiting_save" });
    },
  );
});

describe("tool image output parsing", () => {
  it.each(["image-only", "summary", "json"] as const)(
    "keeps structured fields beside %s content",
    (shape) => {
      const content = [
        { type: "image", mimeType: "image/png" },
        ...(shape === "image-only"
          ? []
          : [{ type: "text", text: shape === "summary" ? "Sunny" : '{"temp":21}' }]),
      ];
      for (const structuredContent of [
        { temp: 21 },
        { type: "text", text: "Sunny", temp: 21 },
        { content: [{ type: "text", text: "Sunny" }], temp: 21 },
      ]) {
        const item = toolItem({ structuredContent, content });
        expect(turnItemOutputText(item)).toBe(JSON.stringify(structuredContent, null, 2));
        expect(turnItemOutputImages(item)).toHaveLength(1);
      }
      for (const structuredContent of [null, {}, [], ""]) {
        const item = toolItem({ structuredContent, content: [{ type: "text", text: "Sunny" }] });
        expect(turnItemOutputText(item)).toBe("Sunny");
      }
      expect(
        turnItemOutputText(
          toolItem({
            content: [{ type: "text", text: "File contents" }],
            structuredContent: { path: "read.ts", ready: true },
          }),
        ),
      ).toBe("File contents");
    },
  );
  it.each(["array", "content", "structured"] as const)(
    "keeps markers for images beyond the served positions in %s output",
    (shape) => {
      // Detail responses retain image metadata after the server strips image bytes.
      const image = { type: "image", mimeType: "image/png" };
      const blocks = Array.from({ length: 8 }, () => ({ ...image }));
      const wrap = (content: unknown[]) =>
        shape === "array"
          ? content
          : shape === "structured"
            ? { content, structuredContent: { temp: 21 } }
            : { content };
      const withinLimit = toolItem(wrap(blocks));
      expect(turnItemOutputText(withinLimit)).toBe(
        shape === "structured" ? '{\n  "temp": 21\n}' : null,
      );
      expect(turnItemOutputImages(withinLimit)).toHaveLength(8);

      const overflow = toolItem(
        wrap([
          ...blocks,
          { type: "text", text: "Two additional screenshots:" },
          { ...image, sizeBytes: 100 },
          { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
        ]),
      );
      expect(turnItemOutputImages(overflow)).toHaveLength(8);
      expect(turnItemOutputText(overflow)).toBe(
        (shape === "structured" ? '{\n  "temp": 21\n}' : "Two additional screenshots:") +
          "\n[image]\n[image]",
      );
    },
  );
});

describe("MCP app tool output", () => {
  it("shows the tool result, not the app wrapper", () => {
    const text = "Notice\nview\tcount\n/home\t42";
    const item = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "aggregate_rum_events",
        resourceUri: "ui://repro/dataviz",
      },
      result: { content: [{ type: "text", text }] },
    });
    expect(turnItemOutputText(item)).toBe(text);
  });

  it("reads a result with metadata and marks images it cannot preview", () => {
    const item = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "chart",
        resourceUri: "ui://repro/chart",
      },
      result: {
        content: [
          { type: "text", text: "chart" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        ],
        _meta: { "ui/resourceUri": "ui://repro/chart" },
      },
    });
    expect(turnItemOutputText(item)).toBe("chart\n[image]");

    const bounded = toolItem({
      t3McpApp: {
        attachmentId: "app-html",
        server: "repro",
        tool: "chart",
        resourceUri: "ui://repro/chart",
      },
      result: [
        { type: "text", text: "chart" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(turnItemOutputText(bounded)).toBe("chart\n[image]");
  });
});
