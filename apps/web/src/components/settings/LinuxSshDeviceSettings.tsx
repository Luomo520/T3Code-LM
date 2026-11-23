import { AuthAccessReadScope, type EnvironmentId, type LinuxSshDevice } from "@t3tools/contracts";
import { executeConnectedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/environmentHttpAuth";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useGT, useLocale } from "gt-react";
import { connectionAtomRuntime } from "~/connection/runtime";
import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { formatBytes } from "~/lib/formatBytes";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const linuxDevices = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "linux-devices:list",
  execute: (_input: undefined) =>
    executeConnectedEnvironmentHttpRequest({
      group: "linuxDevices",
      method: "GET",
      url: (urls) => urls.list(),
      timeoutMs: 8_000,
      request: ({ client, headers }) => client.list({ headers }),
    }),
});

export function LinuxSshDeviceSettings() {
  const { scope, environments, connectedEnvironments } = useSettingsScope();
  const environment =
    (scope.kind === "environment" || scope.kind === "all") && environments.length === 1
      ? connectedEnvironments[0]
      : undefined;
  const allowed = useEnvironmentScope(environment?.environmentId ?? null, AuthAccessReadScope);
  if (!allowed || environment?.serverConfig?.environment.capabilities.linuxSshDevices !== true) {
    return null;
  }
  return (
    <LinuxSshDeviceList key={environment.environmentId} environmentId={environment.environmentId} />
  );
}

function LinuxSshDeviceList({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const devices = useEnvironmentQuery(linuxDevices({ environmentId, input: undefined }));
  useLiveRefresh(
    () => {
      if (!devices.isPending) devices.refresh();
    },
    { key: `linux-devices:${environmentId}`, intervalMs: 10_000 },
  );

  return (
    <SettingsSection id="linux-ssh-devices" title={gt("Linux SSH devices")}>
      {devices.error ? (
        <SettingsRow
          title={gt("Could not read configured Linux devices")}
          control={
            <Button variant="outline" size="sm" onClick={devices.refresh}>
              {gt("Retry")}
            </Button>
          }
        />
      ) : devices.data === null ? (
        <SettingsRow title={gt("Loading Linux devices…")} role="status" />
      ) : devices.data.devices.length === 0 ? (
        <SettingsRow title={gt("No Linux SSH devices configured")} />
      ) : (
        devices.data.devices.map((device) => (
          <LinuxSshDeviceRow key={device.deviceId} device={device} />
        ))
      )}
    </SettingsSection>
  );
}

function LinuxSshDeviceRow({ device }: { readonly device: LinuxSshDevice }) {
  const gt = useGT();
  const locale = useLocale();
  const actions = {
    "sftp-send": gt("Sending a file"),
    "sftp-receive": gt("Receiving a file"),
    "ssh-diagnostics": gt("Reading Linux diagnostics"),
  };
  const recent = device.lastDiagnostic;
  const result = recent?.result;
  const status =
    result?.check === "system_version"
      ? result.kernelVersion
      : result?.check === "available_space"
        ? gt("Available space {size}", { size: formatBytes(result.availableBytes) })
        : result?.check === "uptime"
          ? gt("Uptime {duration}", { duration: formatDuration(result.uptimeSeconds * 1_000) })
          : undefined;
  return (
    <SettingsRow
      title={<span className="break-words">{device.deviceId}</span>}
      description={device.active === null ? gt("No operation running") : actions[device.active]}
      status={gt("Waiting operations {count}", { count: device.waiting })}
    >
      <dl className="grid gap-x-3 gap-y-1 pt-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt>{gt("Send and receive files over SFTP")}</dt>
        <dd className="break-words text-muted-foreground">{device.sftpAliases.join(", ")}</dd>
        <dt>{gt("SSH diagnostics")}</dt>
        <dd className="break-words text-muted-foreground">
          {device.diagnosticAliases.join(", ") || gt("No diagnostic SSH alias configured")}
        </dd>
        <dt>{gt("Host verification")}</dt>
        <dd className="text-muted-foreground">{gt("OpenSSH known_hosts")}</dd>
        {recent && status ? (
          <>
            <dt>{gt("Latest diagnostic")}</dt>
            <dd className="break-words text-muted-foreground">
              {status} · {new Date(recent.checkedAt).toLocaleString(locale)}
            </dd>
          </>
        ) : null}
      </dl>
    </SettingsRow>
  );
}
