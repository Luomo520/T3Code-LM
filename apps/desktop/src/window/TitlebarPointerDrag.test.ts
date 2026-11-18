import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { installTitlebarPointerDrag } from "./TitlebarPointerDrag.ts";

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
    this.isPrimary = init.isPrimary ?? true;
  }
}

function pointer(target: Element, type: string, init: PointerEventInit = {}) {
  const event = new TestPointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: 10,
    clientY: 10,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

describe("titlebar pointer arbitration", () => {
  let uninstall: () => void;
  let button: HTMLButtonElement;
  let notify: ReturnType<typeof vi.fn<(phase: "begin" | "move" | "end") => void>>;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    document.body.innerHTML =
      '<header class="drag-region"><button>Usage<span>Day</span></button><input></header><button id="outside">Outside</button>';
    button = document.querySelector("button")!;
    notify = vi.fn();
    frames = new Map();
    nextFrame = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
    uninstall = installTitlebarPointerDrag(document, notify);
  });

  afterEach(() => {
    uninstall();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("defers a menu's pointerdown until release and delivers one click", () => {
    const open = vi.fn();
    const click = vi.fn();
    button.addEventListener("pointerdown", open);
    button.addEventListener("click", click);
    pointer(button.querySelector("span")!, "pointerdown");
    expect(open).not.toHaveBeenCalled();
    pointer(button, "pointermove", { clientX: 13 });
    pointer(button, "pointerup", { clientX: 13 });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button);
    expect(notify.mock.calls).toEqual([["begin"], ["end"]]);
  });

  it("moves at a frame boundary and suppresses drag-release actions", () => {
    const open = vi.fn();
    const click = vi.fn();
    button.addEventListener("pointerdown", open);
    button.addEventListener("click", click);
    pointer(button, "pointerdown");
    pointer(button, "pointermove", { clientX: 30 });
    pointer(button, "pointermove", { clientX: 40 });
    expect(frames.size).toBe(1);
    for (const callback of frames.values()) callback(0);
    pointer(button, "pointerup", { clientX: 40 });
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    expect(notify.mock.calls).toEqual([["begin"], ["move"], ["move"], ["end"]]);
    expect(open).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    button.click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("leaves editors, modified clicks, and popup/outside content untouched", () => {
    const input = document.querySelector("input")!;
    const outside = document.querySelector("#outside")!;
    expect(pointer(input, "pointerdown").defaultPrevented).toBe(false);
    expect(pointer(outside, "pointerdown").defaultPrevented).toBe(false);
    expect(pointer(button, "pointerdown", { ctrlKey: true }).defaultPrevented).toBe(false);
    expect(pointer(button, "pointerdown", { pointerType: "touch" }).defaultPrevented).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("preserves pointer input for explicitly excluded sortable tabs", () => {
    button.setAttribute("data-titlebar-no-drag", "");
    const down = vi.fn();
    const move = vi.fn();
    button.addEventListener("pointerdown", down);
    button.addEventListener("pointermove", move);
    expect(pointer(button, "pointerdown").defaultPrevented).toBe(false);
    expect(pointer(button, "pointermove", { clientX: 40 }).defaultPrevented).toBe(false);
    expect(down).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["blur", "pointercancel"])(
    "cancels on %s without retaining a queued move or click",
    (type) => {
      const click = vi.fn();
      button.addEventListener("click", click);
      pointer(button, "pointerdown");
      pointer(button, "pointermove", { clientX: 40 });
      (type === "blur" ? window : document).dispatchEvent(new Event(type));
      expect(frames.size).toBe(0);
      pointer(button, "pointerup", { clientX: 40 });
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      expect(click).not.toHaveBeenCalled();
      expect(notify.mock.calls).toEqual([["begin"], ["end"]]);
      expect(pointer(document.querySelector("input")!, "pointerdown").defaultPrevented).toBe(false);
    },
  );
});
