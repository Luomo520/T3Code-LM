import type { AuthSessionId, EnvironmentId } from "@t3tools/contracts";

export type AndroidDirectoryGrant = {
  readonly name: string;
  readonly revision: string;
  readonly sessionId: AuthSessionId;
};

export type AndroidDirectoryRead =
  | { readonly status: "ready"; readonly uri: string }
  | { readonly status: "revoked" | "missing" | "ambiguous" | "too-large" };

export interface AndroidDirectoryModule {
  getGrant(
    environment: EnvironmentId,
    session: AuthSessionId | null,
  ): Promise<AndroidDirectoryGrant | null>;
  chooseGrant(
    environment: EnvironmentId,
    session: AuthSessionId,
    revision: string | null,
  ): Promise<AndroidDirectoryGrant | null>;
  revokeGrant(environment: EnvironmentId): Promise<void>;
  readFile(
    environment: EnvironmentId,
    session: AuthSessionId,
    revision: string,
    name: string,
    maxBytes: number,
  ): Promise<AndroidDirectoryRead>;
}

export const androidDirectory: AndroidDirectoryModule | null = null;
