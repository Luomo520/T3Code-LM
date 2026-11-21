import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  listeners: new Set<(value: boolean) => void>(),
  appearance: "light" as "light" | "dark",
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
    View: forwardRef<HTMLDivElement, { children?: ReactNode; testID?: string; style?: unknown }>(
      (props, ref) => (
        <div ref={ref} data-testid={props.testID} data-style={JSON.stringify(props.style)}>
          {props.children}
        </div>
      ),
    ),
    AccessibilityInfo: {
      isReduceTransparencyEnabled: () =>
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
    themeAppearance: native.appearance,
    themeVariables: { "--color-screen": native.appearance === "dark" ? "#191a1d" : "#f7f7f8" },
  }),
}));
vi.mock("../../lib/mobileTheme", () => ({
  themeColorWithAlpha: (color: string, alpha: number) => `${color}:${alpha}`,
}));
import { DockGlassBackdrop, DockGlassCapture, DockGlassProvider } from "./DockGlass";

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
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
  native.listeners.clear();
});
it("mounts nested navigation content without loading any native blur module", async () => {
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

it("uses a nearly opaque navigation material so unblurred rows cannot compete with icons", async () => {
  const { container } = await mount(
    <DockGlassProvider>
      <DockGlassBackdrop scope="workspace" material="navigation" />
    </DockGlassProvider>,
  );
  await act(async () => native.resolve?.(false));
  expect(tint(container, "#f7f7f8:0.98")).toBe(true);
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
