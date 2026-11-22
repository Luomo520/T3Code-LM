// @effect-diagnostics nodeBuiltinImport:off - 用 OpenSSH 子进程执行约定的设备诊断。
import * as NodeChildProcess from "node:child_process";
import { sshConnectionArgs } from "./sshConnection.ts";

export const linuxDeviceChecks = ["system_version", "available_space", "uptime"] as const;
export type LinuxDeviceCheck = (typeof linuxDeviceChecks)[number];

const commands = {
  system_version: "/bin/uname -sr",
  available_space: "/bin/df -Pk /",
  uptime: "/bin/cat /proc/uptime",
} satisfies Record<LinuxDeviceCheck, string>;

function invalidStatus() {
  return new Error("The SSH diagnostic did not return a valid Linux status.");
}

export async function inspectLinuxDevice(
  alias: string,
  check: LinuxDeviceCheck,
  signal: AbortSignal,
) {
  if (!Object.hasOwn(commands, check)) throw invalidStatus();

  // 远程命令只从固定表中选择，设备别名独立传给 OpenSSH。
  const stdout = await new Promise<string>((resolve, reject) =>
    NodeChildProcess.execFile(
      "ssh",
      ["-n", ...sshConnectionArgs(alias), commands[check]],
      {
        signal,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );
  const output = stdout.trim();

  switch (check) {
    case "system_version": {
      if (!/^Linux [A-Za-z0-9][A-Za-z0-9._+~:-]{0,126}$/.test(output)) {
        throw invalidStatus();
      }
      return { check, kernelVersion: output } as const;
    }
    case "available_space": {
      // POSIX 格式的容量字段位于行尾，文件系统名称可以包含空白。
      const filesystem = output.split("\n").at(-1);
      const availableBlocks = filesystem?.match(/\s\d+\s+\d+\s+(\d+)\s+\d+%\s+\/$/)?.[1];
      const availableBytes = Number(availableBlocks) * 1024;
      if (!Number.isSafeInteger(availableBytes)) throw invalidStatus();
      return { check, availableBytes } as const;
    }
    case "uptime": {
      const wholeSeconds = output.match(/^(\d+)(?:\.\d+)?\s+\d+(?:\.\d+)?$/)?.[1];
      const uptimeSeconds = Number(wholeSeconds);
      if (!Number.isSafeInteger(uptimeSeconds)) throw invalidStatus();
      return { check, uptimeSeconds } as const;
    }
  }
}
