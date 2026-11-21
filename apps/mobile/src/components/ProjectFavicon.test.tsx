import type { ReactNode } from "react";
import { act, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  Passthrough: ({ children }: { children?: unknown }) => children,
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  View: harness.Passthrough,
}));
vi.mock("expo-image", () => ({ Image: () => <img alt="" /> }));
vi.mock("./ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./ui/AppText", () => ({
  AppText: (props: {
    children?: ReactNode;
    adjustsFontSizeToFit?: boolean;
    allowFontScaling?: boolean;
    style?: { width?: number };
  }) => (
    <span
      data-fit={props.adjustsFontSizeToFit}
      data-scale={props.allowFontScaling}
      style={{ width: props.style?.width }}
    >
      {props.children}
    </span>
  ),
}));
vi.mock("../features/settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "light" }),
}));
vi.mock("../state/assets", async () => {
  const { Atom } = await import("effect/reactivity");
  const url = Atom.make<string | null>("https://example.test/favicon.png");
  return { projectFaviconUrlAtom: () => url };
});

import { EnvironmentId } from "@t3tools/contracts";

import { ProjectFavicon } from "./ProjectFavicon";

it("mounts the favicon image in the first commit", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const commits: string[] = [];
  try {
    await act(async () =>
      root.render(
        <Profiler id="favicon" onRender={(_id, phase) => commits.push(phase)}>
          <ProjectFavicon
            environmentId={EnvironmentId.make("env-1")}
            projectTitle="Project"
            workspaceRoot="/repo"
          />
        </Profiler>,
      ),
    );
    expect(container.querySelector("img")).not.toBeNull();
    expect(commits).toEqual(["mount"]);
  } finally {
    await act(async () => root.unmount());
  }
});

it.each(["通用", "WW"])("fits the full Android monogram %s inside the tile", async (monogram) => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ProjectFavicon
          environmentId={EnvironmentId.make("env-1")}
          projectTitle="通用杂项项目"
          projectIcon={{ kind: "monogram", text: monogram, color: "orange" }}
          size={20}
        />,
      ),
    );
    const glyph = container.querySelector("span");
    expect(glyph?.textContent).toBe(monogram);
    expect(glyph?.getAttribute("data-fit")).toBe("true");
    expect(glyph?.getAttribute("data-scale")).toBe("false");
    expect(glyph?.style.width).toBe("20px");
  } finally {
    await act(async () => root.unmount());
  }
});
