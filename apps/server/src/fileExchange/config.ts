import * as HostProcess from "@t3tools/shared/HostProcess";
import { normalizeProjectPathForDispatch } from "@t3tools/shared/path";

export const FILE_EXCHANGE_TARGETS_ENV = "T3CODE_FILE_EXCHANGE_TARGETS";
export const MAX_FILE_BYTES = 1024 * 1024 * 1024;
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

function isWindowsComponent(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[<>:"/\\|?*\x00-\x1f]/u.test(value) &&
    !/[ .]$/u.test(value) &&
    !/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/iu.test(value)
  );
}

export function isWindowsExchangeName(value: unknown): value is string {
  return isExchangeName(value) && isWindowsComponent(value);
}

export function isWindowsWorkspaceRoot(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-z]:[/\\]/iu.test(value)) return false;
  const parts = value.slice(3).split(/[/\\]/u);
  return value.length === 3 || parts.every(isWindowsComponent);
}

export function exchangeWorkspaceKey(value: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return value;
  const path = normalizeProjectPathForDispatch(value).replaceAll("/", "\\");
  // NTFS 可按目录启用区分大小写，目录段按登记的原始拼写匹配。
  return path.slice(0, 1).toUpperCase() + path.slice(1);
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
  platform = HostProcess.Platform.defaultValue(),
): ReadonlyArray<ExchangeTarget> {
  if ((platform !== "linux" && platform !== "win32") || !raw) return [];
  const workspaceKey = (path: string) => exchangeWorkspaceKey(path, platform);
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    const targets: Array<ExchangeTarget> = [];
    for (const value of values as ReadonlyArray<Partial<ExchangeTarget> | null>) {
      const workspaceRoot = value?.workspaceRoot;
      if (
        typeof value?.deviceId !== "string" ||
        !aliasPattern.test(value.deviceId) ||
        typeof value.sshAlias !== "string" ||
        !aliasPattern.test(value.sshAlias) ||
        (value.diagnosticsSshAlias !== undefined &&
          (typeof value.diagnosticsSshAlias !== "string" ||
            !aliasPattern.test(value.diagnosticsSshAlias) ||
            value.diagnosticsSshAlias === value.sshAlias)) ||
        typeof workspaceRoot !== "string" ||
        !isExchangeName(value.localDirectory) ||
        (platform === "win32"
          ? !isWindowsWorkspaceRoot(workspaceRoot) || !isWindowsComponent(value.localDirectory)
          : !isCanonicalAbsolutePath(workspaceRoot)) ||
        !isCanonicalAbsolutePath(value.remoteDirectory) ||
        targets.some(
          (target) =>
            target.deviceId === value.deviceId &&
            workspaceKey(target.workspaceRoot) === workspaceKey(workspaceRoot),
        )
      ) {
        return [];
      }
      targets.push({
        deviceId: value.deviceId,
        sshAlias: value.sshAlias,
        workspaceRoot,
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
