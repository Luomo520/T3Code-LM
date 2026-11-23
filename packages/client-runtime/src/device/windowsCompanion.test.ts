import type { CompanionDevice } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { lookupWindowsCompanionMac, windowsCompanionCapabilities } from "./windowsCompanion";

const desktop: CompanionDevice = {
  deviceId: "windows-test",
  name: "Study PC",
  info: {
    desktopState: "ready",
    network1: "Ethernet · IP 192.0.2.8 · MAC 02-11-22-33-44-55",
    network2: "Wi-Fi · MAC 02-11-22-33-44-66 · IP 192.0.2.9",
    recordingStop: "true",
  },
  online: true,
  lastSeen: "2026-11-23T01:00:00Z",
  recentTasks: [],
};

it("matches multiple adapters to one paired device and reports conflicts across paired devices", () => {
  const other = {
    ...desktop,
    deviceId: "other",
    name: "Other PC",
    info: { network: "LAN · MAC 02:11:22:33:44:55" },
  };
  expect(lookupWindowsCompanionMac([desktop, other], "021122334466")).toEqual([desktop]);
  expect(lookupWindowsCompanionMac([desktop, other], " 02:11:22:33:44:55 ")).toEqual([
    desktop,
    other,
  ]);
  expect(lookupWindowsCompanionMac([desktop], "02-11-22-33-44-77")).toEqual([]);
  expect(lookupWindowsCompanionMac([desktop], "00:00:00:00:00:00")).toBeNull();
  expect(lookupWindowsCompanionMac([desktop], "01-11-22-33-44-55")).toBeNull();
  expect(lookupWindowsCompanionMac([desktop], "02:11-22:33-44:55")).toBeNull();
});

it("explains target desktop conditions and distinguishes stopping a recording from starting one", () => {
  const recording: CompanionDevice = {
    ...desktop,
    recentTasks: [
      {
        id: "recording",
        action: "record-screen",
        status: "running",
        updatedAt: desktop.lastSeen,
      },
    ],
  };
  expect(windowsCompanionCapabilities(recording, true)).toMatchObject({
    receiveFile: "confirmOnDevice",
    screenshot: "confirmOnDevice",
    stopRecording: "stopFromConversation",
    installApp: "unsupported",
  });
  expect(windowsCompanionCapabilities(desktop, true).stopRecording).toBe("noRecording");
  expect(
    windowsCompanionCapabilities(
      { ...recording, info: { ...recording.info, desktopState: "input-paused" } },
      true,
    ),
  ).toMatchObject({
    receiveFile: "confirmOnDevice",
    desktopInput: "inputPaused",
    stopRecording: "stopFromConversation",
  });
  expect(
    windowsCompanionCapabilities({ ...desktop, info: { desktopState: "ready" } }, true)
      .stopRecording,
  ).toBe("stopLocally");
  expect(windowsCompanionCapabilities({ ...desktop, info: {} }, true).receiveFile).toBe("unknown");
  expect(windowsCompanionCapabilities({ ...desktop, online: false }, true).sendFile).toBe(
    "offline",
  );
  expect(
    windowsCompanionCapabilities({ ...desktop, info: { desktopState: "locked" } }, true).screenshot,
  ).toBe("locked");
  expect(
    windowsCompanionCapabilities({ ...desktop, info: { desktopState: "paused" } }, true)
      .receiveFile,
  ).toBe("paused");
  expect(windowsCompanionCapabilities(desktop, false).screenRecording).toBe("disabled");
});
