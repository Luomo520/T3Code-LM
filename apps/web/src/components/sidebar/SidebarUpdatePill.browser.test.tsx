import { RegistryContext } from "@effect/atom-react";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { UpdateCenter } from "./UpdateCenter";

const mock = vi.hoisted(() => ({
  fixture: null as unknown,
  runServer: vi.fn(),
  runProvider: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("~/env", async (original) => ({
  ...(await original<typeof import("~/env")>()),
  isElectron: false,
}));
vi.mock("~/state/managedPolicy", async (original) => ({
  ...(await original<typeof import("~/state/managedPolicy")>()),
  usePrimaryManagedPolicy: () => undefined,
}));
vi.mock("~/state/environments", async (original) => ({
  ...(await original<typeof import("~/state/environments")>()),
  useEnvironments: () => ({ environments: fixture().environments }),
  useEnvironmentProviders: () => fixture().providers,
}));
vi.mock("~/state/session", async (original) => {
  const actual = await original<typeof import("~/state/session")>();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      initialConfigValueAtom: () => fixture().config,
      sessionStateAtom: () => fixture().session,
    },
    environmentSessionStatesAtom: () => fixture().sessions,
    useEnvironmentsWithScope: (
      environments: ReadonlyArray<{ readonly environmentId: EnvironmentId }>,
      scope: string,
    ) =>
      fixture().scopes.has(scope)
        ? new Set(environments.map(({ environmentId }) => environmentId))
        : new Set(),
  };
});
vi.mock("~/state/threads", async (original) => {
  const actual = await original<typeof import("~/state/threads")>();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      environmentThreadsAtom: () => fixture().threads,
    },
  };
});
vi.mock("~/state/shell", async (original) => ({
  ...(await original<typeof import("~/state/shell")>()),
  liveShellEnvironmentIdsAtom: Atom.make(() => fixture().liveShells),
}));
vi.mock("~/state/server", async (original) => {
  const actual = await original<typeof import("~/state/server")>();
  return {
    ...actual,
    environmentUpdateStatesAtom: () => fixture().updates,
    serverEnvironment: {
      ...actual.serverEnvironment,
      npmRelease: () => fixture().release,
      updateProvider: "provider",
      refreshProviders: "check",
    },
  };
});
vi.mock("~/state/use-atom-command", async (original) => {
  const actual = await original<typeof import("~/state/use-atom-command")>();
  return {
    ...actual,
    useAtomCommand: (command: unknown) =>
      command === "provider" ? mock.runProvider : async () => AsyncResult.success(undefined),
  };
});
vi.mock("../ServerUpdateAction", async (original) => ({
  ...(await original<typeof import("../ServerUpdateAction")>()),
  useServerUpdate: () => mock.runServer,
}));
vi.mock("../ui/toast", async (original) => {
  const actual = await original<typeof import("../ui/toast")>();
  return { ...actual, toastManager: { ...actual.toastManager, add: mock.toast } };
});

const nas = EnvironmentId.make("nas");
const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");

function provider(driver: ProviderDriverKind, manually: boolean): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(driver),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-22T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: manually ? null : "npm install -g @openai/codex",
      canUpdate: !manually,
      checkedAt: "2026-11-22T00:00:00.000Z",
      message: "Update available.",
    },
  };
}

function makeFixture(
  selfUpdate: "boot-service" | "desktop-managed" = "boot-service",
  supportsConfirmed = selfUpdate === "desktop-managed",
) {
  const config = {
    environment: {
      label: "LM-NAS",
      serverVersion: "0.2.2-1",
      capabilities: {
        serverSelfUpdate: selfUpdate,
        npmReleaseLookup: true,
        desktopAppUpdate: selfUpdate === "desktop-managed",
        confirmedDesktopUpdateVersion: supportsConfirmed,
      },
    },
    settings: { continueThreadsAfterServerUpdate: true },
  } as unknown as ServerConfig;
  const session = AsyncResult.success({
    authenticated: true,
    scopes: [AuthEnvironmentMaintainScope, AuthOrchestrationReadScope, AuthProvidersManageScope],
    auth: { serverUpdateScope: AuthEnvironmentMaintainScope },
  });
  return {
    environments: [
      {
        environmentId: nas,
        label: "NAS connection",
        entry: { enabled: true, target: { _tag: "PrimaryConnectionTarget" } },
        connection: { phase: "connected" },
        serverConfig: config,
      },
    ],
    providers: new Map([[nas, [provider(codex, false), provider(claude, true)]]]),
    config: Atom.make(config),
    session: Atom.make(session),
    sessions: Atom.make([session]),
    release: Atom.make(AsyncResult.success({ version: "0.2.2-2" })),
    scopes: new Set<string>([
      AuthEnvironmentMaintainScope,
      AuthOrchestrationReadScope,
      AuthProvidersManageScope,
    ]),
    liveShells: new Set([nas]),
    threads: Atom.make([{ status: "running" }, { status: "idle" }]),
    updates: Atom.make([{ status: "idle" }] as const),
  };
}

function fixture() {
  return mock.fixture as ReturnType<typeof makeFixture>;
}

function setup(...configuration: Parameters<typeof makeFixture>): Disposable {
  mock.fixture = makeFixture(...configuration);
  mock.toast.mockClear();
  mock.runServer.mockReset().mockResolvedValue({ status: "updated" });
  mock.runProvider.mockReset().mockImplementation(async () =>
    AsyncResult.success({
      providers: [
        {
          ...provider(codex, false),
          updateState: { status: "succeeded", message: null },
        },
      ],
    }),
  );
  return {
    [Symbol.dispose]: () => {
      mock.fixture = null;
    },
  };
}

function mount(about = false) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>
      {about ? <UpdateCenter surface="about" /> : <SidebarUpdatePill />}
    </RegistryContext.Provider>,
  );
}

async function openShortcut() {
  await userEvent.click(page.getByRole("button", { name: "更新 2" }));
  await expect.element(page.getByText("更新中心", { exact: true })).toBeVisible();
}

describe("更新中心", () => {
  it("按设备显示版本及手动 CLI，取消确认不调用更新", async () => {
    using _fixture = setup();
    await using _screen = await mount();
    await openShortcut();
    await expect.element(page.getByRole("heading", { name: "LM-NAS" })).toBeVisible();
    await expect.element(page.getByText("Claude Code", { exact: false })).toBeVisible();
    await expect.element(page.getByText("需手动更新", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("checkbox", { name: "Claude Code" }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("0.2.2-1", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0.2.2-2", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("checkbox", { name: "T3 服务端" }));
    await userEvent.click(page.getByRole("button", { name: "更新所选项" }));
    await expect
      .element(
        page.getByText("服务端将重启。1 个运行中的会话将被中断。重连后可恢复其中 1 个会话。"),
      )
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "取消", exact: true }));
    await expect.element(page.getByText("确认更新", { exact: true })).not.toBeInTheDocument();
    expect(mock.runServer).not.toHaveBeenCalled();
    expect(mock.runProvider).not.toHaveBeenCalled();
  });

  it("快捷入口仅向选中的 Codex CLI 发送更新", async () => {
    using _fixture = setup();
    await using _screen = await mount();
    await openShortcut();
    await userEvent.click(page.getByRole("checkbox", { name: "Codex CLI" }));
    await userEvent.click(page.getByRole("button", { name: "更新所选项" }));
    await expect.element(page.getByText(/无需重启。0 个运行中的会话将被中断/)).toBeVisible();
    await expect.element(page.getByText(/安装时将重新核对最新兼容版本/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "确认更新", exact: true }));
    await vi.waitFor(() =>
      expect(mock.runProvider).toHaveBeenCalledExactlyOnceWith({
        environmentId: nas,
        input: { provider: codex, instanceId: ProviderInstanceId.make("codex") },
      }),
    );
    expect(mock.runServer).not.toHaveBeenCalled();
    await expect.element(page.getByText("已完成所选更新")).toBeVisible();
  });

  it("关于只更新所选服务端，重连后显示设备报告的版本", async () => {
    using _fixture = setup();
    await using screen = await mount(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "T3 服务端" }));
    await userEvent.click(screen.getByRole("button", { name: "更新所选项" }));
    await userEvent.click(screen.getByRole("button", { name: "确认更新", exact: true }));
    await vi.waitFor(() =>
      expect(mock.runServer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ environmentId: nas, targetVersion: "0.2.2-2" }),
        { quiet: true },
      ),
    );
    expect(mock.runProvider).not.toHaveBeenCalled();
    await expect.element(screen.getByText("已完成所选更新")).toBeVisible();
    await act(() => {
      const current = appAtomRegistry.get(fixture().config);
      appAtomRegistry.set(fixture().config, {
        ...current,
        environment: { ...current.environment, serverVersion: "0.2.2-2" },
      });
    });
    await userEvent.click(screen.getByRole("button", { name: "完成", exact: true }));
    await expect.element(screen.getByText("0.2.2-2", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("checkbox", { name: "T3 服务端" }))
      .not.toBeInTheDocument();
  });

  it("远端桌面确认列出托管后端影响，提交时要求目标版本匹配", async () => {
    using _fixture = setup("desktop-managed");
    await using screen = await mount(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "T3 桌面端与服务端" }));
    await userEvent.click(screen.getByRole("button", { name: "更新所选项" }));
    const impact = screen.getByText(/该电脑上的桌面端及其托管的所有后端将重启/);
    await expect.element(impact).toBeVisible();
    expect(impact.element().textContent).toContain("当前连接中，1 个运行中的会话将被中断");
    expect(impact.element().textContent).toContain("其他后端受影响的会话数未知");
    await userEvent.click(screen.getByRole("button", { name: "确认更新", exact: true }));
    await vi.waitFor(() =>
      expect(mock.runServer).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ targetVersion: "0.2.2-2", requireConfirmedDesktopVersion: true }),
        { quiet: true },
      ),
    );
    await expect.element(screen.getByText("已完成所选更新")).toBeVisible();
    expect(mock.runProvider).not.toHaveBeenCalled();
  });

  it("旧远端桌面保留更新，并说明目标版本仅供参考", async () => {
    using _fixture = setup("desktop-managed", false);
    await using screen = await mount(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "T3 桌面端与服务端" }));
    await userEvent.click(screen.getByRole("button", { name: "更新所选项" }));
    await expect.element(screen.getByText(/所示目标版本供参考/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "确认更新", exact: true }));
    await vi.waitFor(() => expect(mock.runServer).toHaveBeenCalledOnce());
    expect(mock.runServer.mock.calls[0]?.[0]).not.toHaveProperty("requireConfirmedDesktopVersion");
    await expect.element(screen.getByText("已完成所选更新")).toBeVisible();
  });

  it("保留只读设备版本及已安装但版本未知的 CLI", async () => {
    using _fixture = setup();
    fixture().scopes.delete(AuthEnvironmentMaintainScope);
    fixture().scopes.delete(AuthProvidersManageScope);
    fixture().providers.set(nas, [{ ...provider(codex, true), version: null }]);
    await using screen = await mount(true);
    await expect.element(screen.getByText("0.2.2-1", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("当前连接没有维护权限")).toBeVisible();
    await expect.element(screen.getByText("当前连接没有 CLI 管理权限")).toBeVisible();
    await expect.element(screen.getByRole("checkbox")).not.toBeInTheDocument();
  });

  it("在会话列表尚未就绪时将重启影响人数标记为未知", async () => {
    using _fixture = setup();
    fixture().liveShells.clear();
    await using screen = await mount(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "T3 服务端" }));
    await userEvent.click(screen.getByRole("button", { name: "更新所选项" }));
    await expect.element(screen.getByText(/暂无法确认受影响的会话数/)).toBeVisible();
  });

  it.each([320, 1280])("在 %i px 视窗内保留完整确认提示与按钮", async (width) => {
    using _fixture = setup();
    const previous = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, 760);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
    };
    const container = document.createElement("div");
    container.className = "fixed right-2 bottom-2";
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <SidebarUpdatePill />
      </RegistryContext.Provider>,
      { container },
    );
    await openShortcut();
    if (import.meta.env.VITE_UPDATE_CENTER_SCREENSHOTS === "1") {
      await page.screenshot({ path: `__screenshots__/update-center-${width}-selection.png` });
    }
    await userEvent.click(page.getByRole("checkbox", { name: "T3 服务端" }));
    await userEvent.click(page.getByRole("button", { name: "更新所选项" }));
    const confirm = page.getByRole("button", { name: "确认更新", exact: true });
    await expect.element(confirm).toBeVisible();
    const dialog = page.getByRole("dialog", { name: "确认更新" }).element();
    const rect = dialog.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(dialog.scrollWidth).toBe(dialog.clientWidth);
    if (import.meta.env.VITE_UPDATE_CENTER_SCREENSHOTS === "1") {
      await page.screenshot({ path: `__screenshots__/update-center-${width}-confirm.png` });
    }
  });

  it.each(["目标版本", "设备能力"])("确认期间%s变化会阻止提交", async (changed) => {
    using _fixture = setup("desktop-managed");
    await using screen = await mount(true);
    await userEvent.click(screen.getByRole("checkbox", { name: "T3 桌面端与服务端" }));
    await userEvent.click(screen.getByRole("button", { name: "更新所选项" }));
    await act(() => {
      if (changed === "目标版本") {
        appAtomRegistry.set(fixture().release, AsyncResult.success({ version: "0.2.2-3" }));
      } else {
        const previous = appAtomRegistry.get(fixture().config);
        const next = {
          ...previous,
          environment: {
            ...previous.environment,
            capabilities: {
              ...previous.environment.capabilities,
              confirmedDesktopUpdateVersion: false,
            },
          },
        };
        fixture().environments[0]!.serverConfig = next;
        appAtomRegistry.set(fixture().config, next);
      }
    });
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("可更新版本或设备连接已变化，请返回重新选择。");
    await expect
      .element(screen.getByRole("button", { name: "确认更新", exact: true }))
      .toBeDisabled();
    expect(mock.runServer).not.toHaveBeenCalled();
  });
});
