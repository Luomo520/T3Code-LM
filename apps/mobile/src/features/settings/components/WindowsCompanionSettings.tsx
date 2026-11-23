import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  type CompanionDevice,
  isManagedSettingPath,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useCallback, useRef, useState } from "react";
import { AppState } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { environmentConnectedAtom } from "../../../state/use-remote-environment-registry";
import {
  createWindowsCompanionPairing,
  renameWindowsCompanion,
  revokeWindowsCompanion,
  windowsCompanions,
} from "../windowsCompanionCommands";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function WindowsCompanionSettings({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canManageAccess = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const createPairing = useAtomCommand(createWindowsCompanionPairing, {
    reportFailure: false,
    reportDefect: false,
  });
  const renameDevice = useAtomCommand(renameWindowsCompanion, { reportFailure: false });
  const revokeDevice = useAtomCommand(revokeWindowsCompanion, { reportFailure: false });
  const [busy, setBusy] = useState<"setting" | "pairing" | "device" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const enabled = config?.settings.windowsCompanionEnabled;
  const managed = isManagedSettingPath(config?.managedPolicy, "windowsCompanionEnabled");
  const supported = config?.environment.capabilities?.windowsCompanion === true;
  const devices = useEnvironmentQuery(
    connected && supported && canManageAccess
      ? windowsCompanions({ environmentId, input: null })
      : null,
  );
  const refreshDevices = devices.refresh;
  useFocusEffect(
    useCallback(() => {
      if (!connected || !supported || !canManageAccess) return;
      const subscription = AppState.addEventListener("change", (status) => {
        if (status === "active") refreshDevices();
      });
      const timer = setInterval(() => {
        if (AppState.currentState === "active") refreshDevices();
      }, 15_000);
      return () => {
        subscription.remove();
        clearInterval(timer);
      };
    }, [canManageAccess, connected, refreshDevices, supported]),
  );
  if (!connected || config === null) return null;

  const hasLiveManagementAccess = () =>
    appAtomRegistry.get(environmentConnectedAtom(environmentId)) &&
    readEnvironmentScope(environmentId, AuthAccessWriteScope);

  async function changeEnabled(windowsCompanionEnabled: boolean) {
    if (busyRef.current || managed || !canManageAccess || !canWriteSettings) return;
    const current = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (
      !hasLiveManagementAccess() ||
      !readEnvironmentScope(environmentId, AuthSettingsWriteScope) ||
      current?.environment.capabilities?.windowsCompanion !== true ||
      typeof current.settings.windowsCompanionEnabled !== "boolean" ||
      isManagedSettingPath(current?.managedPolicy, "windowsCompanionEnabled")
    ) {
      setError("连接状态或权限已变化，请检查后重试。");
      return;
    }
    busyRef.current = true;
    setBusy("setting");
    setError(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { windowsCompanionEnabled } },
    });
    busyRef.current = false;
    setBusy(null);
    if (result._tag === "Failure") setError("无法保存 Windows 受控端设置，请重试。");
  }

  async function requestPairingCode() {
    if (busyRef.current || !enabled || !canManageAccess) return;
    const current = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
    if (
      !hasLiveManagementAccess() ||
      current?.environment.capabilities?.windowsCompanion !== true ||
      current.settings.windowsCompanionEnabled !== true
    ) {
      setError("连接状态或权限已变化，请检查后重试。");
      return;
    }
    busyRef.current = true;
    setBusy("pairing");
    setError(null);
    const result = await createPairing({ environmentId, input: null });
    busyRef.current = false;
    setBusy(null);
    if (result._tag === "Failure") {
      setError("无法生成配对码，请重试。");
      return;
    }
    if (
      !navigation.isFocused() ||
      !hasLiveManagementAccess() ||
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.settings
        .windowsCompanionEnabled !== true
    )
      return;
    const { code, expiresAt } = result.value;
    const expiration = new Date(expiresAt).toLocaleTimeString();
    Dialog.alert(
      "Windows 受控端配对码",
      `${code}\n\n在 Windows 受控端输入此配对码。有效期至 ${expiration}，限使用一次。`,
    );
  }

  function openDeviceActions(device: CompanionDevice) {
    Dialog.alert(device.name, describeDevice(device), [
      { text: "取消", style: "cancel" },
      {
        text: "重命名",
        onPress: () =>
          Dialog.prompt({
            title: "重命名 Windows 设备",
            initialValue: device.name,
            confirmText: "保存",
            onConfirm: (value) => {
              const name = value.trim();
              if (!name || name.length > 128) {
                setError("设备名称须为 1 到 128 个字符。");
              } else if (name !== device.name) {
                void modifyDevice(() =>
                  renameDevice({ environmentId, input: { deviceId: device.deviceId, name } }),
                );
              }
            },
          }),
      },
      {
        text: "解除配对",
        style: "destructive",
        onPress: () =>
          Dialog.confirm({
            title: "解除设备配对？",
            message: `「${device.name}」需要重新配对才能连接此环境。`,
            confirmText: "解除配对",
            destructive: true,
            onConfirm: () =>
              void modifyDevice(() =>
                revokeDevice({ environmentId, input: { deviceId: device.deviceId } }),
              ),
          }),
      },
    ]);
  }

  async function modifyDevice(action: () => Promise<{ readonly _tag: string }>) {
    if (busyRef.current) return;
    if (!hasLiveManagementAccess()) {
      setError("连接状态或权限已变化，请检查后重试。");
      return;
    }
    busyRef.current = true;
    setBusy("device");
    setError(null);
    const result = await action();
    busyRef.current = false;
    setBusy(null);
    if (result._tag === "Failure") setError("无法确认设备修改已保存，请刷新后重试。");
    devices.refresh();
  }

  if (!supported || typeof enabled !== "boolean") {
    return (
      <SettingsSection title="Windows 受控端">
        <ListRowLayout label="此服务端暂不支持 Windows 受控端。" />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Windows 受控端">
        <SettingsSwitchRow
          icon="desktopcomputer"
          label="允许 Windows 受控端"
          subtitle={
            managed
              ? "此设置由组织管理。"
              : !canManageAccess || !canWriteSettings
                ? "当前连接没有修改此设置的权限。"
                : busy === "setting"
                  ? "正在保存设置…"
                  : undefined
          }
          disabled={busy !== null || managed || !canManageAccess || !canWriteSettings}
          value={enabled}
          onValueChange={(value) => void changeEnabled(value)}
        />
        {enabled && canManageAccess ? (
          <ListActionRow
            icon="plus"
            label="生成一次性配对码"
            loading={busy === "pairing"}
            disabled={busy !== null}
            onPress={() => void requestPairingCode()}
          />
        ) : null}
        {error ? <ListRowLayout label={error} /> : null}
      </SettingsSection>
      {canManageAccess ? (
        <SettingsSection title="已配对的 Windows 设备">
          {devices.error ? (
            <ListRowLayout label="无法读取设备列表，请重试。" />
          ) : devices.data === null ? (
            <ListRowLayout label="正在读取设备列表…" />
          ) : devices.data.devices.length === 0 ? (
            <ListRowLayout label="尚未配对 Windows 设备" />
          ) : (
            devices.data.devices.map((device) => (
              <ListActionRow
                key={device.deviceId}
                icon="desktopcomputer"
                label={device.name}
                description={device.online ? "在线 · 设备详情" : "离线 · 设备详情"}
                disabled={busy !== null}
                onPress={() => openDeviceActions(device)}
              />
            ))
          )}
          <ListActionRow
            icon="arrow.clockwise"
            label={devices.error ? "重试" : "刷新设备列表"}
            loading={devices.isPending}
            onPress={devices.refresh}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

function describeDevice(device: CompanionDevice): string {
  const fields = [
    ["计算机名", device.info.hostname],
    ["Windows 版本", device.info.os],
    ["受控端版本", device.info.version],
    ["处理器", device.info.cpu],
    ["显卡", device.info.gpu],
    ["内存", device.info.memory],
    ...Object.entries(device.info)
      .filter(([key]) => /^network(?:[1-6])?$/.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, value]) => ["网卡", value]),
  ].flatMap(([label, value]) => (value ? [`${label} · ${value}`] : []));
  const updated = new Date(device.detailsUpdatedAt ?? device.lastSeen).toLocaleString();
  return [
    device.online ? "在线" : "离线",
    `资料更新时间 · ${updated}`,
    !device.online
      ? "请在这台电脑上打开受控端并恢复接收。"
      : device.info.desktopState === "locked"
        ? "请先解锁 Windows，再确认收发文件、截图或录屏。"
        : device.info.desktopState === "ready"
          ? "可在这台电脑上确认收发文件、截图和录屏。"
          : "请在这台电脑上核实桌面状态后再发送请求。",
    ...(fields.filter((field) => field.startsWith("网卡 ·")).length > 1
      ? ["以下网卡属于同一台已配对电脑。"]
      : []),
    "",
    ...(fields.length > 0 ? fields : ["在 Windows 受控端运行「设备自检」可发送设备资料。"]),
    ...device.recentTasks.flatMap((task, index) => [
      ...(index === 0 ? ["", "最近任务"] : []),
      `${companionActionLabels[task.action] ?? task.action} · ${taskStatusLabels[task.status]} · ${new Date(task.updatedAt).toLocaleString()}`,
      task.id,
      ...(task.savedPath ? [task.savedPath] : []),
    ]),
  ].join("\n");
}

const companionActionLabels: Readonly<Record<string, string>> = {
  screenshot: "截图",
  "record-screen": "录屏",
  "open-t3": "打开 T3",
  "open-notepad": "打开记事本",
  "close-window": "关闭窗口",
  "send-file": "发送文件",
  "receive-file": "接收文件",
  "write-notepad": "填写记事本",
  "read-notepad": "读取记事本",
};

const taskStatusLabels = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  canceled: "已取消",
} as const;
