import { describe, expect, it, vi } from "vite-plus/test";

import { createTitlebarWindowDrag, type DraggableWindow } from "./TitlebarWindowDrag.ts";

function setup() {
  const cursor = { x: -900, y: 130 };
  const window: DraggableWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isFullScreen: () => false,
    isMovable: () => true,
    isMaximized: () => false,
    getBounds: () => ({ x: -1200, y: 100, width: 1000, height: 700 }),
    getNormalBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }),
    unmaximize: vi.fn(),
    setBounds: vi.fn(),
  };
  return { cursor, window, drag: createTitlebarWindowDrag(() => ({ ...cursor })) };
}

describe("titlebar window drag", () => {
  it("moves by actual cursor DIP deltas across a monitor with negative coordinates", () => {
    const { cursor, window, drag } = setup();
    drag(window, "begin");
    cursor.x += 240;
    cursor.y += 60;
    drag(window, "move");
    expect(window.setBounds).toHaveBeenLastCalledWith({
      x: -960,
      y: 160,
      width: 1000,
      height: 700,
    });
    drag(window, "end");
    drag(window, "move");
    expect(window.setBounds).toHaveBeenCalledTimes(1);
  });

  it("restores a maximized window with the pointer at the same horizontal fraction", () => {
    const { cursor, window, drag } = setup();
    window.isMaximized = () => true;
    window.getBounds = () => ({ x: -1920, y: 0, width: 1920, height: 1080 });
    cursor.x = -960;
    cursor.y = 20;
    drag(window, "begin");
    cursor.x = -800;
    cursor.y = 80;
    drag(window, "move");
    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.setBounds).toHaveBeenLastCalledWith({
      x: -1300,
      y: 60,
      width: 1000,
      height: 700,
    });
    cursor.x = -750;
    drag(window, "move");
    expect(window.unmaximize).toHaveBeenCalledTimes(1);
    expect(window.setBounds).toHaveBeenLastCalledWith({
      x: -1250,
      y: 60,
      width: 1000,
      height: 700,
    });
  });

  it.each(["isDestroyed", "isFullScreen", "isFocused", "isMovable"] as const)(
    "cancels when %s becomes ineligible",
    (property) => {
      const { window, drag } = setup();
      drag(window, "begin");
      window[property] = () => property === "isDestroyed" || property === "isFullScreen";
      drag(window, "move");
      expect(window.setBounds).not.toHaveBeenCalled();
      window[property] = () => property === "isFocused" || property === "isMovable";
      drag(window, "move");
      expect(window.setBounds).not.toHaveBeenCalled();
    },
  );
});
