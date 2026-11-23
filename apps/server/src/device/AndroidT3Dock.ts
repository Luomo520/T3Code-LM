import {
  AndroidT3DockTab,
  DeviceHostUnavailableError,
  type DeviceHostId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SaxesParser } from "saxes";

import { readAndroidPhysicalDeviceStatus } from "./AndroidPhysicalDevice.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

const packageName = "com.t3tools.t3code.zh";
const packageFocus = /\bmCurrentFocus=Window\{[^}\r\n]*\bu\d+ com\.t3tools\.t3code\.zh\//u;
const isDockTab = Schema.is(AndroidT3DockTab);
type DockTab = {
  readonly name: AndroidT3DockTab;
  readonly selected: boolean;
  readonly x: number;
  readonly y: number;
};

function dockTabs(xml: string): ReadonlyArray<DockTab> | null {
  const start = xml.indexOf("<hierarchy");
  const closing = "</hierarchy>";
  const end = xml.indexOf(closing, start);
  if (start < 0 || end < 0) return null;
  const parser = new SaxesParser();
  const groups: Array<DockTab[]> = [];
  const stack: DockTab[][] = [];
  parser.on("opentag", ({ name, attributes }) => {
    if (name !== "node" && name !== "hierarchy") throw new Error("Unexpected UI dump node");
    const label = attributes["content-desc"];
    if (
      attributes.package === packageName &&
      isDockTab(label) &&
      attributes.clickable === "true" &&
      attributes.enabled === "true"
    ) {
      const bounds = /^\[(\d{1,5}),(\d{1,5})\]\[(\d{1,5}),(\d{1,5})\]$/u.exec(
        attributes.bounds ?? "",
      );
      if (bounds) {
        const [left, top, right, bottom] = bounds.slice(1).map(Number);
        if (left! < right! && top! < bottom!) {
          stack.at(-1)?.push({
            name: label,
            selected: attributes.selected === "true",
            x: Math.floor((left! + right!) / 2),
            y: Math.floor((top! + bottom!) / 2),
          });
        }
      }
    }
    stack.push([]);
  });
  parser.on("closetag", () => {
    const group = stack.pop();
    if (
      group &&
      group.length >= 2 &&
      new Set(group.map((tab) => tab.name)).size === group.length &&
      group.some((tab) => tab.name === "设置") &&
      group.filter((tab) => tab.selected).length === 1 &&
      group.every((tab) => Math.abs(tab.y - group[0]!.y) <= 2) &&
      new Set(group.map((tab) => tab.x)).size === group.length
    )
      groups.push(group.sort((a, b) => a.x - b.x));
  });
  try {
    parser.write(xml.slice(start, end + closing.length)).close();
    return groups.length === 1 ? groups[0]! : null;
  } catch {
    return null;
  }
}

export const androidT3Dock = Effect.fn("AndroidT3Dock")(function* (input: {
  readonly run: DeviceHostReady["run"];
  readonly hostId: DeviceHostId;
  readonly serial: string;
  readonly selection?: AndroidT3DockTab;
  readonly canStart: () => boolean;
  readonly stillOpen?: Effect.Effect<boolean>;
}) {
  const failure = (reason: string) =>
    new DeviceHostUnavailableError({ hostId: input.hostId, reason });
  const command = (args: readonly string[]) =>
    input.run("adb", ["-s", input.serial, "shell", ...args], {
      timeoutMs: 5_000,
      maxOutputBytes: 2 * 1024 * 1024,
    });
  const checkForeground = Effect.gen(function* () {
    const status = yield* readAndroidPhysicalDeviceStatus(input.run, input.serial);
    if (status.connection !== "connected" || status.screen !== "unlocked") {
      return yield* failure("请检查真机连接并在手机上解锁屏幕。");
    }
    const windows = yield* command(["dumpsys", "window"]);
    if (windows.code !== 0 || !packageFocus.test(windows.stdout)) {
      return yield* failure("请把 T3 Code 切到手机前台。");
    }
  });
  const read = Effect.gen(function* () {
    yield* checkForeground;
    const result = yield* command(["uiautomator", "dump", "/dev/tty"]);
    const tabs = result.code === 0 ? dockTabs(result.stdout) : null;
    if (!tabs) return yield* failure("未找到可识别的 T3 Dock，请回到 T3 的底部标签界面。");
    yield* checkForeground;
    return tabs;
  });

  let tabs = yield* read;
  let current = tabs.find((tab) => tab.selected)!;
  if (input.selection !== undefined && current.name !== input.selection) {
    const target = tabs.find((tab) => tab.name === input.selection);
    if (!target) return yield* failure("所选标签当前没有显示在 T3 Dock。");
    if (!(yield* input.stillOpen ?? Effect.succeed(true)) || !input.canStart())
      return yield* failure("用户已接手，Dock 切换已暂停。");
    const tapped = yield* command(["input", "tap", String(target.x), String(target.y)]);
    if (tapped.code !== 0) return yield* failure("T3 Dock 未接收到标签点击。");
    tabs = yield* read;
    current = tabs.find((tab) => tab.selected)!;
    if (current.name !== input.selection) {
      return yield* failure("界面未确认切换到指定标签。");
    }
  }
  return { tabs: tabs.map((tab) => tab.name), selected: current.name };
});
