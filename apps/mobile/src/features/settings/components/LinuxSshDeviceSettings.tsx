import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { AuthAccessReadScope, type EnvironmentId, type LinuxSshDevice } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useCallback } from "react";
import { AppState } from "react-native";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { formatBytes } from "../../../lib/formatBytes";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { linuxSshDevices } from "../linuxSshDeviceQuery";
import { SettingsSection } from "./SettingsSection";

export function LinuxSshDeviceSettings({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const available =
    connected && canRead && config?.environment.capabilities?.linuxSshDevices === true;
  const devices = useEnvironmentQuery(
    available ? linuxSshDevices({ environmentId, input: null }) : null,
  );
  const refresh = devices.refresh;
  useFocusEffect(
    useCallback(() => {
      if (!available) return;
      const timer = setInterval(() => {
        if (AppState.currentState === "active") refresh();
      }, 10_000);
      return () => clearInterval(timer);
    }, [available, refresh]),
  );

  if (!available) return null;
  return (
    <SettingsSection title="Linux SSH 设备">
      {devices.error ? (
        <ListRowLayout label="无法读取已配置的 Linux 设备。" />
      ) : devices.data === null ? (
        <ListRowLayout label="正在读取 Linux 设备…" />
      ) : devices.data.devices.length === 0 ? (
        <ListRowLayout label="未配置 Linux SSH 设备" />
      ) : (
        devices.data.devices.map((device) => (
          <ListRowLayout
            key={device.deviceId}
            icon="desktopcomputer"
            label={device.deviceId}
            description={describeDevice(device)}
          />
        ))
      )}
      <ListActionRow
        icon="arrow.clockwise"
        label={devices.error ? "重试" : "刷新 Linux 设备"}
        loading={devices.isPending}
        onPress={refresh}
      />
    </SettingsSection>
  );
}

function describeDevice(device: LinuxSshDevice) {
  const actions = {
    "sftp-send": "正在发送文件",
    "sftp-receive": "正在接收文件",
    "ssh-diagnostics": "正在读取 Linux 诊断",
  };
  const recent = device.lastDiagnostic;
  const result = recent?.result;
  const status =
    result?.check === "system_version"
      ? result.kernelVersion
      : result?.check === "available_space"
        ? `可用空间 ${formatBytes(result.availableBytes)}`
        : result?.check === "uptime"
          ? `已运行 ${formatDuration(result.uptimeSeconds * 1_000)}`
          : undefined;
  return [
    `${device.active === null ? "没有运行中的操作" : actions[device.active]} · 等待 ${device.waiting} 项`,
    `SFTP 收发 · ${device.sftpAliases.join(", ")}`,
    `SSH 诊断 · ${device.diagnosticAliases.join(", ") || "未配置诊断别名"}`,
    "主机身份 · OpenSSH known_hosts",
    ...(recent && status
      ? [`最近诊断 · ${status} · ${new Date(recent.checkedAt).toLocaleString()}`]
      : []),
  ].join("\n");
}
