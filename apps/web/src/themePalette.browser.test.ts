import { converter } from "culori/fn";
import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import "./components/miuix-home.css";
import { getStandardPaintedThemeColors } from "./themePalette";

const toRgb = converter("rgb");

function paintedChannels(variable: string, canvas: readonly number[] = [0, 0, 0]): number[] {
  const probe = document.createElement("div");
  probe.style.backgroundColor = `var(${variable})`;
  document.body.append(probe);
  try {
    const color = toRgb(getComputedStyle(probe).backgroundColor)!;
    const alpha = color.alpha ?? 1;
    return [color.r, color.g, color.b].map(
      (channel, index) => (channel * alpha + (canvas[index]! / 255) * (1 - alpha)) * 255,
    );
  } finally {
    probe.remove();
  }
}

describe("standard painted theme colors", () => {
  it("match the chip surfaces index.css paints", () => {
    const root = document.documentElement;
    try {
      for (const appearance of ["light", "dark"] as const) {
        root.classList.toggle("dark", appearance === "dark");
        const colors = getStandardPaintedThemeColors(appearance);
        const canvas = paintedChannels("--background");
        for (const [variable, role] of [
          ["--background", "canvas"],
          ["--card", "surface"],
          ["--surface-raised", "surfaceRaised"],
          ["--message-surface", "messageSurface"],
        ] as const) {
          const expected = toRgb(colors[role])!;
          const painted = paintedChannels(variable, canvas);
          [expected.r, expected.g, expected.b].forEach((channel, index) => {
            expect(Math.abs(channel * 255 - painted[index]!), `${appearance} ${role}`).toBeLessThan(
              1.5,
            );
          });
        }
      }
    } finally {
      root.classList.remove("dark");
    }
  });
});

it.each(["light", "dark"])(
  "keeps text, surface separation and brightness independent in %s mode",
  (mode) => {
    const root = document.documentElement;
    const panel = document.createElement("aside");
    panel.dataset.appSidebar = "";
    const list = document.createElement("ul");
    list.dataset.sidebarThreadList = "";
    list.dataset.sidebarView = "recent";
    const pin = document.createElement("li");
    pin.dataset.sidebarThreadGroup = "pinned";
    const normal = document.createElement("li");
    normal.dataset.sidebarThreadGroup = "threads";
    const title = document.createElement("span");
    title.dataset.sidebarThreadTitle = "";
    normal.append(title);
    list.append(pin, normal);
    panel.append(list);
    document.body.append(panel);
    const originalDark = root.classList.contains("dark");
    root.classList.toggle("dark", mode === "dark");
    const lightness = (element: Element, property: "backgroundColor" | "color") =>
      converter("oklab")(getComputedStyle(element)[property])!.l;
    try {
      const base = lightness(panel, "backgroundColor");
      const card = lightness(normal, "backgroundColor");
      const text = lightness(title, "color");
      root.style.setProperty("--tone-text", "0.04");
      expect(lightness(title, "color")).toBeGreaterThan(text);
      expect(lightness(panel, "backgroundColor")).toBe(base);
      root.style.setProperty("--tone-separation", "0.04");
      expect(
        lightness(normal, "backgroundColor") - lightness(panel, "backgroundColor"),
      ).toBeGreaterThan(card - base);
      const separated = lightness(panel, "backgroundColor");
      root.style.setProperty("--tone-brightness", "0.05");
      expect(lightness(panel, "backgroundColor")).toBeGreaterThan(separated);
      expect(parseFloat(getComputedStyle(normal).marginBlockStart)).toBeGreaterThan(0);
      pin.remove();
      expect(parseFloat(getComputedStyle(normal).marginBlockStart)).toBe(0);
    } finally {
      panel.remove();
      root.classList.toggle("dark", originalDark);
      for (const name of ["--tone-brightness", "--tone-separation", "--tone-text"])
        root.style.removeProperty(name);
    }
  },
);
