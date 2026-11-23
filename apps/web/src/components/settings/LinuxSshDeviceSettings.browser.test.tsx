import { EnvironmentId, type LinuxSshDevice } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { render } from "../../../test/render";
import { LinuxSshDeviceSettings } from "./LinuxSshDeviceSettings";

const fixture = vi.hoisted(() => ({
  allowed: true,
  devices: [
    {
      deviceId: "study-linux",
      sftpAliases: ["study-sftp"],
      diagnosticAliases: ["study-diagnostics"],
      active: "sftp-receive",
      waiting: 2,
      lastDiagnostic: {
        result: { check: "system_version", kernelVersion: "Linux 6.12.0" },
        checkedAt: "2026-11-23T00:00:00Z",
      },
    },
  ] as readonly LinuxSshDevice[],
}));

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => {
    const environment = {
      environmentId: EnvironmentId.make("linux-settings-test"),
      serverConfig: { environment: { capabilities: { linuxSshDevices: true } } },
    };
    return {
      scope: { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
    };
  }) as never,
}));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => fixture.allowed,
}));

vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: { devices: fixture.devices },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));

it("renders the configured aliases, verified SSH method and pending work only with access", async () => {
  fixture.allowed = false;
  await using screen = await render(<LinuxSshDeviceSettings />);
  expect(screen.getByText("study-linux").query()).toBeNull();
  fixture.allowed = true;
  await screen.rerender(<LinuxSshDeviceSettings />);
  await expect.element(screen.getByText("study-linux")).toBeVisible();
  await expect.element(screen.getByText("study-sftp")).toBeVisible();
  await expect.element(screen.getByText("study-diagnostics")).toBeVisible();
  await expect.element(screen.getByText("OpenSSH known_hosts")).toBeVisible();
  await expect.element(screen.getByText("Receiving a file")).toBeVisible();
  await expect.element(screen.getByText("Waiting operations 2")).toBeVisible();
  await expect.element(screen.getByText(/Linux 6.12.0/)).toBeVisible();
});
