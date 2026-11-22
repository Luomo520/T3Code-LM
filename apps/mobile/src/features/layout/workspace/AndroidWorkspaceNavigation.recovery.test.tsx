import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  selected: "threads",
  settingsOpen: false,
  keyboard: false,
  width: 390,
  leftInset: 0,
  rightInset: 0,
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
  useWindowDimensions: () => ({ width: state.width, height: 844 }),
  StyleSheet: { absoluteFill: {} },
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
    readonly style?: unknown;
    readonly android_ripple?: unknown;
  }) => (
    <button
      aria-label={props.accessibilityLabel}
      aria-selected={props.accessibilityState?.selected}
      onClick={props.onPress}
      data-style={JSON.stringify(
        typeof props.style === "function" ? props.style({ pressed: false }) : props.style,
      )}
      data-native-ripple={JSON.stringify(props.android_ripple)}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: ({ children }: { readonly children?: ReactNode }) => <div>{children}</div> },
  Easing: { out: () => undefined, cubic: () => undefined },
  useAnimatedStyle: () => ({}),
  useReducedMotion: () => false,
  useSharedValue: () => ({ get: () => 0, set: () => undefined }),
  withTiming: () => undefined,
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
  useSafeAreaInsets: () => ({
    top: 24,
    left: state.leftInset,
    right: state.rightInset,
    bottom: 24,
  }),
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
  state.width = 390;
  state.leftInset = 0;
  state.rightInset = 0;
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
it("keeps the dock centered on a narrow screen with an asymmetric inset and the compose button above it", async () => {
  state.width = 320;
  state.leftInset = 32;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  const style = JSON.parse(container.firstElementChild!.getAttribute("data-style")!);
  expect(style.alignItems).toBe("center");
  expect(style.left).toBe(0);
  expect(style.right).toBe(0);
  expect(style.paddingHorizontal).toBe(32);
  expect(style.paddingBottom).toBe(36);
  expect(container.innerHTML).toContain("linear-gradient(to bottom");
  const dock = container.querySelector('[role="tablist"]')!;
  const compose = container.querySelector('[aria-label="新会话"]')!;
  const pill = JSON.parse(dock.getAttribute("data-style")!);
  expect(pill.width).toBe(256);
  expect(pill.height).toBe(60);
  expect(compose.nextElementSibling).toBe(dock);
  expect(JSON.parse(compose.getAttribute("data-style")!).alignSelf).toBe("flex-end");
  for (const tab of dock.querySelectorAll("button")) {
    expect(tab.hasAttribute("data-native-ripple")).toBe(false);
    const circle = JSON.parse(tab.getAttribute("data-style")!);
    expect(circle.width).toBeGreaterThanOrEqual(48);
    expect(circle.height).toBe(circle.width);
    expect(circle.borderRadius).toBe(circle.width / 2);
    expect(circle.overflow).toBe("hidden");
  }
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
  expect(container.querySelector('[aria-label="新会话"]')).toBeNull();
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

it("invokes the compose action once and dismisses the keyboard", async () => {
  const compose = vi.fn();
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={compose} />);
  await act(async () =>
    (container.querySelector('[aria-label="新会话"]') as HTMLButtonElement).click(),
  );
  expect(compose).toHaveBeenCalledOnce();
  expect(state.dismiss).toHaveBeenCalledOnce();
});
it.each(["usage", "pullRequests"])("has no empty compose slot on %s", async (tab) => {
  state.selected = tab;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(container.querySelectorAll("button")).toHaveLength(4);
  expect(container.querySelector('[aria-label="新会话"]')).toBeNull();
  const pill = JSON.parse(container.querySelector('[role="tablist"]')!.getAttribute("data-style")!);
  expect(pill.width).toBe(268);
});
it("hides compose when no environment is connected", async () => {
  state.connected = false;
  const { container } = await mount(<FloatingWorkspaceTabs onNewThread={() => {}} />);
  expect(container.querySelectorAll("button")).toHaveLength(4);
});
