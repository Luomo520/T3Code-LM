import { describe, expect, it } from "vite-plus/test";
import { hasExplicitThreadFileSaveIntent } from "./intent.ts";

describe("会话文件保存请求", () => {
  it.each([
    "把刚才那张保存到我的设备",
    "保存刚才那份报告",
    "下载到这台电脑",
    "可以帮我把这张保存到这台电脑吗？",
    "Could you please save this to my desktop?",
    "请把它传到 K60 Pro",
    "把书房电脑的 APK 发到这台手机",
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
    "别把这个文件下载到手机",
    "上次我说“保存到我的设备”，现在请看看有无传输记录",
    "Just show it. Don't download the screenshot.",
    "Tell me whether you can preview the file.",
  ])("只查看时不触发保存 %s", (text) => expect(hasExplicitThreadFileSaveIntent(text)).toBe(false));
});
