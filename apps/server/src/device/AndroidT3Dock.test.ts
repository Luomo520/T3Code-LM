import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { androidT3Dock } from "./AndroidT3Dock.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

type FixtureOptions = {
  readonly locked?: boolean;
  readonly otherApp?: boolean;
  readonly canStart?: boolean;
  readonly lostFocus?: boolean;
  readonly haveAmbiguousDock?: boolean;
};
const installedPackage = "com.t3tools.t3code.zh";

function fixture(options: FixtureOptions = {}) {
  let selected = "会话";
  let queries = 0;
  const calls: string[][] = [];
  const run: DeviceHostReady["run"] = (_tool, args) =>
    Effect.sync(() => {
      const command = args.slice(3);
      calls.push([...command]);
      let stdout = "";
      if (command.join(" ") === "dumpsys window policy") {
        stdout = `KeyguardServiceDelegate
        showing=${options.locked === true}
        inputRestricted=${options.locked === true}
        screenState=SCREEN_STATE_ON
      `;
      } else if (command.join(" ") === "dumpsys window") {
        queries++;
        const focused =
          options.otherApp || (options.lostFocus && queries > 1)
            ? "example.other"
            : installedPackage;
        stdout = `mCurrentFocus=Window{deadbeef u0 ${focused}/.MainActivity}`;
      } else if (command.join(" ") === "uiautomator dump /dev/tty") {
        const tabs = ["会话", "用量", "设置"]
          .map(
            (label, i) =>
              `<node package="${installedPackage}" content-desc="${label}" clickable="true" enabled="true" selected="${label === selected}" bounds="[${i * 50},900][${(i + 1) * 50},950]"/>`,
          )
          .join("");
        stdout = `<hierarchy><node>${tabs}</node>${options.haveAmbiguousDock ? `<node>${tabs}</node>` : ""}</hierarchy>\nUI hierchary dumped to: /dev/tty`;
      } else if (command.join(" ") === "input tap 75 925") {
        selected = "用量";
      } else {
        return { code: 1, stdout: "", stderr: "unexpected test command" };
      }
      return { code: 0, stdout, stderr: "" };
    });
  return {
    calls,
    input: {
      hostId: "local",
      serial: "usb-test",
      run,
      canStart: () => options.canStart ?? true,
    },
  };
}

it.effect("only returns the visible Dock labels and verifies a requested selection", () =>
  Effect.gen(function* () {
    const { input, calls } = fixture();
    expect(yield* androidT3Dock(input)).toEqual({
      tabs: ["会话", "用量", "设置"],
      selected: "会话",
    });
    expect(calls.some(([command]) => command === "input")).toBe(false);
    expect(yield* androidT3Dock({ ...input, selection: "用量" })).toEqual({
      tabs: ["会话", "用量", "设置"],
      selected: "用量",
    });
    expect(calls.filter(([command]) => command === "input")).toEqual([
      ["input", "tap", "75", "925"],
    ]);
    yield* androidT3Dock({ ...input, selection: "用量" });
    expect(calls.filter(([command]) => command === "input")).toHaveLength(1);
  }),
);

it.effect.each([
  { locked: true },
  { otherApp: true },
  { lostFocus: true },
  { canStart: false },
  { haveAmbiguousDock: true },
] as const)("blocks a Dock tap when the current screen or ownership is unclear %j", (options) =>
  Effect.gen(function* () {
    const { input, calls } = fixture(options);
    const result = yield* Effect.result(androidT3Dock({ ...input, selection: "用量" }));
    expect(result._tag).toBe("Failure");
    expect(calls.some(([command]) => command === "input")).toBe(false);
  }),
);
