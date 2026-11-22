import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

const native = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setOverlayIcon: vi.fn(),
  isDestroyed: vi.fn(() => false),
  getFocusedWindow: vi.fn(() => null as object | null),
  image: { isEmpty: vi.fn(() => false) },
  createFromDataURL: vi.fn(),
  webContents: { send: vi.fn() },
  listeners: new Map<string, () => void>(),
}));
vi.mock("electron", () => ({
  app: {
    setBadgeCount: native.setBadgeCount,
    on: (event: string, listener: () => void) => native.listeners.set(event, listener),
    removeListener: (event: string) => native.listeners.delete(event),
  },
  BrowserWindow: {
    getFocusedWindow: native.getFocusedWindow,
    getAllWindows: () => [native],
  },
  nativeImage: { createFromDataURL: native.createFromDataURL },
}));

import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { installNotificationBadge } from "./notificationBadge.ts";

const badge = { count: 2, image: "data:image/png;base64,aGVsbG8=" };

beforeEach(() => {
  vi.clearAllMocks();
  native.getFocusedWindow.mockReturnValue(null);
  native.isDestroyed.mockReturnValue(false);
  native.image.isEmpty.mockReturnValue(false);
  native.createFromDataURL.mockReturnValue(native.image);
  native.setBadgeCount.mockImplementation(() => true);
  native.listeners.clear();
});

it.effect.each([
  { platform: "linux" as const, language: "zh", singular: "", plural: "" },
  {
    platform: "win32" as const,
    language: "zh",
    singular: "1 个会话有新通知",
    plural: "2 个会话有新通知",
  },
  {
    platform: "win32" as const,
    language: "en",
    singular: "1 thread with new notifications",
    plural: "2 threads with new notifications",
  },
])(
  "validates and clears badges on $platform with language $language",
  ({ platform, language, singular, plural }) =>
    Effect.gen(function* () {
      const handlers = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const expectBadgeCount = (count: number) => {
        if (platform === "win32") {
          expect(native.setOverlayIcon).toHaveBeenLastCalledWith(
            count === 0 ? null : native.image,
            count === 0 ? "" : count === 1 ? singular : plural,
          );
        } else {
          expect(native.setBadgeCount).toHaveBeenLastCalledWith(count);
        }
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* installNotificationBadge();
          const handler = handlers.get("desktop:set-notification-badge")!;
          const event = { sender: { id: 1 } };
          for (const invalid of [
            { ...badge, count: -1 },
            { ...badge, count: 0.5 },
            { ...badge, count: Infinity },
            { ...badge, image: "https://example.com/icon.png" },
            { ...badge, image: `data:image/png;base64,${"a".repeat(16_384)}` },
          ]) {
            yield* Effect.promise(() => expect(handler(event, invalid)).rejects.toBeDefined());
          }
          expect(native.setBadgeCount).not.toHaveBeenCalled();
          expect(native.setOverlayIcon).not.toHaveBeenCalled();
          yield* Effect.promise(() => Promise.resolve(handler(event, { ...badge, count: 1 })));
          expectBadgeCount(1);
          yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
          expectBadgeCount(2);
          native.listeners.get("browser-window-focus")!();
          expectBadgeCount(0);
          expect(native.webContents.send).toHaveBeenCalledWith("desktop:set-notification-badge");
          native.getFocusedWindow.mockReturnValue({});
          yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
          expectBadgeCount(0);
          expect(native.webContents.send).toHaveBeenCalledTimes(2);
          yield* Effect.promise(() => Promise.resolve(handler(event, { count: 0, image: null })));
          expect(native.webContents.send).toHaveBeenCalledTimes(2);
          native.getFocusedWindow.mockReturnValue(null);
          yield* Effect.promise(() => Promise.resolve(handler(event, badge)));
          native.listeners.get("before-quit")!();
          expectBadgeCount(0);
        }),
      ).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provide([
          ElectronApp.layer,
          DesktopClientSettings.layerTest(Option.some({ ...DEFAULT_CLIENT_SETTINGS, language })),
          DesktopIpc.layerTest({
            handle: (channel, handler) => {
              handlers.set(channel, handler);
            },
            removeHandler: (channel) => {
              handlers.delete(channel);
            },
            on: vi.fn(),
            removeAllListeners: vi.fn(),
          }),
        ]),
      );
      expectBadgeCount(0);
      expect(native.listeners.size).toBe(0);
      expect(handlers.size).toBe(0);
    }),
);
