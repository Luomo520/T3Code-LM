import { act, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const sample = vi.hoisted(() => ({ floating: true }));
vi.mock("react-native", () => ({
  useWindowDimensions: () => ({ fontScale: 1 }),
  View: (props: { children?: ReactNode; onLayout?: (event: unknown) => void }) => {
    useEffect(() => {
      props.onLayout?.({ nativeEvent: { layout: { width: 390 } } });
    }, []);
    return <div>{props.children}</div>;
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, left: 0, right: 0, bottom: 24 }),
}));
vi.mock("../../components/ScrollComposeButton.android", () => ({
  ScrollComposeButton: () => <button data-old-fab="true">新建任务</button>,
}));
vi.mock("../../state/workspace", () => ({
  useWorkspaceState: () => ({ state: { hasConnections: true } }),
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, fabSize: 56 }),
}));
vi.mock("../layout/workspace/WorkspaceTabsContext", async () => {
  const { createContext } = await import("react");
  return {
    WorkspaceTabsContext: createContext({}),
    useWorkspaceTabs: () => ({ bottomClearance: 0 }),
  };
});
vi.mock("../layout/workspace/navigation-tabs", () => ({
  useEnabledNavigationTabs: () => ["threads", "pullRequests", "usage"],
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAndroidFloatingTabs: () => sample.floating,
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 16 } }),
}));
import { AndroidHomeFabLayout } from "./AndroidHomeFab.android";
const roots: Root[] = [];
async function mount(sidebar = false, disabled = false) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <AndroidHomeFabLayout sidebar={sidebar} disabled={disabled} onStartNewTask={() => {}}>
        <span>列表</span>
      </AndroidHomeFabLayout>,
    ),
  );
  return container;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sample.floating = true;
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});
it.each([false, true])(
  "does not duplicate the dock compose action in floating sidebar=%s",
  async (sidebar) => {
    const page = await mount(sidebar);
    expect(page.querySelector('[data-old-fab="true"]')).toBeNull();
    expect(page.textContent).toBe("列表");
  },
);
it("retains the existing separate compose action for Material navigation", async () => {
  sample.floating = false;
  expect((await mount()).querySelector('[data-old-fab="true"]')).not.toBeNull();
});
it("keeps the existing disabled action hidden", async () => {
  sample.floating = false;
  expect((await mount(false, true)).querySelector('[data-old-fab="true"]')).toBeNull();
});
