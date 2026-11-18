import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ServerNpmRelease } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";

export const ENVIRONMENT_RELEASES_PAGE_URL = "https://github.com/Luomo520/T3Code-LM/releases";

export function canMaintainEnvironment(session: AuthSessionState | null, connected: boolean) {
  return (
    connected &&
    session?.authenticated === true &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope)
  );
}

export function supportsEnvironmentUpdate(
  capabilities: Pick<ExecutionEnvironmentCapabilities, "serverSelfUpdate" | "desktopAppUpdate">,
) {
  return (
    capabilities.serverSelfUpdate !== undefined &&
    (capabilities.serverSelfUpdate !== "desktop-managed" || capabilities.desktopAppUpdate === true)
  );
}

export function canUpdateEnvironmentProvider(provider: ServerProvider) {
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return (
    provider.installed &&
    provider.availability !== "unavailable" &&
    provider.versionAdvisory?.status === "behind_latest" &&
    provider.versionAdvisory.canUpdate &&
    provider.versionAdvisory.latestVersion !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "running" &&
    provider.updateState?.status !== "queued"
  );
}

export interface EnvironmentReleaseLookup {
  readonly targetVersion: string | null;
  readonly manualCheckRequired: boolean;
}

/** The remote host selects its own platform/architecture from the single fork channel. */
export async function findEnvironmentUpdate(
  currentVersion: string,
  signal: AbortSignal,
  lookupRelease?: (signal: AbortSignal) => Promise<ServerNpmRelease | null>,
): Promise<EnvironmentReleaseLookup> {
  if (!lookupRelease) return { targetVersion: null, manualCheckRequired: true };
  const release = await lookupRelease(signal);
  if (release === null) return { targetVersion: null, manualCheckRequired: false };
  const version = release.version;
  const forkVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-[1-9]\d*$/;
  // An older host's registry lookup is not a fork/platform-aware release answer.
  if (!forkVersion.test(version)) return { targetVersion: null, manualCheckRequired: true };
  const newer = forkVersion.test(currentVersion)
    ? compareSemverVersions(version, currentVersion) > 0
    : version !== currentVersion;
  return { targetVersion: newer ? version : null, manualCheckRequired: false };
}
