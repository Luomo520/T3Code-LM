import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { bindAgentDeviceLauncher } from "./AgentDeviceShim.ts";

it.effect("allows the bound emulator flags and rejects another Android serial", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-device-shim-" });
    const entryPath = path.join(stateDir, "stub.mjs");
    yield* fs.writeFileString(entryPath, "process.stdout.write(process.argv.slice(2).join(' '));");
    const targetArgs = [
      "--platform",
      "android",
      "--serial",
      "emulator-5554",
      "--config",
      path.join(stateDir, "host.json"),
      "--session",
      "preview",
    ];
    const command = yield* bindAgentDeviceLauncher({
      entryPath,
      stateDir,
      session: "preview",
      targetArgs,
    });
    const matching = yield* runner.run({ command, args: ["snapshot", "-d", "5", ...targetArgs] });
    expect(matching.code).toBe(0);
    expect(matching.stdout).toContain("snapshot -d 5 --platform android --serial emulator-5554");
    for (const args of [
      ["--serial", "personal-phone"],
      ["--serial=personal-phone"],
      ["--serial", "emulator-5554", "--serial", "personal-phone"],
      ["--device", "personal-phone"],
    ]) {
      const rejected = yield* runner.run({ command, args: ["snapshot", ...args] });
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toContain("bound to the device and session");
      expect(rejected.stdout).toBe("");
    }
  }).pipe(Effect.scoped, Effect.provide(ProcessRunner.layer), Effect.provide(NodeServices.layer)),
);
