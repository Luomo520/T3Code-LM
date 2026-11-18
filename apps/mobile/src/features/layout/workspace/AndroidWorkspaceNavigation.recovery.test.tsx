import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  selected: "threads",
  settingsOpen: false,
  keyboard: false,
  connected: true,
  dispatch: vi.fn(),
  navigate: vi.fn(),
  nativeRenders: vi.fn(),
  dismiss: vi.fn(),
  refreshKeyboard: vi.fn(),
  focusEffects: new Set<() => void>(),
}));
vi.mock("expo", () => ({
  requireNativeView: () => () => {
    state.nativeRenders();
    return <div data-native="true" />;
  },
}));
vi.mock("react-native", () => ({
  Keyboard: { dismiss: state.dismiss },
  processColor: () => 1,
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  View: (props: { children?: ReactNode; style?: unknown; accessibilityRole?: string }) => (
    <div role={props.accessibilityRole} data-style={JSON.stringify(props.style)}>
      {props.children}
    </div>
  ),
  Pressable: (props: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
    accessibilityState?: { selected?: boolean };
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-selected={props.accessibilityState?.selected}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("@tabler/icons-react-native/IconMessages", () => ({ default: () => <svg /> }));
vi.mock("@tabler/icons-react-native/IconGitPullRequest", () => ({ default: () => <svg /> }));
vi.mock("@tabler/icons-react-native/IconChartBar", () => ({ default: () => <svg /> }));
vi.mock("@tabler/icons-react-native/IconEdit", () => ({ default: () => <svg /> }));
vi.mock("../../../lib/mobileTheme", () => ({
  themeColorWithAlpha: (color: string, alpha: number) => `${color}:${alpha}`,
}));
vi.mock("@tabler/icons-react-native/IconSettings", () => ({ default: () => <svg /> }));
vi.mock("@react-navigation/native", () => ({
  CommonActions: { reset: (value: unknown) => ({ type: "RESET", payload: value }) },
  useNavigation: () => ({ dispatch: state.navigate }),
  useFocusEffect: (effect: () => void) => {
    state.focusEffects.add(effect);
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, left: 0, right: 0, bottom: 24 }),
}));
vi.mock("../../../components/ui/DockGlass", () => ({
  DockGlassBackdrop: () => <div data-material="true" />,
}));
vi.mock("../../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, fabSize: 56 }),
}));
vi.mock("../../../components/ui/useToolbarLayout", () => ({
  useToolbarLayout: () => ({ paddingTop: 24, height: 56 }),
}));
vi.mock("../../../lib/rootNavigation", () => ({
  rootNavigationRef: { getRootState: () => ({ index: 0, routes: [{ name: "Home" }] }) },
}));
vi.mock("../../../state/workspace", () => ({
  useWorkspaceConnectionState: () => ({ hasConnections: state.connected }),
}));
vi.mock("./android-workspace-navigation-colors", () => ({
  androidWorkspaceNavigationColors: () => ({
    containerColor: "#fff",
    selectedColor: "#111",
    unselectedColor: "#333",
    indicatorColor: "#ddd",
  }),
}));
vi.mock("./android-workspace-tabs", () => ({
  androidWorkspaceTabNavigationState: (_: unknown, tab: string) => ({ selectedTab: tab }),
}));
vi.mock("../../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    themeAppearance: "light",
    themeVariables: {
      "--color-screen": "#111",
      "--color-primary": "#36f",
      "--color-primary-foreground": "#fff",
    },
  }),
}));
vi.mock("../../keyboard/useSoftKeyboardShowing", () => ({
  useSoftKeyboardShowing: () => state.keyboard,
  refreshSoftKeyboardShowing: state.refreshKeyboard,
}));
vi.mock("../adaptive-workspace-context", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./AndroidWorkspaceTabsProvider", () => ({
  useAndroidWorkspaceRoot: () => ({ key: "root", settingsOpen: state.settingsOpen }),
}));
vi.mock("./navigation-tabs", () => ({
  useNavigationTabOrder: () => ["threads", "pullRequests", "usage"],
  useHiddenNavigationTabs: () => [],
}));
vi.mock("./WorkspaceTabsContext", () => ({
  useWorkspaceTabs: () => ({ state: { selectedTab: state.selected }, dispatch: state.dispatch }),
}));
import {
  AndroidWorkspaceNavigation,
  FloatingWorkspaceTabs,
} from "./AndroidWorkspaceNavigation.android";
const roots: Root[] = [];
async function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { root, container };
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.selected = "threads";
  state.keyboard = false;
  state.connected = true;
  state.settingsOpen = false;
  state.focusEffects.clear();
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});
it("boots directly into the saved floating style without mounting native Compose", async () => {
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(state.nativeRenders).not.toHaveBeenCalled();
  expect(container.querySelectorAll("button")).toHaveLength(5);
  expect(container.querySelector('[aria-label="会话"]')?.getAttribute("aria-selected")).toBe(
    "true",
  );
  expect(container.querySelector('[data-material="true"]')).not.toBeNull();
});
it("centers a single compact navigation and compose group above the bottom safe area", async () => {
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  const style = JSON.parse(container.firstElementChild!.getAttribute("data-style")!);
  expect(style.alignItems).toBe("center");
  expect(style.left).toBe(0);
  expect(style.right).toBe(0);
  expect(style.paddingLeft).toBe(16);
  expect(style.paddingRight).toBe(16);
  expect(style.paddingBottom).toBe(36);
  expect(container.innerHTML).toContain("linear-gradient(to bottom");
  const pill = JSON.parse(container.querySelector('[role="tablist"]')!.getAttribute("data-style")!);
  expect(pill.width).toBe(232);
  expect(pill.height).toBe(56);
});
it("preserves tab selection and root navigation reset", async () => {
  const onSelect = vi.fn();
  const { container } = await mount(
    <AndroidWorkspaceNavigation floating onNewThread={() => {}} onSelect={onSelect} />,
  );
  await act(async () =>
    (container.querySelector('[aria-label="用量"]') as HTMLButtonElement).click(),
  );
  expect(state.dispatch).toHaveBeenCalledWith({ type: "select", tab: "usage" });
  expect(state.navigate).toHaveBeenCalledWith({
    type: "RESET",
    payload: { selectedTab: "usage" },
    target: "root",
  });
  expect(onSelect).toHaveBeenCalledOnce();
  expect(state.dismiss).toHaveBeenCalledOnce();
});
it("opens settings without changing the selected workspace tab", async () => {
  state.settingsOpen = true;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(container.querySelector('[aria-label="新建任务"]')).toBeNull();
  expect(container.querySelectorAll("button")).toHaveLength(4);
  expect(container.querySelector('[aria-label="设置"]')?.getAttribute("aria-selected")).toBe(
    "true",
  );
  await act(async () =>
    (container.querySelector('[aria-label="设置"]') as HTMLButtonElement).click(),
  );
  expect(state.dispatch).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith(
    expect.objectContaining({ payload: { selectedTab: "settings" } }),
  );
});
it("hides floating navigation for the keyboard and remounts safely", async () => {
  const page = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  state.keyboard = true;
  await act(async () => page.root.render(<FloatingWorkspaceTabs onNewThread={() => {}} />));
  expect(page.container.querySelectorAll("button")).toHaveLength(0);
  state.keyboard = false;
  await act(async () => page.root.render(<FloatingWorkspaceTabs onNewThread={() => {}} />));
  expect(page.container.querySelectorAll("button")).toHaveLength(5);
  expect(state.nativeRenders).not.toHaveBeenCalled();
});
it("refreshes keyboard visibility when navigation regains focus even while the dock is hidden", async () => {
  state.keyboard = true;
  const page = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(page.container.querySelectorAll("button")).toHaveLength(0);
  for (const refresh of state.focusEffects) refresh();
  expect(state.refreshKeyboard).toHaveBeenCalledOnce();
});
it("retains the existing native Material navigation path", async () => {
  const page = await mount(<AndroidWorkspaceNavigation onNewThread={() => {}} />);
  expect(page.container.querySelector('[data-native="true"]')).not.toBeNull();
  await act(async () =>
    page.root.render(<AndroidWorkspaceNavigation floating onNewThread={() => {}} />),
  );
  expect(page.container.querySelector('[data-native="true"]')).toBeNull();
  expect(page.container.querySelectorAll("button")).toHaveLength(5);
});

it("invokes the integrated compose action once and dismisses the keyboard", async () => {
  const compose = vi.fn();
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={compose} />);
  await act(async () =>
    (container.querySelector('[aria-label="新建任务"]') as HTMLButtonElement).click(),
  );
  expect(compose).toHaveBeenCalledOnce();
  expect(state.dismiss).toHaveBeenCalledOnce();
});
it.each(["usage", "pullRequests"])("has no empty compose slot on %s", async (tab) => {
  state.selected = tab;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(container.querySelectorAll("button")).toHaveLength(4);
  expect(container.querySelector('[aria-label="新建任务"]')).toBeNull();
  const pill = JSON.parse(container.querySelector('[role="tablist"]')!.getAttribute("data-style")!);
  expect(pill.width).toBe(232);
});
it("hides compose when no environment is connected", async () => {
  state.connected = false;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(container.querySelectorAll("button")).toHaveLength(4);
});
