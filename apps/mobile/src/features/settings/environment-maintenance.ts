import {
  AuthEnvironmentMaintainScope,
  sessionGrantsScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ServerNpmRelease } from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import { resolveForkUpdateTarget } from "@t3tools/shared/forkRelease";

export const ENVIRONMENT_RELEASES_PAGE_URL = CLI_RELEASES_PAGE_URL;

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
  return resolveForkUpdateTarget(currentVersion, release?.version ?? null);
}
