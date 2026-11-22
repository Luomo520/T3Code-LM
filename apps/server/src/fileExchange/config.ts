import * as HostProcess from "@t3tools/shared/HostProcess";

export const FILE_EXCHANGE_TARGETS_ENV = "T3CODE_FILE_EXCHANGE_TARGETS";
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const sha256Pattern = /^[a-f0-9]{64}$/i;
const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isExchangeName(value: unknown): value is string {
  // 保留点开头的名字供暂存文件使用，文件名只占据一层目录。
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 255 &&
    value.trim() === value &&
    !value.startsWith(".") &&
    !/[/\\]/.test(value) &&
    [...value].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 && !(code >= 0xd800 && code <= 0xdfff);
    })
  );
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && !part.includes("\0"))
  );
}

export interface ExchangeTarget {
  readonly deviceId: string;
  readonly sshAlias: string;
  readonly workspaceRoot: string;
  readonly localDirectory: string;
  readonly remoteDirectory: string;
  readonly diagnosticsSshAlias?: string;
}

export function readTargets(
  raw = process.env[FILE_EXCHANGE_TARGETS_ENV],
): ReadonlyArray<ExchangeTarget> {
  if (HostProcess.Platform.defaultValue() !== "linux" || !raw) return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const targets: Array<ExchangeTarget> = [];
    for (const value of values as ReadonlyArray<Partial<ExchangeTarget> | null>) {
      if (
        typeof value?.deviceId !== "string" ||
        !aliasPattern.test(value.deviceId) ||
        typeof value.sshAlias !== "string" ||
        !aliasPattern.test(value.sshAlias) ||
        (value.diagnosticsSshAlias !== undefined &&
          (typeof value.diagnosticsSshAlias !== "string" ||
            !aliasPattern.test(value.diagnosticsSshAlias) ||
            value.diagnosticsSshAlias === value.sshAlias)) ||
        !isCanonicalAbsolutePath(value.workspaceRoot) ||
        !isExchangeName(value.localDirectory) ||
        !isCanonicalAbsolutePath(value.remoteDirectory) ||
        targets.some(
          (target) =>
            target.deviceId === value.deviceId && target.workspaceRoot === value.workspaceRoot,
        )
      ) {
        return [];
      }
      targets.push({
        deviceId: value.deviceId,
        sshAlias: value.sshAlias,
        workspaceRoot: value.workspaceRoot,
        localDirectory: value.localDirectory,
        remoteDirectory: value.remoteDirectory,
        ...(value.diagnosticsSshAlias === undefined
          ? {}
          : { diagnosticsSshAlias: value.diagnosticsSshAlias }),
      });
    }
    return targets;
  } catch {
    return [];
  }
}

export function listConfiguredDevices() {
  return [...new Set(readTargets().map(({ deviceId }) => deviceId))].map((deviceId) => ({
    deviceId,
  }));
}
