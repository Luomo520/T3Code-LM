// @effect-diagnostics nodeBuiltinImport:off -- 核对绑定文件在服务重启后可读。
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { makeAndroidUsbBindings, verifyAndroidUsbBinding } from "./AndroidUsbBinding.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

const phone = "usb-test";
const pc = "desktop";
const app = "phone-app";
const conversation = "thread";
const model = "Test Phone";
const installedPackage = "com.t3tools.t3code.zh";
const proofId = "t3-usb-binding-proof";

it("checks challenge ownership, expiry and single use", async () => {
  const bindings = makeAndroidUsbBindings();
  const old = bindings.start(phone, pc, conversation, 0)!;
  const code = bindings.start(phone, pc, conversation, 1)!;
  expect(bindings.offer(old, app, 1)).toBeNull();
  expect(bindings.offer(code, pc, 1)).toBeNull();
  const proof = bindings.offer(code, app, 1)!;
  expect(bindings.offer(code, app, 2)).toBe(proof);
  expect(bindings.offer(code, "other-app", 2)).toBeNull();
  expect(bindings.proof(code, phone, "other-pc", conversation, 2)).toBeNull();
  expect(bindings.proof(code, "other-usb", pc, conversation, 2)).toBeNull();
  expect(bindings.proof(code, phone, pc, "other-thread", 2)).toBeNull();
  expect(bindings.proof(code, phone, pc, conversation, 120_001)).toBeNull();
  expect(await bindings.finish(code, phone, pc, conversation, "wrong-proof", model, 2)).toBeNull();
  expect(await bindings.finish(code, phone, pc, conversation, proof, model, 2)).toEqual({
    usb: phone,
    app,
    name: model,
  });
  expect(await bindings.finish(code, phone, pc, conversation, proof, model, 2)).toBeNull();
});

it("restores saved identity and removes it from both lookup directions", async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usb-binding-test-"));
  try {
    const path = NodePath.join(dir, "android-usb-bindings.json");
    const bindings = makeAndroidUsbBindings(path);
    const code = bindings.start(phone, pc, conversation, 0)!;
    const proof = bindings.offer(code, app, 0)!;
    const saved = await bindings.finish(code, phone, pc, conversation, proof, model, 0);
    expect(saved).not.toBeNull();
    const restored = makeAndroidUsbBindings(path);
    expect(await restored.byUsb(phone)).toEqual(saved);
    expect(await restored.byApp(app)).toEqual(saved);
    await restored.remove(saved!);
    const afterRemoval = makeAndroidUsbBindings(path);
    expect(await afterRemoval.byUsb(phone)).toBeUndefined();
    expect(await afterRemoval.byApp(app)).toBeUndefined();
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

function fixture({
  usb = true,
  locked = false,
  foreground = installedPackage,
  nodePackage = installedPackage,
  nodeId = proofId,
  nodeProof = "t3-proof",
  lostFocus = false,
  malformed = false,
} = {}) {
  let focusQueries = 0;
  const run: DeviceHostReady["run"] = (_tool, args) =>
    Effect.sync(() => {
      let stdout: string;
      if (args.join(" ") === "devices -l") {
        stdout = `${phone} device ${usb ? "usb:1-1" : "product:phone"}`;
      } else {
        switch (args.slice(3).join(" ")) {
          case "dumpsys window policy":
            stdout = `KeyguardServiceDelegate
              showing=${locked}
              inputRestricted=${locked}
              screenState=SCREEN_STATE_ON`;
            break;
          case "dumpsys window": {
            focusQueries++;
            const packageName = lostFocus && focusQueries > 1 ? "example.other" : foreground;
            stdout = `mCurrentFocus=Window{beef u0 ${packageName}/.MainActivity}`;
            break;
          }
          case "uiautomator dump /dev/tty": {
            const node = `<node package="${nodePackage}" resource-id="${nodeId}" content-desc="${nodeProof}"/>`;
            stdout = `<hierarchy>${node}${malformed ? "<node>" : ""}</hierarchy>`;
            break;
          }
          default:
            return { code: 1, stdout: "", stderr: "Unexpected command." };
        }
      }
      return { code: 0, stdout, stderr: "" };
    });
  return run;
}

it.effect("accepts the proof from the foreground T3 App on the same USB device", () =>
  Effect.gen(function* () {
    expect(yield* verifyAndroidUsbBinding(fixture(), phone, "t3-proof")).toBe(true);
  }),
);

it.effect.each([
  { usb: false },
  { locked: true },
  { foreground: "example.other" },
  { nodePackage: "example.other" },
  { nodeId: "any-node" },
  { nodeProof: "wrong-proof" },
  { lostFocus: true },
  { malformed: true },
] as const)("rejects an invalid USB or foreground proof %j", (options) =>
  Effect.gen(function* () {
    expect(yield* verifyAndroidUsbBinding(fixture(options), phone, "t3-proof")).toBe(false);
  }),
);
