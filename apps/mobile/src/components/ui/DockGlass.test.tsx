import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  listeners: new Set<(value: boolean) => void>(),
  appearance: "light" as "light" | "dark",
  glassEnabled: true,
  preferencesReady: true,
  platform: "android" as "android" | "ios",
  resolve: undefined as ((value: boolean) => void) | undefined,
  reject: undefined as (() => void) | undefined,
}));
vi.mock("expo-blur", () => {
  throw new Error("Recovery must not load native blur");
});
vi.mock("react-native", async () => {
  const { forwardRef } = await import("react");
  return {
    StyleSheet: { absoluteFill: { position: "absolute", inset: 0 } },
    Platform: {
      get OS() {
        return native.platform;
      },
    },
    processColor: () => 1,
    View: forwardRef<
      HTMLDivElement,
      { children?: ReactNode; testID?: string; style?: unknown; nativeID?: string }
    >((props, ref) => (
      <div
        ref={ref}
        id={props.nativeID}
        data-testid={props.testID}
        data-style={JSON.stringify(props.style)}
      >
        {props.children}
      </div>
    )),
    AccessibilityInfo: {
      isReduceTransparencyEnabled: () =>
        new Promise<boolean>((resolve, reject) => {
          native.resolve = resolve;
          native.reject = () => reject(new Error("unavailable"));
        }),
      isHighTextContrastEnabled: () =>
        new Promise<boolean>((resolve, reject) => {
          native.resolve = resolve;
          native.reject = () => reject(new Error("unavailable"));
        }),
      addEventListener: (_name: string, listener: (value: boolean) => void) => {
        native.listeners.add(listener);
        return { remove: () => native.listeners.delete(listener) };
      },
    },
  };
});
vi.mock("../../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({
    dockGlassEnabled: native.glassEnabled,
    isReady: native.preferencesReady,
    themeAppearance: native.appearance,
    themeVariables: { "--color-screen": native.appearance === "dark" ? "#191a1d" : "#f7f7f8" },
  }),
}));
vi.mock("../../lib/mobileTheme", () => ({
  themeColorWithAlpha: (color: string, alpha: number) => `${color}:${alpha}`,
}));
vi.mock("../../native/AndroidDockSample", () => ({
  AndroidDockSample: ({ targetNativeId }: { targetNativeId: string }) => (
    <div data-sample={targetNativeId} />
  ),
}));
import {
  DockGlassBackdrop,
  DockGlassCapture,
  DockGlassProvider,
  DockGlassSamplingScope,
} from "./DockGlass";

const roots: Root[] = [];
async function mount(element: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return { container, root };
}
function scene() {
  return (
    <DockGlassProvider>
      <DockGlassCapture scope="workspace" testID="workspace">
        <DockGlassCapture scope="thread" testID="thread">
          消息
        </DockGlassCapture>
        <DockGlassBackdrop scope="thread" />
      </DockGlassCapture>
      <DockGlassBackdrop scope="workspace" />
    </DockGlassProvider>
  );
}
function tint(container: HTMLElement, value: string) {
  return [...container.querySelectorAll("[data-style]")].some((node) =>
    node.getAttribute("data-style")?.includes(value),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  native.appearance = "light";
  native.glassEnabled = true;
  native.preferencesReady = true;
  native.platform = "android";
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  native.listeners.clear();
});
it("mounts nested content while awaiting the Android accessibility preference", async () => {
  const { container } = await mount(scene());
  expect(
    container.querySelector('[data-testid="workspace"] [data-testid="thread"]')?.textContent,
  ).toBe("消息");
  expect(tint(container, "#f7f7f8:1")).toBe(true);
});
it("keeps a readable semi-transparent material when OS transparency is enabled", async () => {
  const { container } = await mount(scene());
  await act(async () => native.resolve?.(false));
  expect(tint(container, "#f7f7f8:0.88")).toBe(true);
});
it("obeys reduce transparency without creating native views", async () => {
  const { container } = await mount(scene());
  await act(async () => native.resolve?.(false));
  act(() => {
    for (const listener of native.listeners) listener(true);
  });
  expect(tint(container, "#f7f7f8:1")).toBe(true);
});
it("does not overwrite a newer accessibility event with an older async result", async () => {
  const { container } = await mount(scene());
  act(() => {
    for (const listener of native.listeners) listener(true);
  });
  await act(async () => native.resolve?.(false));
  expect(tint(container, "#f7f7f8:1")).toBe(true);
});
it("uses opaque material if the OS setting fails", async () => {
  const { container } = await mount(scene());
  await act(async () => native.reject?.());
  expect(tint(container, "#f7f7f8:1")).toBe(true);
});
it("updates material with the theme and retains the screen content", async () => {
  const page = await mount(scene());
  await act(async () => native.resolve?.(false));
  native.appearance = "dark";
  await act(async () => page.root.render(scene()));
  expect(tint(page.container, "#191a1d:0.9")).toBe(true);
  expect(page.container.querySelector('[data-testid="thread"]')?.textContent).toBe("消息");
});
it("removes the accessibility subscription when the provider unmounts", async () => {
  const { root } = await mount(scene());
  expect(native.listeners.size).toBe(1);
  roots.splice(roots.indexOf(root), 1);
  await act(async () => root.unmount());
  expect(native.listeners.size).toBe(0);
  await act(async () => native.resolve?.(false));
});

it("uses a translucent material without an eligible capture target", async () => {
  const { container } = await mount(
    <DockGlassProvider>
      <DockGlassBackdrop scope="workspace" material="navigation" />
    </DockGlassProvider>,
  );
  await act(async () => native.resolve?.(false));
  expect(tint(container, "#f7f7f8:0.84")).toBe(true);
});

it.each(["light", "dark"] as const)(
  "gives the two docks a continuous %s outline",
  async (theme) => {
    native.appearance = theme;
    const { container } = await mount(
      <DockGlassProvider>
        <DockGlassBackdrop scope="workspace" material="navigation" borderRadius={24} />
        <DockGlassBackdrop scope="thread" borderRadius={22} />
      </DockGlassProvider>,
    );
    const color = theme === "dark" ? "rgba(255,255,255,0.13)" : "rgba(26,32,46,0.08)";
    const outlines = [...container.querySelectorAll("[data-style]")]
      .map((node) => node.getAttribute("data-style") ?? "")
      .filter((style) => style.includes("borderWidth"));
    expect(outlines).toHaveLength(2);
    for (const outline of outlines) {
      expect(outline).toContain(`"borderColor":"${color}"`);
      expect(outline).not.toContain("borderTopColor");
    }
  },
);

function samplingScene() {
  return (
    <DockGlassProvider>
      <DockGlassSamplingScope>
        <DockGlassCapture scope="workspace" testID="scene">
          会话
        </DockGlassCapture>
        <DockGlassBackdrop scope="workspace" material="navigation" sample />
        <DockGlassBackdrop scope="thread" sample />
      </DockGlassSamplingScope>
    </DockGlassProvider>
  );
}

it("binds the navigation backdrop to its sibling content after accessibility resolves", async () => {
  const { container } = await mount(samplingScene());
  const source = container.querySelector('[data-testid="scene"]')!;
  expect(container.querySelector("[data-sample]")).toBeNull();
  await act(async () => native.resolve?.(false));
  expect(source.id).toBeTruthy();
  expect(container.querySelector("[data-sample]")?.getAttribute("data-sample")).toBe(source.id);
  expect(tint(container, "#f7f7f8:0.56")).toBe(true);
  expect(container.querySelectorAll("[data-sample]")).toHaveLength(1);
});

it("switches the capsule to solid without remounting content and restores sampling", async () => {
  const page = await mount(samplingScene());
  await act(async () => native.resolve?.(false));
  const source = page.container.querySelector('[data-testid="scene"]');
  native.glassEnabled = false;
  await act(async () => page.root.render(samplingScene()));
  expect(page.container.querySelector("[data-sample]")).toBeNull();
  expect(tint(page.container, "#f7f7f8:1")).toBe(true);
  native.glassEnabled = true;
  await act(async () => page.root.render(samplingScene()));
  expect(page.container.querySelector("[data-sample]")).toBeTruthy();
  expect(page.container.querySelector('[data-testid="scene"]')).toBe(source);
});

it("keeps the first frame solid until saved preferences are available", async () => {
  native.preferencesReady = false;
  const page = await mount(samplingScene());
  await act(async () => native.resolve?.(false));
  expect(page.container.querySelector("[data-sample]")).toBeNull();
  native.preferencesReady = true;
  native.glassEnabled = false;
  await act(async () => page.root.render(samplingScene()));
  expect(page.container.querySelector("[data-sample]")).toBeNull();
  expect(tint(page.container, "#f7f7f8:1")).toBe(true);
});
