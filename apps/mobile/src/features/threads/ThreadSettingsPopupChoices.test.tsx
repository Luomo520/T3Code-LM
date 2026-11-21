import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  back: undefined as (() => void) | undefined,
}));

vi.mock("react-native", async () => {
  const { forwardRef, useImperativeHandle, useLayoutEffect } = await import("react");
  const View = forwardRef<
    { measureInWindow: (report: (...position: number[]) => void) => void },
    { children?: ReactNode; onLayout?: () => void; style?: unknown }
  >((props, ref) => {
    useImperativeHandle(ref, () => ({
      measureInWindow: (report) => report(8, 24, 304, 248),
    }));
    useLayoutEffect(() => props.onLayout?.(), []);
    return <div data-style={JSON.stringify(props.style)}>{props.children}</div>;
  });
  return {
    View,
    Modal: (props: { children?: ReactNode; onRequestClose: () => void }) => {
      native.back = props.onRequestClose;
      return <div role="dialog">{props.children}</div>;
    },
    Pressable: (props: {
      children?: ReactNode;
      accessibilityRole?: string;
      accessibilityState?: { checked: boolean };
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button
        role={props.accessibilityRole}
        aria-checked={props.accessibilityState?.checked}
        onClick={props.onPress}
        disabled={props.disabled}
      >
        {props.children}
      </button>
    ),
    ScrollView: (props: { children?: ReactNode; accessibilityLabel?: string }) => (
      <div role="radiogroup" aria-label={props.accessibilityLabel}>
        {props.children}
      </div>
    ),
    useWindowDimensions: () => ({ width: 320, height: 300 }),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 28, left: 8, right: 8 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children?: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: (props: { name: string }) => <span data-symbol={props.name} />,
}));
vi.mock("../../components/ui/DockGlass", () => ({
  DockGlassBackdrop: () => null,
}));
vi.mock("../../lib/appState", () => ({ useReduceMotionEnabled: () => true }));
vi.mock("./ReasoningSlider", () => ({
  useModelPopupColors: () => ({
    panel: "#fff",
    border: "#ccc",
    selected: "#eee",
    text: "#111",
    muted: "#444",
  }),
}));

import { PopupChoice, PopupChoicesDialog } from "./ThreadSettingsPopupChoices";

const roots: Root[] = [];

function mount(scene: ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(scene));
  return container;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  native.back = undefined;
  vi.unstubAllGlobals();
});

function DefaultChoicesScene() {
  const [modelDefault, setModelDefault] = useState("High");
  const [open, setOpen] = useState(true);
  return (
    <>
      <input aria-label="当前会话档位" defaultValue="Medium" />
      <button onClick={() => setOpen(true)}>{modelDefault}</button>
      {open ? (
        <PopupChoicesDialog title="默认思考强度" onClose={() => setOpen(false)}>
          {["使用供应商默认", "Low", "Medium", "High", "Max"].map((choice) => (
            <PopupChoice
              key={choice}
              label={choice}
              selected={choice === modelDefault}
              onPress={() => {
                setModelDefault(choice);
                setOpen(false);
              }}
            />
          ))}
        </PopupChoicesDialog>
      ) : null}
    </>
  );
}

it("lets a short model popup scroll to its last choice and closes only the top layer", () => {
  const scene = mount(<DefaultChoicesScene />);
  const sessionSetting = scene.querySelector("input");
  const dialog = scene.querySelector('[role="dialog"]');
  const options = dialog?.querySelector('[role="radiogroup"]');
  expect(dialog?.querySelector('[data-style*="maxHeight"]')?.getAttribute("data-style")).toContain(
    '"maxHeight":224',
  );
  expect(options?.querySelector('[aria-checked="true"]')?.textContent).toBe("High");
  act(() => options?.querySelectorAll("button")[4]?.click());
  expect(scene.querySelector('[role="dialog"]')).toBeNull();
  expect(scene.querySelector("button")?.textContent).toBe("Max");
  expect(scene.querySelector("input")).toBe(sessionSetting);
  expect(sessionSetting?.value).toBe("Medium");

  act(() => scene.querySelector("button")?.click());
  expect(scene.querySelector('[aria-checked="true"]')?.textContent).toBe("Max");
  act(() => native.back?.());
  expect(scene.querySelector('[role="dialog"]')).toBeNull();
  expect(scene.querySelector("input")).toBe(sessionSetting);
});

it("anchors the permission menu and renders descriptions beside each row's selection", () => {
  const scene = mount(
    <PopupChoicesDialog
      title="权限"
      anchor={{ x: 244, y: 52, width: 56, height: 48 }}
      onClose={vi.fn()}
    >
      <PopupChoice
        label="完全访问"
        description="无需提示即可执行命令和编辑。"
        showDescription
        selected
        onPress={vi.fn()}
      />
      <PopupChoice
        label="需确认"
        description="执行命令和更改文件前先询问。"
        showDescription
        selected={false}
        onPress={vi.fn()}
      />
    </PopupChoicesDialog>,
  );
  expect(scene.querySelector('[data-style*="maxHeight"]')?.getAttribute("data-style")).toContain(
    '"top":82',
  );
  const selected = scene.querySelector('[aria-checked="true"]');
  expect(selected?.textContent).toBe("完全访问无需提示即可执行命令和编辑。");
  expect(selected?.querySelector('[data-symbol="checkmark"]')).not.toBeNull();
  expect(scene.querySelector('[aria-checked="false"]')?.textContent).toBe(
    "需确认执行命令和更改文件前先询问。",
  );
});
