import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CliUpdateChoice, RemoteUpdateDevice, ServerUpdateChoice } from "../updateCenter";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  mocks: {
    devices: [] as RemoteUpdateDevice[],
    asset: null as object | null,
    getMetered: vi.fn(),
    startDownload: vi.fn(),
    updateServer: vi.fn(),
    updateProvider: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  View: Children,
  Linking: {},
  Pressable: ({
    accessibilityLabel,
    accessibilityRole,
    accessibilityState,
    children,
    disabled,
    onPress,
  }: {
    accessibilityLabel: string;
    accessibilityRole: "checkbox";
    accessibilityState: { checked: boolean };
    children: ReactNode;
    disabled: boolean;
    onPress: () => void;
  }) => (
    <button
      aria-label={accessibilityLabel}
      role={accessibilityRole}
      aria-checked={accessibilityState.checked}
      disabled={disabled}
      onClick={onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("uniwind", () => ({ useResolveClassNames: () => ({}) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.devices }));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({ AppText: Children }));
vi.mock("../../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => (
    <button onClick={onPress} disabled={disabled}>
      {label}
    </button>
  ),
}));
vi.mock("../../../components/ui/ListActionRow", () => ({ ListActionRow: () => null }));
vi.mock("../../../components/ui/ListRowLayout", () => ({
  ListRowLayout: ({ label, description }: { label: string; description?: string }) => (
    <div>
      {label} {description}
    </div>
  ),
}));
vi.mock("../../../components/ui/Progress", () => ({ Progress: () => null }));
vi.mock("../../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => mocks.devices },
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { updateServer: "server", updateProvider: "provider" },
}));
vi.mock("../../../state/session", () => ({ environmentSession: {} }));
vi.mock("../../../state/shell", () => ({ environmentShell: {} }));
vi.mock("../../../state/workspace", () => ({ workspaceConnections: {} }));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "server" ? mocks.updateServer : mocks.updateProvider,
}));
vi.mock("./AndroidAppUpdateSection", () => ({
  AndroidAppUpdateDevice: ({ selection }: { selection?: ReactNode }) => selection,
  androidUpdateDeviceName: () => "此手机",
  androidUpdateVersion: () => "0.2.2-1",
  getAndroidUpdateMetered: mocks.getMetered,
  useAndroidAppUpdate: () => ({
    asset: mocks.asset,
    available: true,
    startDownload: mocks.startDownload,
  }),
}));
vi.mock("./SettingsSection", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

import { AndroidUpdateCenter } from "./AndroidUpdateCenter";

const environmentId = EnvironmentId.make("nas");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const server: ServerUpdateChoice = {
  kind: "server",
  key: "nas-server",
  label: "T3 服务端",
  device: "LM-NAS",
  environmentId,
  fromVersion: "0.2.2-1",
  targetVersion: "0.2.2-2",
  activeSessions: 2,
  desktopManaged: false,
  confirmedDesktopUpdateVersion: false,
};
const cli: CliUpdateChoice = {
  kind: "cli",
  key: "nas-cli",
  label: "Codex CLI",
  device: "LM-NAS",
  environmentId,
  driver,
  instanceId: providerInstanceId,
  fromVersion: "0.170.0",
  targetVersion: "0.171.0",
};
const provider = {
  instanceId: providerInstanceId,
  driver,
  versionAdvisory: { status: "behind_latest" },
} as RemoteUpdateDevice["cliRows"][number]["provider"];
const device: RemoteUpdateDevice = {
  environmentId,
  activeSessions: 2,
  device: "LM-NAS",
  connected: true,
  state: { status: "idle" },
  server,
  runningVersion: server.fromVersion,
  lastVersion: server.fromVersion,
  cliRows: [
    {
      provider,
      choice: cli,
      label: cli.label,
      fromVersion: cli.fromVersion,
      target: cli.targetVersion,
    },
  ],
  canManageProviders: true,
  providerBusy: false,
  releaseAtom: null,
  releaseError: null,
  releaseChecking: false,
  targetVersion: server.targetVersion,
  upToDate: false,
  manual: false,
  serverNote: null,
};

let root: Root;
let page: HTMLDivElement;

async function press(label: string) {
  const button = [...page.querySelectorAll("button")].find(
    (candidate) => (candidate.getAttribute("aria-label") ?? candidate.textContent) === label,
  );
  if (!button) throw new Error(`按钮未出现：${label}`);
  await act(async () => button.click());
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  mocks.devices = [device];
  mocks.asset = null;
  mocks.updateServer.mockResolvedValue(AsyncResult.success({ targetVersion: "0.2.2-2" }));
  mocks.updateProvider.mockResolvedValue(
    AsyncResult.success({
      providers: [
        {
          instanceId: providerInstanceId,
          installedVersion: "0.171.1",
          updateState: { status: "succeeded" },
        },
      ],
    }),
  );
  mocks.getMetered.mockResolvedValue(true);
  mocks.startDownload.mockResolvedValue(true);
  page = document.createElement("div");
  root = createRoot(page);
});

afterEach(() => {
  act(() => root.unmount());
});

function render() {
  act(() => root.render(<AndroidUpdateCenter />));
}

describe("Android 关于中的更新中心", () => {
  it("单选 CLI 时只更新对应实例，显示重新读取的实际安装版本", async () => {
    render();
    await press("LM-NAS · Codex CLI");
    await press("更新所选项");
    expect(page.textContent).toContain("0.170.0 → 0.171.0");
    expect(page.textContent).toContain("预计中断 0 个会话");
    expect(page.textContent).not.toContain("T3 服务端");
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    await press("确认更新");
    expect(mocks.updateProvider).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { provider: driver, instanceId: providerInstanceId },
    });
    expect(mocks.updateServer).not.toHaveBeenCalled();
    expect(mocks.startDownload).not.toHaveBeenCalled();
    expect(page.textContent).toContain("当前版本 0.171.1");
  });

  it("单选服务端时显示中断范围，返回和取消时不执行，确认后只更新服务端", async () => {
    render();
    await press("LM-NAS · T3 服务端");
    await press("更新所选项");
    expect(page.textContent).toContain("2 个运行中的会话可能会中断");
    await press("返回选择");
    await press("取消选择");
    expect(mocks.updateServer).not.toHaveBeenCalled();
    await press("LM-NAS · T3 服务端");
    await press("更新所选项");
    await press("确认更新");
    expect(mocks.updateServer).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { targetVersion: "0.2.2-2" },
    });
    expect(mocks.updateProvider).not.toHaveBeenCalled();
    expect(page.textContent).toContain("已确认运行版本 0.2.2-2");
  });

  it("服务端重启影响增大时要求重新确认", async () => {
    render();
    await press("LM-NAS · T3 服务端");
    await press("更新所选项");
    mocks.devices = [{ ...device, server: { ...server, activeSessions: 3 } }];
    await press("确认更新");
    expect(mocks.updateServer).not.toHaveBeenCalled();
    expect(page.textContent).toContain("更新条件已有变化");
  });

  it("同时选中同一设备的 CLI 和服务端时先完成 CLI 再重启", async () => {
    render();
    await press("LM-NAS · T3 服务端");
    await press("LM-NAS · Codex CLI");
    await press("更新所选项");
    await press("确认更新");
    expect(mocks.updateProvider).toHaveBeenCalledBefore(mocks.updateServer);
    expect(mocks.startDownload).not.toHaveBeenCalled();
  });

  it.each([true, false])("远端桌面说明同宿主后端和版本确认能力 (%s)", async (strictVersion) => {
    const remote = {
      ...server,
      desktopManaged: true,
      confirmedDesktopUpdateVersion: strictVersion,
    };
    mocks.devices = [{ ...device, server: remote }];
    render();
    await press("LM-NAS · T3 服务端");
    await press("更新所选项");
    expect(page.textContent).toContain("含 WSL");
    expect(page.textContent?.includes("目标版本供参考")).toBe(!strictVersion);
    await press("确认更新");
    expect(mocks.updateServer).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { targetVersion: remote.targetVersion },
      ...(strictVersion ? { requireConfirmedDesktopVersion: true } : {}),
    });
  });

  it("手动安装的 CLI 展示目标和操作提示，不提供勾选", () => {
    mocks.devices = [
      {
        ...device,
        cliRows: [
          {
            provider,
            choice: null,
            label: cli.label,
            fromVersion: cli.fromVersion,
            target: cli.targetVersion,
          },
        ],
      },
    ];
    render();
    expect(page.textContent).toContain("目标版本 0.171.0");
    expect(page.textContent).toContain("需手动更新");
    expect(page.querySelector('[aria-label="LM-NAS · Codex CLI"]')).toBeNull();
  });

  it("单选 Android App 时先展示流量影响，确认后只安排下载", async () => {
    mocks.asset = { productVersion: "0.2.2", build: 2, sizeBytes: 1048576, sha256: "sample" };
    render();
    await press("此手机 · Android App");
    await press("更新所选项");
    expect(page.textContent).toContain("可能产生流量费用");
    expect(mocks.startDownload).not.toHaveBeenCalled();
    await press("确认更新");
    expect(mocks.startDownload).toHaveBeenCalledExactlyOnceWith(mocks.asset, true);
    expect(mocks.updateServer).not.toHaveBeenCalled();
    expect(mocks.updateProvider).not.toHaveBeenCalled();
  });
});
