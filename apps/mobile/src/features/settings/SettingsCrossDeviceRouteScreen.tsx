import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthClientSession,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useGT } from "../../i18n/I18nProvider";
import { appAtomRegistry } from "../../state/atom-registry";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import {
  environmentConnectedAtom,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentStatusText } from "../connection/environmentStatusText";
import { LocalApkInstallSection } from "./components/LocalApkInstallSection";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { WindowsCompanionSettings } from "./components/WindowsCompanionSettings";

export function SettingsCrossDeviceRouteScreen() {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  return (
    <SettingsScreen title="多端互控">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection>
          <SettingsRow
            icon="plus"
            label="配对环境"
            value="扫描桌面端二维码，或输入地址和配对码"
            onPress={() => navigation.navigate("SettingsEnvironmentNew")}
          />
        </SettingsSection>
        <SettingsSection title="已配对环境">
          {connectedEnvironments.length === 0 ? (
            <ListRowLayout label={isLoadingSavedConnection ? "正在读取环境…" : "尚未配对环境"} />
          ) : (
            connectedEnvironments.map((environment) => (
              <SettingsRow
                key={environment.environmentId}
                icon="desktopcomputer"
                label={environment.environmentLabel}
                value={
                  environment.isEnabled || environment.connectionState === "unsupported"
                    ? environmentStatusText(
                        { phase: environment.connectionState, error: null, traceId: null },
                        gt,
                      )
                    : gt("Off")
                }
                onPress={() =>
                  navigation.navigate("SettingsCrossDeviceAccess", {
                    environmentId: environment.environmentId,
                  })
                }
              />
            ))
          )}
        </SettingsSection>
        <LocalApkInstallSection />
      </ScreenScrollView>
    </SettingsScreen>
  );
}

export function SettingsCrossDeviceAccessRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <CrossDeviceAccess
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function CrossDeviceAccess({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environment = connectedEnvironments.find((entry) => entry.environmentId === environmentId);
  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const session = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const canRead = connected && sessionHasScope(session, AuthAccessReadScope);
  const canWrite = canRead && sessionHasScope(session, AuthAccessWriteScope);
  const access = useEnvironmentQuery(
    canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const revokeClient = useAtomCommand(authEnvironment.revokeClient);
  const [revoking, setRevoking] = useState<AuthClientSession["sessionId"] | null>(null);
  const revokingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const clients = access.data?.type === "snapshot" ? access.data.payload.clientSessions : undefined;
  let status: string | null = null;
  if (!environment) {
    status = isLoadingSavedConnection ? "正在读取环境…" : "此设备未保存该环境。";
  } else if (!connected) {
    status = "连接此环境后可查看设备授权。";
  } else if (!canRead) {
    if (session._tag === "Failure") {
      status = "无法读取当前授权，请重新连接环境。";
    } else if (session._tag === "Initial") {
      status = "正在检查权限…";
    } else {
      status = "当前连接没有查看设备授权的权限。";
    }
  } else if (access.error) {
    status = "无法读取设备授权，请重试。";
  } else if (clients === undefined) {
    status = "正在读取设备授权…";
  } else if (clients.length === 0) {
    status = "没有授权会话。";
  }

  function confirmRevoke(entry: AuthClientSession, label: string) {
    if (!canWrite || access.error || entry.current || revokingRef.current) return;
    Dialog.confirm({
      title: "撤销设备授权？",
      message: `撤销「${label}」的这条授权后，设备会断开此会话。`,
      confirmText: "撤销授权",
      destructive: true,
      onConfirm: () => {
        if (revokingRef.current) return;
        void revoke(entry.sessionId);
      },
    });
  }

  async function revoke(sessionId: AuthClientSession["sessionId"]) {
    if (
      !appAtomRegistry.get(environmentConnectedAtom(environmentId)) ||
      !readEnvironmentScope(environmentId, AuthAccessReadScope) ||
      !readEnvironmentScope(environmentId, AuthAccessWriteScope)
    ) {
      setError("连接状态或权限已变化，请检查后重试。");
      return;
    }
    revokingRef.current = true;
    setRevoking(sessionId);
    setError(null);
    const result = await revokeClient({ environmentId, input: { sessionId } });
    revokingRef.current = false;
    setRevoking(null);
    if (result._tag === "Failure") {
      setError("无法确认授权已撤销，请重试。");
    }
  }

  return (
    <SettingsScreen title="设备授权">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environment ? (
          <SettingsSection>
            <SettingsRow
              icon="desktopcomputer"
              label={environment.environmentLabel}
              value="连接设置"
              onPress={() => navigation.navigate("SettingsEnvironmentDetail", { environmentId })}
            />
          </SettingsSection>
        ) : null}
        {environment ? (
          <WindowsCompanionSettings environmentId={environmentId} connected={connected} />
        ) : null}
        <SettingsSection
          title="授权会话"
          footer={canRead && !canWrite ? "当前连接只可查看设备授权。" : undefined}
        >
          {status ? <ListRowLayout label={status} /> : null}
          {canRead && access.error ? (
            <ListActionRow icon="arrow.clockwise" label="重试" onPress={access.refresh} />
          ) : null}
          {canRead && error ? <ListRowLayout label={error} /> : null}
          {canRead && !access.error
            ? clients?.map((entry) => {
                // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- 这是已授权会话的设备描述字段
                const { client: metadata } = entry;
                const label = metadata.label ?? metadata.browser ?? metadata.os ?? "未知设备";
                const state = entry.current ? "当前连接" : entry.connected ? "在线" : "离线";
                const description = [metadata.os === label ? undefined : metadata.os, state]
                  .filter(Boolean)
                  .join(" · ");
                return canWrite && !entry.current ? (
                  <ListActionRow
                    key={entry.sessionId}
                    icon="person.crop.circle"
                    label={label}
                    description={`${description} · 撤销授权`}
                    disabled={revoking !== null}
                    loading={revoking === entry.sessionId}
                    onPress={() => confirmRevoke(entry, label)}
                  />
                ) : (
                  <ListRowLayout
                    key={entry.sessionId}
                    icon="person.crop.circle"
                    label={label}
                    description={description}
                  />
                );
              })
            : null}
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
