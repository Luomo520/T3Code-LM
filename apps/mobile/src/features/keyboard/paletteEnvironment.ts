import type { EnvironmentId } from "@t3tools/contracts";

// null 表示搜索所有在线后端；从原消息返回时要保留这个选择。
export function resolvePaletteEnvironment(scope: {
  restored?: EnvironmentId | null | undefined;
  thread?: EnvironmentId | undefined;
  draft: EnvironmentId | null;
  home: EnvironmentId | null;
}): EnvironmentId | null {
  return scope.restored !== undefined
    ? scope.restored
    : (scope.thread ?? scope.draft ?? scope.home);
}

export function paletteTargets(
  connected: readonly EnvironmentId[],
  selected: EnvironmentId | null,
) {
  return selected === null ? connected : connected.filter((id) => id === selected);
}
