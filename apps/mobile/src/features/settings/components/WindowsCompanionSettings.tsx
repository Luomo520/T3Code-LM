import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import {
  lookupWindowsCompanionMac,
  windowsCompanionAvailability,
  windowsCompanionCapabilityEntries,
  windowsCompanionNetworkAdapters,
} from "@t3tools/client-runtime/device/windows-companion";
import {
  AuthAccessWriteScope,
  AuthSettingsWriteScope,
  type CompanionDevice,
  isManagedSettingPath,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Fragment, useCallback, useRef, useState } from "react";
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
import { useSelectWorkspaceDetail } from "../../layout/workspace/useSelectWorkspaceDetail";
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
  const selectDetail = useSelectWorkspaceDetail();
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
  const [recentDeviceId, setRecentDeviceId] = useState<string | null>(null);
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
    Dialog.alert(device.name, describeDevice(device, enabled === true), [
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

  function lookUpDeviceByMac(pairedDevices: readonly CompanionDevice[]) {
    Dialog.prompt({
      title: "按 MAC 地址查找设备",
      message: "输入设备网卡的 MAC 地址，例如 02:11:22:33:44:55。",
      initialValue: "",
      confirmText: "查找",
      onConfirm: (address) => {
        const matches = lookupWindowsCompanionMac(pairedDevices, address);
        const match = matches?.length === 1 ? matches[0] : undefined;
        Dialog.alert(
          "MAC 地址查询",
          !matches
            ? "请输入有效的 MAC 地址。"
            : match
              ? `「${match.name}」上报了此地址。请核对设备的配对记录。`
              : matches.length === 0
                ? "已配对的设备未上报此 MAC 地址。"
                : [
                    "多台设备上报了此 MAC 地址，请核对设备的配对记录。",
                    ...matches.map(
                      (device) => `${device.name} · ${device.info.hostname || device.deviceId}`,
                    ),
                  ].join("\n"),
        );
      },
    });
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
            <>
              <ListActionRow
                icon="magnifyingglass"
                label="按 MAC 地址查找设备"
                onPress={() => lookUpDeviceByMac(devices.data?.devices ?? [])}
              />
              {devices.data.devices.map((device) => (
                <Fragment key={device.deviceId}>
                  <ListActionRow
                    icon="desktopcomputer"
                    label={device.name}
                    description={`${connectionLabels[windowsCompanionAvailability(device, enabled)]} · 设备详情`}
                    disabled={busy !== null}
                    onPress={() => openDeviceActions(device)}
                  />
                  {device.recentTasks.length > 0 ? (
                    <ListActionRow
                      icon="clock"
                      label={`${device.name} · 最近任务`}
                      onPress={() =>
                        setRecentDeviceId((current) =>
                          current === device.deviceId ? null : device.deviceId,
                        )
                      }
                    />
                  ) : null}
                  {recentDeviceId === device.deviceId
                    ? device.recentTasks.map((task) => {
                        const label = `${companionActionLabels[task.action] ?? task.action} · ${taskStatusLabels[task.status]}`;
                        const description = [
                          new Date(task.updatedAt).toLocaleString(),
                          task.id,
                          task.savedPath,
                        ]
                          .filter(Boolean)
                          .join("\n");
                        const threadId = task.threadId;
                        return threadId ? (
                          <ListActionRow
                            key={task.id}
                            label={label}
                            description={`${description}\n打开原会话`}
                            onPress={() =>
                              selectDetail({ name: "Thread", params: { environmentId, threadId } })
                            }
                          />
                        ) : (
                          <ListRowLayout key={task.id} label={label} description={description} />
                        );
                      })
                    : null}
                </Fragment>
              ))}
            </>
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

const connectionLabels = {
  disabled: "此环境已关闭",
  locked: "Windows 已锁定",
  paused: "接收已暂停",
  offline: "离线",
  unknown: "在线",
  confirmOnDevice: "在线",
};

function describeDevice(device: CompanionDevice, enabled: boolean): string {
  const fields = [
    ["计算机名", device.info.hostname],
    ["Windows 版本", device.info.os],
    ["受控端版本", device.info.version],
    ["处理器", device.info.cpu],
    ["显卡", device.info.gpu],
    ["内存", device.info.memory],
    ...windowsCompanionNetworkAdapters(device.info).map(([, value]) => ["网卡", value]),
  ].flatMap(([label, value]) => (value ? [`${label} · ${value}`] : []));
  const updated = new Date(device.detailsUpdatedAt ?? device.lastSeen).toLocaleString();
  const capabilities = windowsCompanionCapabilityEntries(device, enabled);
  const capabilityLabels = {
    sendFile: "发送文件",
    receiveFile: "接收文件",
    screenshot: "截图",
    screenRecording: "开始录屏",
    desktopInput: "打开 T3 或操作记事本",
    windowForm: "窗口点击与填写",
    inspectControls: "查看窗口控件",
    localScript: "运行本机诊断或已批准的脚本",
    sshProfile: "打开本机 SSH 连接",
    stopRecording: "停止录屏",
    installApp: "安装应用",
  };
  const capabilityReasons = {
    disabled: "请在此环境开启 Windows 受控端。",
    offline: "请在这台电脑上打开受控端并恢复接收。",
    paused: "请在这台电脑上恢复接收。",
    inputPaused: "请在这台电脑的托盘菜单恢复远程输入。",
    locked: "请解锁这台电脑并恢复接收。",
    unknown: "请在这台电脑上运行设备自检。",
    confirmOnDevice: "可用，需在这台电脑上确认。",
    stopLocally: "请在这台电脑的受控端停止录屏。",
    stopFromConversation: "可从原会话或在这台电脑上停止。",
    noRecording: "录屏开始后可停止。",
    unsupported: "Windows 受控端暂不支持安装应用。",
  };
  return [
    connectionLabels[windowsCompanionAvailability(device, enabled)],
    `资料更新时间 · ${updated}`,
    "",
    ...capabilities.map(([key, state]) => `${capabilityLabels[key]} · ${capabilityReasons[state]}`),
    "",
    ...(fields.length > 0 ? fields : ["在 Windows 受控端运行「设备自检」可发送设备资料。"]),
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
  "press-window-button": "点击窗口按钮",
  "fill-window-field": "填写窗口字段",
  "inspect-window-controls": "查看窗口控件",
  "run-approved-script": "运行本机诊断或已批准的脚本",
  "open-ssh-profile": "打开本机 SSH 连接",
  "read-notepad": "读取记事本",
};

const taskStatusLabels = {
  queued: "排队中",
  running: "进行中",
  done: "已完成",
  failed: "失败",
  canceled: "已取消",
} as const;
