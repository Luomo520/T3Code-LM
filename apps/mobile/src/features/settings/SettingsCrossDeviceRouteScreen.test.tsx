import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  EnvironmentId,
  type AuthClientSession,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import type { Preferences } from "../../persistence/mobile-preferences";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  ConfirmDialogRequest,
  TextInputDialogRequest,
} from "../../components/ui/Dialog.types";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";

const harness = vi.hoisted(() => ({
  navigate: vi.fn(),
  selectDetail: vi.fn(),
  confirm: vi.fn<(request: ConfirmDialogRequest) => void>(),
  alert:
    vi.fn<
      (title: string, message: string, buttons?: { text: string; onPress?: () => void }[]) => void
    >(),
  prompt: vi.fn<(request: TextInputDialogRequest) => void>(),
  revoke: vi.fn(),
  refresh: vi.fn(),
  updateSettings: vi.fn(),
  createPairing: vi.fn(),
  readDevices: vi.fn(),
  renameCompanion: vi.fn(),
  revokeCompanion: vi.fn(),
  subscribe: vi.fn(),
  online: true,
  loading: false,
  supportsWindowsCompanion: false,
  supportsLinuxSsh: false,
  supportsAutomaticHandoff: false,
  preferences: {} as Preferences,
  savePreferences: vi.fn(),
  windowsCompanionEnabled: false,
  scopes: new Set<AuthEnvironmentScope>(),
  environments: [] as ConnectedEnvironmentSummary[],
  clients: [] as AuthClientSession[],
  error: null as string | null,
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => undefined,
  useNavigation: () => ({ navigate: harness.navigate, isFocused: () => true }),
}));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => harness.selectDetail,
}));
vi.mock("../files/androidDirectory", () => ({ androidDirectory: null }));
vi.mock("../files/android-directory-handoff", () => ({
  androidDirectoryHandoff: { receive: "android-file" },
  androidDirectoryQuiet: {},
}));
vi.mock("./components/AndroidCapturePermissionsSettings", () => ({
  AndroidCapturePermissionsSettings: () => null,
}));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
function serverConfig() {
  return {
    environment: {
      capabilities: {
        windowsCompanion: harness.supportsWindowsCompanion,
        linuxSshDevices: harness.supportsLinuxSsh,
      },
    },
    settings: { windowsCompanionEnabled: harness.windowsCompanionEnabled },
  };
}

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? serverConfig()
      : atom === "preferences"
        ? AsyncResult.success(harness.preferences)
        : { _tag: "Success" },
  useAtomSet: () => harness.savePreferences,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("../../i18n/I18nProvider", () => ({ useGT: () => (source: string) => source }));
vi.mock("../../components/ui/Dialog", () => ({
  alert: harness.alert,
  confirm: harness.confirm,
  prompt: harness.prompt,
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: (atom: string) => (atom === "config" ? serverConfig() : harness.online) },
}));
vi.mock("../../lib/systemFileDownload", () => ({
  supportsAutomaticFileHandoff: () => harness.supportsAutomaticHandoff,
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: "preferences",
  updateMobilePreferencesAtom: "update-preferences",
}));
vi.mock("../../state/auth", () => ({
  authEnvironment: {
    accessChanges: (...args: unknown[]) => {
      harness.subscribe(...args);
      return "access";
    },
    revokeClient: {},
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string | null) => ({
    data:
      atom === "access"
        ? { type: "snapshot", payload: { clientSessions: harness.clients } }
        : atom === "devices"
          ? {
              devices: [
                {
                  deviceId: "pc",
                  name: "已配对的电脑",
                  online: true,
                  info: {},
                  lastSeen: "2026-11-23T00:00:00Z",
                  recentTasks: [
                    {
                      id: "task-test",
                      threadId: "thread-test",
                      action: "screenshot",
                      status: "done",
                      updatedAt: "2026-11-23T00:00:00Z",
                    },
                  ],
                },
              ],
            }
          : atom === "linux-devices"
            ? {
                devices: [
                  {
                    deviceId: "linux-test",
                    sftpAliases: ["linux-files"],
                    diagnosticAliases: ["linux-diagnostic"],
                    waiting: 2,
                    active: "ssh-diagnostics",
                    lastDiagnostic: {
                      result: { check: "system_version", kernelVersion: "Linux 6.12.0" },
                      checkedAt: "2026-11-23T00:00:00Z",
                    },
                  },
                ],
              }
            : null,
    error: atom ? harness.error : null,
    refresh: harness.refresh,
  }),
}));
vi.mock("../../state/use-remote-environment-registry", () => ({
  environmentConnectedAtom: () => "connected",
  useRemoteConnectionStatus: () => ({ connectedEnvironments: harness.environments }),
  useSavedRemoteConnections: () => ({ isLoadingSavedConnection: harness.loading }),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => "session" },
  useEnvironmentScope: (_environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
    harness.scopes.has(scope),
  readEnvironmentScope: (_environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
    harness.scopes.has(scope),
  sessionHasScope: (_session: unknown, scope: AuthEnvironmentScope) => harness.scopes.has(scope),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config", updateSettings: "update" },
}));
vi.mock("./windowsCompanionCommands", () => ({
  createWindowsCompanionPairing: "pair",
  renameWindowsCompanion: "rename",
  revokeWindowsCompanion: "revoke-companion",
  windowsCompanions: (...args: unknown[]) => {
    harness.readDevices(...args);
    return "devices";
  },
}));
vi.mock("./linuxSshDeviceQuery", () => ({
  linuxSshDevices: () => "linux-devices",
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    (
      {
        pair: harness.createPairing,
        update: harness.updateSettings,
        rename: harness.renameCompanion,
        "revoke-companion": harness.revokeCompanion,
      } as Record<string, typeof harness.revoke>
    )[command] ?? harness.revoke,
}));

function Container(props: { children?: ReactNode; title?: string; footer?: string }) {
  return (
    <section>
      {props.title}
      {props.children}
      {props.footer}
    </section>
  );
}

function Row(props: { label: string; description?: string; value?: string }) {
  return (
    <>
      {props.label} {props.description ?? props.value}
    </>
  );
}

function InteractiveRow(props: {
  label: string;
  description?: string;
  value?: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <button disabled={props.disabled} onClick={props.onPress}>
      <Row {...props} />
    </button>
  );
}

vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: Container }));
vi.mock("../../components/ui/ListRowLayout", () => ({ ListRowLayout: Row }));
vi.mock("../../components/ui/ListActionRow", () => ({ ListActionRow: InteractiveRow }));
vi.mock("./components/SettingsRow", () => ({ SettingsRow: InteractiveRow }));
vi.mock("./components/LocalApkInstallSection", () => ({ LocalApkInstallSection: () => null }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Container }));
vi.mock("./components/SettingsSwitchRow", () => ({
  SettingsSwitchRow: (row: {
    label: string;
    disabled: boolean;
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      disabled={row.disabled}
      role="switch"
      aria-checked={row.value}
      onClick={() => row.onValueChange(!row.value)}
    >
      {row.label}
    </button>
  ),
}));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Container }));

import {
  SettingsCrossDeviceAccessRouteScreen,
  SettingsCrossDeviceRouteScreen,
} from "./SettingsCrossDeviceRouteScreen";

const environmentId = EnvironmentId.make("nas");
const environment: ConnectedEnvironmentSummary = {
  environmentId,
  environmentLabel: "家庭 NAS",
  displayUrl: "https://nas.example",
  isRelayManaged: false,
  isEnabled: true,
  connectionState: "connected",
  connectionError: null,
  connectionErrorTraceId: null,
};

function client(label: string, current: boolean): AuthClientSession {
  return {
    sessionId: AuthSessionId.make(label),
    subject: "user",
    client: { label, deviceType: "desktop", os: "Windows" },
    current,
    connected: current,
    scopes: [],
    method: "bearer-access-token",
    issuedAt: DateTime.makeUnsafe(0),
    expiresAt: DateTime.makeUnsafe(1000),
    lastConnectedAt: null,
  };
}

describe("Android 多端互控", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.online = true;
    harness.loading = false;
    harness.supportsWindowsCompanion = false;
    harness.supportsLinuxSsh = false;
    harness.supportsAutomaticHandoff = false;
    harness.preferences = {};
    harness.savePreferences.mockImplementation(async ({ transform }) => {
      harness.preferences = { ...harness.preferences, ...transform(harness.preferences) };
      return Exit.succeed(harness.preferences);
    });
    harness.windowsCompanionEnabled = false;
    harness.scopes.clear();
    harness.environments = [environment];
    harness.clients = [client("本机", true), client("书房电脑", false)];
    harness.error = null;
    harness.revoke.mockResolvedValue(AsyncResult.success({ revoked: true }));
    harness.updateSettings.mockResolvedValue(AsyncResult.success({}));
    harness.renameCompanion.mockResolvedValue(AsyncResult.success({ ok: true }));
    harness.revokeCompanion.mockResolvedValue(AsyncResult.success({ ok: true }));
    harness.createPairing.mockResolvedValue(
      AsyncResult.success({ code: "PAIRING-CODE", expiresAt: "2026-11-23T10:00:00Z" }),
    );
    container = document.createElement("div");
    root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  const accessPage = (key?: string) => (
    <SettingsCrossDeviceAccessRouteScreen key={key} route={{ params: { environmentId } }} />
  );
  const render = async (page: ReactNode) => act(async () => root.render(page));
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes(label),
    );
  const click = async (label: string) => {
    const element = button(label);
    expect(element).toBeDefined();
    await act(async () => element?.click());
  };

  it("从真实环境列表进入现有配对和所选环境的授权页面", async () => {
    await render(<SettingsCrossDeviceRouteScreen />);
    expect(button("家庭 NAS")?.textContent).toContain("Connected");
    await click("配对环境");
    expect(harness.navigate).toHaveBeenCalledWith("SettingsEnvironmentNew");
    await click("家庭 NAS");
    expect(harness.navigate).toHaveBeenCalledWith("SettingsCrossDeviceAccess", { environmentId });
  });

  it("授权不足时提供既有连接设置且不请求设备授权数据", async () => {
    await render(accessPage());
    expect(container.textContent).toContain("没有查看设备授权的权限");
    expect(harness.subscribe).not.toHaveBeenCalled();
    await click("家庭 NAS");
    expect(harness.navigate).toHaveBeenCalledWith("SettingsEnvironmentDetail", { environmentId });
  });

  it("在已配对环境中保存本机自动接收设置，也支持离线切换", async () => {
    harness.supportsAutomaticHandoff = true;
    harness.environments = [{ ...environment, connectionState: "offline" }];
    await render(accessPage());
    expect(button("自动接收会话文件")?.getAttribute("aria-checked")).toBe("true");
    await click("自动接收会话文件");
    expect(harness.preferences.automaticFileHandoffDisabledEnvironments).toEqual([environmentId]);
    await render(accessPage("read-from-stored-settings"));
    expect(button("自动接收会话文件")?.getAttribute("aria-checked")).toBe("false");
    await click("自动接收会话文件");
    expect(harness.preferences.automaticFileHandoffDisabledEnvironments).toEqual([]);
    expect(harness.updateSettings).not.toHaveBeenCalled();
  });

  it("环境离线时不请求授权会话", async () => {
    harness.environments = [{ ...environment, connectionState: "offline" }];
    harness.scopes.add(AuthAccessReadScope);
    await render(accessPage());
    expect(container.textContent).toContain("连接此环境后可查看设备授权");
    expect(harness.subscribe).not.toHaveBeenCalled();
  });

  it("只读权限显示会话与状态，并保留刷新失败的重试入口", async () => {
    harness.scopes.add(AuthAccessReadScope);
    await render(accessPage());
    expect(harness.subscribe).toHaveBeenCalledWith({ environmentId, input: null });
    expect(container.textContent).toContain("当前连接");
    expect(container.textContent).toContain("离线");
    expect(container.textContent).toContain("只可查看设备授权");
    expect(button("书房电脑")).toBeUndefined();
    harness.error = "network error";
    await render(accessPage("network-error"));
    await click("重试");
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("书房电脑");
  });

  it("经过确认向所选环境撤销其他会话，当前连接不可撤销", async () => {
    harness.scopes.add(AuthAccessReadScope).add(AuthAccessWriteScope);
    await render(accessPage());
    expect(button("本机")).toBeUndefined();
    await click("书房电脑");
    expect(harness.revoke).not.toHaveBeenCalled();

    const confirmation = harness.confirm.mock.calls.at(0)?.[0];
    expect(confirmation).toMatchObject({ destructive: true });
    await act(async () => confirmation?.onConfirm());
    expect(harness.revoke).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { sessionId: AuthSessionId.make("书房电脑") },
    });
  });

  it("确认时重新检查权限和连接", async () => {
    harness.scopes.add(AuthAccessReadScope).add(AuthAccessWriteScope);
    await render(accessPage());
    await click("书房电脑");
    harness.online = false;
    await act(async () => harness.confirm.mock.calls.at(0)?.[0].onConfirm());
    expect(harness.revoke).not.toHaveBeenCalled();
    expect(container.textContent).toContain("连接状态或权限已变化");
  });

  it("旧版服务端没有 Windows 受控端开关或配对动作", async () => {
    harness.scopes.add(AuthAccessWriteScope).add(AuthSettingsWriteScope);
    await render(accessPage());
    expect(button("允许 Windows 受控端")).toBeUndefined();
    expect(button("生成一次性配对码")).toBeUndefined();
    expect(harness.readDevices).not.toHaveBeenCalled();
  });

  it("使用所选环境读写真实开关，启用后由用户主动生成配对码", async () => {
    harness.supportsWindowsCompanion = true;
    harness.scopes.add(AuthAccessWriteScope).add(AuthSettingsWriteScope);
    await render(accessPage());
    expect(button("允许 Windows 受控端")?.getAttribute("aria-checked")).toBe("false");
    expect(button("生成一次性配对码")).toBeUndefined();
    await click("允许 Windows 受控端");
    expect(harness.updateSettings).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { patch: { windowsCompanionEnabled: true } },
    });
    expect(button("允许 Windows 受控端")?.getAttribute("aria-checked")).toBe("false");
    harness.windowsCompanionEnabled = true;
    await render(accessPage("updated-config"));
    expect(harness.readDevices).toHaveBeenCalledWith({ environmentId, input: null });
    expect(container.textContent).toContain("已配对的电脑 在线");
    expect(harness.createPairing).not.toHaveBeenCalled();
    await click("已配对的电脑 · 最近任务");
    expect(container.textContent).toContain("task-test");
    await click("截图 · 已完成");
    expect(harness.selectDetail).toHaveBeenCalledWith({
      name: "Thread",
      params: { environmentId, threadId: "thread-test" },
    });

    await click("生成一次性配对码");
    expect(harness.createPairing).toHaveBeenCalledExactlyOnceWith({ environmentId, input: null });
    expect(harness.alert).toHaveBeenCalledWith(
      "Windows 受控端配对码",
      expect.stringContaining("PAIRING-CODE"),
    );
  });

  it("缺少写设置和管理访问授权时不会接入受控端 API", async () => {
    harness.supportsWindowsCompanion = true;
    harness.supportsLinuxSsh = true;
    harness.windowsCompanionEnabled = true;
    harness.scopes.add(AuthAccessReadScope);
    await render(accessPage());
    expect(button("允许 Windows 受控端")?.disabled).toBe(true);
    expect(button("生成一次性配对码")).toBeUndefined();
    expect(harness.readDevices).not.toHaveBeenCalled();
    expect(container.textContent).toContain("linux-test");
    expect(container.textContent).toContain("等待 2 项");
    expect(container.textContent).toContain("Linux 6.12.0");
  });

  it("功能关闭时仍能重命名和解除已配对 Windows 设备", async () => {
    harness.supportsWindowsCompanion = true;
    harness.scopes.add(AuthAccessWriteScope);
    await render(accessPage());
    expect(button("生成一次性配对码")).toBeUndefined();
    await click("已配对的电脑");
    const actions = harness.alert.mock.calls.at(-1)?.[2];
    await act(async () => actions?.find((action) => action.text === "重命名")?.onPress?.());
    const prompt = harness.prompt.mock.calls.at(-1)?.[0];
    expect(prompt?.initialValue).toBe("已配对的电脑");
    await act(async () => prompt?.onConfirm(" 书房电脑 "));
    expect(harness.renameCompanion).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { deviceId: "pc", name: "书房电脑" },
    });
    expect(harness.refresh).toHaveBeenCalledTimes(1);

    await click("已配对的电脑");
    await act(async () =>
      harness.alert.mock.calls
        .at(-1)?.[2]
        ?.find((action) => action.text === "解除配对")
        ?.onPress?.(),
    );
    expect(harness.revokeCompanion).not.toHaveBeenCalled();
    await act(async () => harness.confirm.mock.calls.at(-1)?.[0].onConfirm());
    expect(harness.revokeCompanion).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { deviceId: "pc" },
    });
    expect(harness.refresh).toHaveBeenCalledTimes(2);
  });
});
