import {
  defaultInstanceIdForDriver,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

// 同一环境内的多个实例可能共用一个 CLI；快捷更新只展示一项，并校验安装命令是否一致。
export type ProviderUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly status: "behind_latest";
    readonly latestVersion: string;
  };
};

export type ProviderSettingsUpdateCandidate = ServerProvider & {
  readonly versionAdvisory: NonNullable<ServerProvider["versionAdvisory"]> & {
    readonly canUpdate: true;
    readonly updateCommand: string;
  };
};

function chooseRepresentativeProvider<T extends ServerProvider>(
  current: T | undefined,
  candidate: T,
): T {
  if (!current) {
    return candidate;
  }
  const defaultInstanceId = defaultInstanceIdForDriver(candidate.driver);
  if (candidate.instanceId === defaultInstanceId) {
    return candidate;
  }
  if (current.instanceId === defaultInstanceId) {
    return current;
  }
  return candidate.checkedAt.localeCompare(current.checkedAt) >= 0 ? candidate : current;
}

export function dedupeProvidersByDriver<T extends ServerProvider>(
  providers: ReadonlyArray<T>,
): T[] {
  const latestProviderByDriver = new Map<ProviderDriverKind, T>();

  for (const provider of providers) {
    latestProviderByDriver.set(
      provider.driver,
      chooseRepresentativeProvider(latestProviderByDriver.get(provider.driver), provider),
    );
  }

  return [...latestProviderByDriver.values()];
}

export function isProviderUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderUpdateCandidate {
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.latestVersion !== null
  );
}

export function isProviderUpdateActive(provider: Pick<ServerProvider, "updateState">): boolean {
  return provider.updateState?.status === "queued" || provider.updateState?.status === "running";
}

export function collectProviderUpdateCandidates(
  providers: ReadonlyArray<ServerProvider>,
): ProviderUpdateCandidate[] {
  return dedupeProvidersByDriver(providers.filter(isProviderUpdateCandidate));
}

export function isProviderSettingsUpdateCandidate(
  provider: ServerProvider,
): provider is ProviderSettingsUpdateCandidate {
  return (
    provider.enabled &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "broken" &&
    provider.compatibilityAdvisory?.latestVersionStatus !== "unsupported" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate === true &&
    provider.versionAdvisory.updateCommand !== null
  );
}

export function hasOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  if (
    candidate.versionAdvisory.canUpdate !== true ||
    candidate.versionAdvisory.updateCommand === null
  ) {
    return false;
  }

  const driverProviders = providers.filter((provider) => provider.driver === candidate.driver);
  if (driverProviders.length === 0) {
    return false;
  }

  const updateCommands = new Set<string>();
  for (const provider of driverProviders) {
    if (!isProviderUpdateCandidate(provider)) {
      continue;
    }
    const advisory = provider.versionAdvisory;
    if (!advisory || advisory.canUpdate !== true || advisory.updateCommand === null) {
      return false;
    }
    updateCommands.add(advisory.updateCommand);
  }

  return updateCommands.size === 1;
}

export function canOneClickUpdateProviderCandidate(
  candidate: ProviderUpdateCandidate,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  return (
    !providers.some(
      (provider) => provider.driver === candidate.driver && isProviderUpdateActive(provider),
    ) && hasOneClickUpdateProviderCandidate(candidate, providers)
  );
}

const maintenanceMessages = new Map<string, string>([
  ["Waiting for another provider update to finish.", "正在等待上一项更新完成"],
  ["Checking for the latest version", "正在检查最新版本"],
  ["Waiting for running provider work to finish.", "正在等待使用此 CLI 的任务完成"],
  ["Verifying the installed version", "正在核对已安装的版本"],
  ["Already up to date.", "已是最新版本"],
  ["Provider updated.", "更新完成"],
  ["Update stopped before it finished.", "更新已中断"],
  ["Update command failed.", "更新命令执行失败"],
  ["Update command failed to run.", "无法运行更新命令"],
  ["This provider does not support one-click updates.", "此 CLI 需手动更新"],
  ["An update is already running for this provider.", "此 CLI 正在更新"],
  ["Provider installation changed. Refresh and try again.", "安装位置已变更，请刷新后重试"],
  [
    "Update command completed, but T3 Code could not verify the provider version.",
    "更新命令已完成，暂时无法核实已安装的版本",
  ],
  [
    "Update command completed, but T3 Code still detects an outdated provider version.",
    "更新命令已完成，重新检测时仍为旧版本",
  ],
  [
    "OpenCode CLI updated. Restart the configured local OpenCode server to use the new version.",
    "OpenCode CLI 已更新。请重启已配置的本地 OpenCode 服务端以使用新版本。",
  ],
  [
    "The latest provider version is incompatible with this T3 Code release. Review provider settings.",
    "最新版 CLI 与当前 T3 Code 不兼容，请查看供应商设置",
  ],
  [
    "This version is no longer recommended or this installer cannot install a specific version. Refresh provider settings.",
    "目标版本已不再推荐，或安装器无法指定版本。请刷新供应商设置。",
  ],
]);

// 旧服务端发送英文状态与原始命令输出；只转换可识别的应用提示，错误细节原样保留。
export function formatProviderMaintenanceMessage(message: string): string {
  return (
    maintenanceMessages.get(message) ??
    message
      .replace(/^Update timed out after (\d+) minutes\.$/, "更新超时（$1 分钟）")
      .replace(/^Update command exited with code (-?\d+)\.$/, "更新命令退出，代码 $1")
      .replace(/^Update command exited with code (-?\d+): /, "更新命令退出，代码 $1：")
      .replace(/^Update command failed: /, "更新命令执行失败：")
      .replace(/^Failed to run update command (.+?): /, "无法运行更新命令 $1：")
  );
}
