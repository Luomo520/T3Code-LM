import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { screen } from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { createTitlebarWindowDrag } from "../../window/TitlebarWindowDrag.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const drag = createTitlebarWindowDrag(() => screen.getCursorScreenPoint());

export const windowDrag = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOW_DRAG_CHANNEL,
  payload: Schema.Literals(["begin", "move", "end"]),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.drag")(function* (phase, event) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (Option.isSome(main) && event?.sender.id === main.value.webContents.id) {
      drag(main.value, phase);
    }
  }),
});
