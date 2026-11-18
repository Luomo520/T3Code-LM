interface Point {
  readonly x: number;
  readonly y: number;
}

interface Bounds extends Point {
  readonly width: number;
  readonly height: number;
}

export interface DraggableWindow {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isFullScreen(): boolean;
  isMovable(): boolean;
  isMaximized(): boolean;
  getBounds(): Bounds;
  getNormalBounds(): Bounds;
  unmaximize(): void;
  setBounds(bounds: Bounds): void;
}

export function createTitlebarWindowDrag(getCursor: () => Point) {
  const sessions = new WeakMap<
    DraggableWindow,
    { cursor: Point; bounds: Bounds; maximized: boolean }
  >();

  return (window: DraggableWindow, phase: "begin" | "move" | "end") => {
    if (phase === "end") {
      sessions.delete(window);
      return;
    }
    if (
      window.isDestroyed() ||
      !window.isFocused() ||
      window.isFullScreen() ||
      !window.isMovable()
    ) {
      sessions.delete(window);
      return;
    }
    if (phase === "begin") {
      sessions.set(window, {
        cursor: getCursor(),
        bounds: window.getBounds(),
        maximized: window.isMaximized(),
      });
      return;
    }
    const session = sessions.get(window);
    if (!session) return;
    const cursor = getCursor();
    if (session.maximized) {
      const normal = window.getNormalBounds();
      const fraction = Math.max(
        0,
        Math.min(1, (session.cursor.x - session.bounds.x) / session.bounds.width),
      );
      session.bounds = {
        ...normal,
        x: Math.round(cursor.x - normal.width * fraction),
        y: Math.round(cursor.y - Math.max(0, Math.min(40, session.cursor.y - session.bounds.y))),
      };
      session.cursor = cursor;
      session.maximized = false;
      window.unmaximize();
    }
    window.setBounds({
      ...session.bounds,
      x: Math.round(session.bounds.x + cursor.x - session.cursor.x),
      y: Math.round(session.bounds.y + cursor.y - session.cursor.y),
    });
  };
}
