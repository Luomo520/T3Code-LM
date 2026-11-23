import type { EnvironmentId } from "@t3tools/contracts";

import type { Preferences } from "../../persistence/mobile-preferences";

export function automaticFileHandoffEnabled(
  preferences: Preferences,
  environmentId: EnvironmentId,
): boolean {
  return !preferences.automaticFileHandoffDisabledEnvironments?.includes(environmentId);
}

export function automaticFileHandoffPreferencePatch(
  preferences: Preferences,
  environmentId: EnvironmentId,
  enabled: boolean,
): Partial<Preferences> {
  const disabled = preferences.automaticFileHandoffDisabledEnvironments ?? [];
  return {
    automaticFileHandoffDisabledEnvironments: enabled
      ? disabled.filter((id) => id !== environmentId)
      : [...new Set([...disabled, environmentId])],
  };
}
