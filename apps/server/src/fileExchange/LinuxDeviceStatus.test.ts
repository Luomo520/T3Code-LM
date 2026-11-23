// @effect-diagnostics nodeBuiltinImport:off - 测试用替身验证传给 OpenSSH 的参数。
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";
import * as FileExchange from "./FileExchange.ts";
import { inspectLinuxDevice, type LinuxDeviceCheck } from "./LinuxDeviceStatus.ts";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const execFile = vi.mocked(NodeChildProcess.execFile);

describe("Linux device status", () => {
  it.each([
    [
      "system_version",
      "/bin/uname -sr",
      "Linux 6.12.59+deb13-amd64\n",
      { kernelVersion: "Linux 6.12.59+deb13-amd64" },
    ],
    [
      "available_space",
      "/bin/df -Pk /",
      "Filesystem 1024-blocks Used Available Capacity Mounted on\nmy disk 100 32 68 32% /\n",
      { availableBytes: 69_632 },
    ],
    ["uptime", "/bin/cat /proc/uptime", "961.39 9434.13\n", { uptimeSeconds: 961 }],
  ] as const)(
    "executes the fixed %s command over verified SSH",
    async (check, command, output, expected) => {
      execFile.mockReset();
      execFile.mockImplementationOnce((_file, _args, _options, callback) => {
        callback?.(null, output, "");
        return {} as ReturnType<typeof execFile>;
      });
      const signal = new AbortController().signal;

      await expect(inspectLinuxDevice("linux-diagnostics", check, signal)).resolves.toEqual({
        check,
        ...expected,
      });

      expect(execFile).toHaveBeenCalledOnce();
      expect(execFile).toHaveBeenCalledWith(
        "ssh",
        expect.arrayContaining([
          "-n",
          "BatchMode=yes",
          "StrictHostKeyChecking=yes",
          "ControlPath=none",
        ]),
        { signal, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 8192, encoding: "utf8" },
        expect.any(Function),
      );
      expect(execFile.mock.calls[0]?.[1]?.slice(-3)).toEqual(["--", "linux-diagnostics", command]);
    },
  );

  it("rejects unknown checks before spawning SSH", async () => {
    execFile.mockReset();
    const signal = new AbortController().signal;
    await expect(
      inspectLinuxDevice("linux-diagnostics", "toString" as LinuxDeviceCheck, signal),
    ).rejects.toThrow("valid Linux status");
    expect(execFile).not.toHaveBeenCalled();
  });

  it.each([
    ["system_version", "Linux 6.12.59\nUnexpected banner"],
    ["available_space", "disk 99999999999999 1000 99999999998999 1% /"],
    ["uptime", "15.3"],
  ] as const)("rejects invalid %s output", async (check, output) => {
    execFile.mockReset();
    execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback?.(null, output, "");
      return {} as ReturnType<typeof execFile>;
    });

    await expect(
      inspectLinuxDevice("linux-diagnostics", check, new AbortController().signal),
    ).rejects.toThrow("valid Linux status");
  });

  it.effect("serializes diagnostics and SFTP across workspaces while another device runs", () => {
    execFile.mockReset();
    const target = {
      deviceId: "linux-1",
      workspaceRoot: "/work/main",
      localDirectory: "incoming",
      remoteDirectory: "/incoming",
      sshAlias: "linux-files",
      diagnosticsSshAlias: "linux-diagnostics",
    };
    const anotherWorkspace = { ...target, workspaceRoot: "/work/second" };
    const secondDevice = {
      ...target,
      deviceId: "linux-2",
      diagnosticsSshAlias: "another-diagnostic",
    };
    const pending = new Map<string, () => void>();
    execFile.mockImplementation((_file, args, options, callback) => {
      const complete = () => callback?.(null, "120.5 6000.33\n", "");
      pending.set(String(args?.at(-2)), complete);
      const signal = (options as { signal: AbortSignal }).signal;
      signal.addEventListener("abort", complete, { once: true });
      return {} as ReturnType<typeof execFile>;
    });

    return Effect.gen(function* () {
      const exchange = yield* FileExchange.FileExchange;
      expect(
        yield* Effect.flip(
          exchange.inspect({
            deviceId: target.deviceId,
            workspaceRoot: "/work/other",
            check: "uptime",
          }),
        ),
      ).toMatchObject({ message: expect.stringContaining("for the calling workspace") });
      expect(execFile).not.toHaveBeenCalled();

      const first = yield* exchange
        .inspect({ ...target, check: "uptime" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      const second = yield* exchange
        .transfer(
          { ...anotherWorkspace, direction: "send", localName: "notes.txt" },
          Effect.fail("calling thread lost access"),
        )
        .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
      const independent = yield* exchange
        .inspect({ ...secondDevice, check: "uptime" })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      expect([...pending.keys()]).toEqual(["linux-diagnostics", "another-diagnostic"]);
      expect(yield* exchange.listDevices).toMatchObject([
        {
          deviceId: target.deviceId,
          sftpAliases: [target.sshAlias],
          waiting: 1,
          active: "ssh-diagnostics",
        },
        { deviceId: secondDevice.deviceId, waiting: 0, active: "ssh-diagnostics" },
      ]);
      pending.get("another-diagnostic")?.();
      const expected = { check: "uptime", uptimeSeconds: 120 };
      expect(yield* Fiber.join(independent)).toEqual(expected);
      pending.get("linux-diagnostics")?.();
      expect(yield* Fiber.join(first)).toEqual(expected);
      expect(yield* Fiber.join(second)).toBe("calling thread lost access");
      expect(yield* exchange.listDevices).toMatchObject([
        {
          deviceId: target.deviceId,
          waiting: 0,
          active: null,
          lastDiagnostic: { result: expected },
        },
        {
          deviceId: secondDevice.deviceId,
          waiting: 0,
          active: null,
          lastDiagnostic: { result: expected },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        FileExchange.layerForSftpTest(
          [target, anotherWorkspace, secondDevice],
          "unused-sftp-server",
        ),
      ),
    );
  });
});
