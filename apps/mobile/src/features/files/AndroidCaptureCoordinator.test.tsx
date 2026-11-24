import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Action = { readonly text: string; readonly onPress: () => void };
const state = vi.hoisted(() => ({
  active: true,
  alert: vi.fn<(title: string, text: string, actions: readonly Action[]) => void>(),
  capture: vi.fn(),
  send: vi.fn(),
  unlocked: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/environmentHttpAuth", () => ({}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ createEnvironmentCommand: () => ({}) }));
vi.mock("expo-device", () => ({ deviceName: null, modelName: "Test Android" }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly size = 12;
    readonly exists = true;
    base64() {
      return Promise.resolve("c2NyZWVuc2hvdA==");
    }
    delete() {
      state.deleteFile();
    }
  },
}));
vi.mock("react-native", () => ({
  Alert: { alert: state.alert },
  ToastAndroid: { show: vi.fn(), SHORT: 0 },
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../lib/appState", () => ({
  isAppActive: () => state.active,
  useAppActive: () => state.active,
}));
vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: { isReady: () => false },
}));
vi.mock("../agent-awareness/androidNotifications", () => ({
  canNotifyAndroidCaptureRequests: () => true,
  noteAndroidCaptureBackgroundReady: vi.fn(),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    {
      environmentId: "env-android",
      environmentLabel: "书房环境",
      connectionState: "connected",
      isEnabled: true,
    },
  ],
}));
vi.mock("./localScreenCapture", () => ({
  localScreenCapture: {
    isUnlocked: state.unlocked,
    captureApprovedRequest: state.capture,
    cancelCapture: vi.fn(async () => {}),
  },
}));

import { AndroidCaptureCoordinator } from "./AndroidCaptureCoordinator";

it("requires the phone's explicit confirmation before opening Android consent and posting media", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const job = {
    id: "request-one",
    threadId: "started-here",
    action: "screenshot",
    durationSeconds: 10,
    expiresAt: 1_800_000_000_000,
  };
  const reply = (value: unknown) => ({ _tag: "Success", value });
  state.unlocked.mockResolvedValue(true);
  state.send.mockImplementation(async ({ input }) => {
    switch (input._tag) {
      case "listen":
        return reply({ _tag: "pending", job });
      case "approve":
        return reply({ _tag: "active", job });
      case "complete":
        return reply({ _tag: "accepted" });
      default:
        throw new Error("Unexpected Android capture request");
    }
  });
  const system = Promise.withResolvers<{ status: "done"; uri: string; name: string }>();
  state.capture.mockReturnValue(system.promise);
  try {
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    expect(state.unlocked).toHaveBeenCalled();
    expect(state.send.mock.calls).toHaveLength(1);
    expect(state.alert.mock.calls[0]).toEqual([
      "允许本次截图？",
      expect.stringContaining("书房环境"),
      expect.any(Array),
      expect.any(Object),
    ]);
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.capture).not.toHaveBeenCalled();
    const actions = state.alert.mock.calls[0]?.[2];
    await act(async () => actions?.find(({ text }) => text === "继续系统授权")?.onPress());
    expect(state.capture).toHaveBeenCalledWith("screenshot", job.id, 10);
    expect(state.send.mock.calls).toHaveLength(2);
    await act(async () =>
      system.resolve({
        status: "done",
        uri: "file:///cache/capture.png",
        name: "capture.png",
      }),
    );
    expect(state.send.mock.lastCall?.[0]).toEqual({
      environmentId: "env-android",
      input: { _tag: "complete", id: job.id, media: "c2NyZWVuc2hvdA==" },
    });
    expect(state.deleteFile).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});

it("presents a queued recording only once after returning to the foreground", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.active = false;
  state.unlocked.mockResolvedValue(true);
  state.send.mockResolvedValue({
    _tag: "Success",
    value: {
      _tag: "pending",
      job: {
        id: "background-request",
        threadId: "original",
        action: "record-screen",
        durationSeconds: 10,
        expiresAt: 1_800_000_000_000,
      },
    },
  });
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    expect(state.send).not.toHaveBeenCalled();
    state.active = true;
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    expect(state.alert.mock.calls[0]?.[0]).toBe("允许本次录屏？");
    expect(state.capture).not.toHaveBeenCalled();

    state.active = false;
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    state.active = true;
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.alert).toHaveBeenCalledOnce();
    expect(state.capture).not.toHaveBeenCalled();
  } finally {
    state.active = true;
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
