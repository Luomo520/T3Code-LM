import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
  formatProviderMaintenanceMessage,
  type ProviderUpdateCandidate,
} from "./providerUpdates.ts";

const candidate: ProviderUpdateCandidate = {
  driver: ProviderDriverKind.make("claudeAgent"),
  instanceId: ProviderInstanceId.make("claude"),
  installed: true,
  enabled: true,
  version: "2.0.0",
  status: "ready",
  checkedAt: "2026-11-22T00:00:00Z",
  auth: { status: "authenticated" },
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "2.0.0",
    latestVersion: "2.0.1",
    canUpdate: true,
    updateCommand: "claude update",
    checkedAt: "2026-11-22T00:00:00Z",
    message: null,
  },
};

describe("shared provider update selection", () => {
  it("blocks the merged action while a sibling installation is updating, without blocking another CLI", () => {
    const working: ServerProvider = {
      ...candidate,
      instanceId: ProviderInstanceId.make("claude-work"),
      updateState: {
        status: "running",
        startedAt: candidate.checkedAt,
        finishedAt: null,
        message: null,
        output: null,
      },
    };
    const codex = {
      ...candidate,
      driver: ProviderDriverKind.make("codex"),
      instanceId: ProviderInstanceId.make("codex"),
    };
    const all = [candidate, working, codex];
    expect(collectProviderUpdateCandidates(all)).toHaveLength(2);
    expect(canOneClickUpdateProviderCandidate(candidate, all)).toBe(false);
    expect(canOneClickUpdateProviderCandidate(codex, all)).toBe(true);
  });

  it("localizes the application status and retains external output verbatim", () => {
    expect(formatProviderMaintenanceMessage("Verifying the installed version")).toBe(
      "正在核对已安装的版本",
    );
    expect(
      formatProviderMaintenanceMessage("Update command exited with code 13: npm ERR! EACCES"),
    ).toBe("更新命令退出，代码 13：npm ERR! EACCES");
    expect(formatProviderMaintenanceMessage("npm ERR!  EACCES")).toBe("npm ERR!  EACCES");
  });
});
