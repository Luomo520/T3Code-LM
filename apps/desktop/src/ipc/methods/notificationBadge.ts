import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import { desktopTranslatorForLanguage } from "../../t3zh/t3zh-desktop.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { SET_NOTIFICATION_BADGE_CHANNEL } from "../channels.ts";

const NotificationBadge = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2_147_483_647 })),
  image: Schema.NullOr(
    Schema.String.check(
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i),
    ),
  ),
});

function applyNotificationBadge(
  platform: NodeJS.Platform,
  { count, image }: typeof NotificationBadge.Type,
  description = "",
): void {
  try {
    if (Electron.BrowserWindow.getFocusedWindow()) count = 0;
    if (platform === "win32") {
      const overlay = count > 0 && image ? Electron.nativeImage.createFromDataURL(image) : null;
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.setOverlayIcon(overlay?.isEmpty() ? null : overlay, count > 0 ? description : "");
        }
      }
    } else if (platform === "darwin" || platform === "linux") {
      Electron.app.setBadgeCount(count);
    }
  } catch (error) {
    Effect.runSync(Effect.logWarning("Could not update notification badge", error));
  }
}

export const installNotificationBadge = Effect.fn("desktop.ipc.installNotificationBadge")(
  function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    const app = yield* ElectronApp.ElectronApp;
    const platform = yield* HostProcess.Platform;
    const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
    let badgeRequest = 0;
    const clear = () => {
      badgeRequest++;
      applyNotificationBadge(platform, { count: 0, image: null });
      for (const window of Electron.BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send(SET_NOTIFICATION_BADGE_CHANNEL);
      }
    };
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: SET_NOTIFICATION_BADGE_CHANNEL,
        payload: NotificationBadge,
        result: Schema.Void,
        handler: Effect.fn("desktop.ipc.notificationBadge.set")(function* (
          badge: typeof NotificationBadge.Type,
        ) {
          const request = ++badgeRequest;
          if (badge.count > 0 && Electron.BrowserWindow.getFocusedWindow()) {
            clear();
            return;
          }
          let description = "";
          if (platform === "win32" && badge.count > 0) {
            const settings = yield* clientSettings.get.pipe(Effect.orElseSucceed(Option.none));
            // 读取语言设置期间可能收到新的数量，或窗口已聚焦并清除了角标。
            if (request !== badgeRequest) return;
            const { t } = desktopTranslatorForLanguage(Option.getOrUndefined(settings)?.language);
            description =
              badge.count === 1
                ? t("1 thread with new notifications")
                : t(`${badge.count} threads with new notifications`);
          }
          applyNotificationBadge(platform, badge, description);
        }),
      }),
    );
    yield* app.on("browser-window-focus", clear);
    yield* app.on("before-quit", clear);
    yield* Effect.addFinalizer(() => Effect.sync(clear));
  },
);
