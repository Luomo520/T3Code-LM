import { describe, expect, it } from "vite-plus/test";
import {
  hasExplicitThreadFileSaveIntent,
  threadFileDestination,
  threadFileManagementIntent,
  threadFileRedirectDestination,
  threadFileUrlRequest,
} from "./intent.ts";

describe("会话文件保存请求", () => {
  it.each([
    "把刚才那张保存到我的设备",
    "保存刚才那份报告",
    "下载到这台电脑",
    "可以帮我把这张保存到这台电脑吗？",
    "Could you please save this to my desktop?",
    "请把它传到 K60 Pro",
    "把书房电脑的 APK 发到这台手机",
    "把当前项目的 验证传输.txt 发到这台手机",
    "把刚才那份传过来",
    "生成一份记录然后发到这台手机",
    "Save the previous screenshot to this PC",
    "Transfer that file to my phone.",
  ])("识别明确请求 %s", (text) => expect(hasExplicitThreadFileSaveIntent(text)).toBe(true));

  it.each([
    "给我看看刚才的截图",
    "帮我看看这份文件保存了吗？",
    "帮我看看，下载要多久？",
    "Can I save this later?",
    "Has this already been saved?",
    "请检查文件下载好了没有。",
    "保存完成后会显示在哪？",
    "把书房电脑桌面截图发给我看看",
    "只给我看看，不要下载",
    "看一下文件，别把验证传输.txt传过来",
    "别把这个文件下载到手机",
    "上次我说“保存到我的设备”，现在请看看有无传输记录",
    "Just show it. Don't download the screenshot.",
    "Tell me whether you can preview the file.",
  ])("只查看时不触发保存 %s", (text) => expect(hasExplicitThreadFileSaveIntent(text)).toBe(false));
});

describe("取消和改发已有会话传输", () => {
  it.each([
    ["取消刚才那份", "cancel"],
    ["请取消 report.pdf", "cancel"],
    ["改发到书房电脑", "redirect"],
    ["把刚才那份改发给这台手机", "redirect"],
    ["Please redirect the last transfer to Studio", "redirect"],
    ["别取消刚才那份", undefined],
    ["取消刚才那份了吗？", undefined],
    ["取消了吗", undefined],
    ["上次我说“取消刚才那份”", undefined],
    ["看看刚才那份是否改发到书房电脑", undefined],
    ["Can I redirect that to Studio?", undefined],
  ])("识别 %s", (text, action) => {
    expect(threadFileManagementIntent(text)).toBe(action);
  });

  it.each([
    ["刚才那份改发到书房电脑", { kind: "named", label: "书房电脑" }],
    ["把刚才那份改发给这台手机", { kind: "current", device: "mobile" }],
    ["Please redirect the last transfer to Studio", { kind: "named", label: "studio" }],
  ])("从 %s 确认新接收设备", (text, destination) => {
    expect(threadFileRedirectDestination(text)).toEqual(destination);
  });
});

describe("原话中的目的设备", () => {
  it.each([
    ["把刚才那个发到书房电脑", { kind: "named", label: "书房电脑" }],
    ["把书房电脑的文件发到这台手机", { kind: "current", device: "mobile" }],
    ["发送到「书房电脑」", { kind: "named", label: "书房电脑" }],
    ["把这份发给「Studio」", { kind: "named", label: "studio" }],
    ["Send this file to Studio", { kind: "named", label: "studio" }],
    ["把刚才那份传过来", { kind: "current", device: "any" }],
    ["保存到我的设备", { kind: "current", device: "any" }],
    ["不要发到书房电脑", { kind: "unclear" }],
    ["发到书房电脑或者客厅电脑", { kind: "unclear" }],
    ["从书房电脑查看这份文件", { kind: "unclear" }],
  ])("从 %s 确认接收设备", (message, expected) => {
    expect(threadFileDestination(message)).toEqual(expected);
  });
});

describe("会话指定设备下载网址", () => {
  const url = "https://files.example.org/report.pdf?language=zh";
  it.each([
    `请把 ${url} 下载到书房电脑`,
    `请下载 ${url} 到书房电脑`,
    `Download ${url} to 书房电脑`,
  ])("读取明确请求 %s", (text) => {
    expect(threadFileDestination(threadFileUrlRequest(text, url) ?? "")).toEqual({
      kind: "named",
      label: "书房电脑",
    });
  });

  it.each([
    `请确认 ${url} 能否下载到书房电脑`,
    `请不要把 ${url} 下载到书房电脑`,
    `上次我说“把 ${url} 下载到书房电脑”`,
    `把 ${url} 和 https://other.example.org/test.txt 下载到书房电脑`,
    `把 https://files.example.org/report.pdf 下载到书房电脑`,
    `把 ${url}&extra=x 下载到书房电脑`,
    "把网址下载到书房电脑",
  ])("拒绝含糊或不同来源 %s", (text) => {
    expect(threadFileUrlRequest(text, url)).toBeUndefined();
  });
});
