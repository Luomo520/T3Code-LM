// @effect-diagnostics nodeBuiltinImport:off -- 留存双端确认结果和一次性随机证明。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SaxesParser } from "saxes";
import type { DeviceHostReady } from "./DeviceHost.ts";
import { readAndroidPhysicalDeviceStatus } from "./AndroidPhysicalDevice.ts";

const packageName = "com.t3tools.t3code.zh";
const packageFocus = /\bmCurrentFocus=Window\{[^}\r\n]*\bu\d+ com\.t3tools\.t3code\.zh\//u;
const PROOF_NODE = /^(?:com\.t3tools\.t3code\.zh:id\/)?t3-usb-binding-proof$/u;
const TTL = 120_000;
const bindingSchema = Schema.Struct({
  usb: Schema.String,
  app: Schema.String,
  name: Schema.String,
});
type Binding = typeof bindingSchema.Type;
type Challenge = {
  readonly usb: string;
  readonly pc: string;
  readonly thread: string;
  readonly expiresAt: number;
  app?: string;
  proof?: string;
};
const decodeBindings = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(bindingSchema)));

export function makeAndroidUsbBindings(path?: string) {
  const challenges = new Map<string, Challenge>();
  let bindings: ReadonlyArray<Binding> | undefined;
  const load = async () => {
    if (bindings !== undefined) return bindings;
    if (!path) return (bindings = []);
    const content = await NodeFSP.readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    return (bindings = content === null ? [] : decodeBindings(content));
  };
  const save = async (next: ReadonlyArray<Binding>) => {
    if (path) {
      const temporary = NodePath.join(
        NodePath.dirname(path),
        `.usb-bindings-${NodeCrypto.randomUUID()}.tmp`,
      );
      await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true, mode: 0o700 });
      try {
        await NodeFSP.writeFile(temporary, JSON.stringify(next), {
          flag: "wx",
          flush: true,
          mode: 0o600,
        });
        await NodeFSP.rename(temporary, path);
      } finally {
        await NodeFSP.rm(temporary, { force: true });
      }
    }
    bindings = next;
  };
  const alive = (code: string, now: number) => {
    const challenge = challenges.get(code);
    return challenge && challenge.expiresAt > now ? challenge : undefined;
  };
  return {
    start(usb: string, pc: string, thread: string, now: number) {
      for (const [code, item] of challenges) {
        if (item.expiresAt <= now || (item.pc === pc && item.usb === usb)) challenges.delete(code);
      }
      if (challenges.size >= 100) return null;
      const code = NodeCrypto.randomBytes(6).toString("hex");
      challenges.set(code, { usb, pc, thread, expiresAt: now + TTL });
      return code;
    },
    offer(code: string, app: string, now: number) {
      const challenge = alive(code, now);
      if (!challenge || challenge.pc === app || (challenge.app && challenge.app !== app))
        return null;
      challenge.app = app;
      return (challenge.proof ??= `T3-USB-${NodeCrypto.randomBytes(12).toString("hex")}`);
    },
    proof(code: string, usb: string, pc: string, thread: string, now: number) {
      const item = alive(code, now);
      return item?.usb === usb && item.pc === pc && item.thread === thread && item.app && item.proof
        ? { app: item.app, proof: item.proof }
        : null;
    },
    async finish(
      code: string,
      usb: string,
      pc: string,
      thread: string,
      proof: string,
      name: string,
      now: number,
    ) {
      const pending = this.proof(code, usb, pc, thread, now);
      if (!pending || pending.proof !== proof) return null;
      const current = await load();
      if (
        current.some(
          (item) =>
            (item.usb === usb && item.app !== pending.app) ||
            (item.app === pending.app && item.usb !== usb),
        )
      )
        return null;
      const binding = { usb, app: pending.app, name };
      await save([...current.filter((item) => item.usb !== usb), binding]);
      challenges.delete(code);
      return binding;
    },
    async byUsb(usb: string) {
      return (await load()).find((item) => item.usb === usb);
    },
    async byApp(app: string) {
      return (await load()).find((item) => item.app === app);
    },
    async remove(binding: Binding) {
      const current = await load();
      await save(current.filter((item) => item.usb !== binding.usb || item.app !== binding.app));
      for (const [code, item] of challenges) {
        if (item.usb === binding.usb || item.app === binding.app) challenges.delete(code);
      }
    },
  };
}

export const verifyAndroidUsbBinding = Effect.fn("AndroidUsbBinding.verify")(function* (
  run: DeviceHostReady["run"],
  serial: string,
  proof: string,
) {
  if (!/^[a-z0-9._:-]{1,128}$/iu.test(serial)) return false;
  const devices = yield* run("adb", ["devices", "-l"], { timeoutMs: 5_000 });
  if (
    devices.code !== 0 ||
    !devices.stdout.split(/\r?\n/u).some((line) => {
      const [device, status, ...attributes] = line.trim().split(/\s+/u);
      return (
        device === serial &&
        status === "device" &&
        attributes.some((attribute) => attribute.startsWith("usb:"))
      );
    })
  )
    return false;
  const status = yield* readAndroidPhysicalDeviceStatus(run, serial);
  if (status.connection !== "connected" || status.screen !== "unlocked") return false;
  const command = (args: readonly string[]) =>
    run("adb", ["-s", serial, "shell", ...args], {
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
    });
  const focused = yield* command(["dumpsys", "window"]);
  if (focused.code !== 0 || !packageFocus.test(focused.stdout)) return false;
  const tree = yield* command(["uiautomator", "dump", "/dev/tty"]);
  const start = tree.stdout.indexOf("<hierarchy");
  const end = tree.stdout.indexOf("</hierarchy>", start);
  if (tree.code !== 0 || start < 0 || end < 0) return false;
  const parser = new SaxesParser();
  let found = false;
  parser.on("opentag", ({ name, attributes }) => {
    if (
      name === "node" &&
      attributes.package === packageName &&
      PROOF_NODE.test(attributes["resource-id"] ?? "") &&
      attributes["content-desc"] === proof
    )
      found = true;
  });
  const parsed = yield* Effect.try({
    try: () => parser.write(tree.stdout.slice(start, end + "</hierarchy>".length)).close(),
    catch: () => false,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!parsed || !found) return false;
  const after = yield* command(["dumpsys", "window"]);
  return after.code === 0 && packageFocus.test(after.stdout);
});
