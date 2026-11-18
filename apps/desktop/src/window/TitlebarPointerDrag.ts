// @effect-diagnostics globalDate:off -- Synchronous preload input handling runs outside the main-process Effect runtime.
type DragPhase = "begin" | "move" | "end";

const EDITABLE =
  'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="slider"],[data-titlebar-no-drag]';

export function installTitlebarPointerDrag(doc: Document, notify: (phase: DragPhase) => void) {
  const view = doc.defaultView;
  if (!view) return () => {};
  let gesture: { target: Element; down: PointerEvent; dragging: boolean } | null = null;
  let replaying = false;
  let suppressClickUntil = 0;
  let frame: number | null = null;

  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const finish = () => {
    if (!gesture) return;
    if (frame !== null) view.cancelAnimationFrame(frame);
    frame = null;
    const pointerId = gesture.down.pointerId;
    gesture = null;
    if (doc.documentElement.hasPointerCapture?.(pointerId))
      doc.documentElement.releasePointerCapture(pointerId);
    notify("end");
  };
  const cancel = () => {
    if (gesture?.dragging) suppressClickUntil = Date.now() + 500;
    finish();
  };
  const onDown = (event: PointerEvent) => {
    if (replaying) return;
    suppressClickUntil = 0;
    if (
      event.button !== 0 ||
      event.pointerType !== "mouse" ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const origin = event.target;
    if (!(origin instanceof Element) || !origin.closest(".drag-region") || origin.closest(EDITABLE))
      return;
    const target = origin.closest('button,a,[role="button"],[aria-haspopup]') ?? origin;
    cancel();
    suppressClickUntil = 0;
    gesture = { target, down: event, dragging: false };
    notify("begin");
    // Base UI opens menus on pointerdown; defer it until this gesture is known to be a click.
    stop(event);
  };
  const onMove = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.down.pointerId || replaying) return;
    if (!(event.buttons & 1)) {
      cancel();
      return;
    }
    if (
      !gesture.dragging &&
      Math.hypot(event.clientX - gesture.down.clientX, event.clientY - gesture.down.clientY) >= 5
    ) {
      gesture.dragging = true;
      doc.documentElement.setPointerCapture?.(event.pointerId);
    }
    if (gesture.dragging && frame === null) {
      frame = view.requestAnimationFrame(() => {
        frame = null;
        if (gesture?.dragging) notify("move");
      });
    }
    stop(event);
  };
  const onUp = (event: PointerEvent) => {
    if (!gesture || event.pointerId !== gesture.down.pointerId || replaying) return;
    const { target, down, dragging } = gesture;
    stop(event);
    if (dragging) {
      notify("move");
    }
    finish();
    suppressClickUntil = Date.now() + 500;
    if (
      dragging ||
      !target.isConnected ||
      !(event.target instanceof Node) ||
      !target.contains(event.target)
    )
      return;
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      pointerId: down.pointerId,
      pointerType: down.pointerType,
      isPrimary: down.isPrimary,
    };
    replaying = true;
    try {
      const allowed = target.dispatchEvent(
        new PointerEvent("pointerdown", { ...init, buttons: 1 }),
      );
      if (allowed) {
        const mouseAllowed = target.dispatchEvent(
          new MouseEvent("mousedown", { ...init, buttons: 1 }),
        );
        if (mouseAllowed && target instanceof HTMLElement)
          target.closest<HTMLElement>("button,a[href],[tabindex]")?.focus({ preventScroll: true });
      }
      target.dispatchEvent(new PointerEvent("pointerup", init));
      target.dispatchEvent(new MouseEvent("mouseup", init));
      target.dispatchEvent(new MouseEvent("click", { ...init, detail: 1 }));
    } finally {
      replaying = false;
    }
  };
  const onMouse = (event: MouseEvent) => {
    if (!replaying && (gesture || (event.type === "mouseup" && Date.now() < suppressClickUntil)))
      stop(event);
  };
  const onClick = (event: MouseEvent) => {
    // Keyboard activation has detail=0 and must not inherit a preceding pointer's suppression.
    if (!replaying && event.detail !== 0 && Date.now() < suppressClickUntil) stop(event);
  };
  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", cancel, true);
  doc.addEventListener("lostpointercapture", cancel, true);
  doc.addEventListener("mousedown", onMouse, true);
  doc.addEventListener("mouseup", onMouse, true);
  doc.addEventListener("click", onClick, true);
  view.addEventListener("blur", cancel);
  return () => {
    cancel();
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", cancel, true);
    doc.removeEventListener("lostpointercapture", cancel, true);
    doc.removeEventListener("mousedown", onMouse, true);
    doc.removeEventListener("mouseup", onMouse, true);
    doc.removeEventListener("click", onClick, true);
    view.removeEventListener("blur", cancel);
  };
}
