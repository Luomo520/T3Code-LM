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
  scopedCapture: vi.fn(),
  canAutoReuseSharing: vi.fn(),
  canKeepSharing: vi.fn(),
  endSharing: vi.fn(),
  route: null as {
    name: string;
    key: string;
    params: { environmentId: string; threadId: string };
  } | null,
  routeListener: null as (() => void) | null,
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
  rootNavigationRef: {
    isReady: () => state.route !== null,
    getCurrentRoute: () => state.route,
    addListener: (_event: string, listener: () => void) => {
      state.routeListener = listener;
      return () => {
        state.routeListener = null;
      };
    },
  },
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
    captureScopedRequest: state.scopedCapture,
    canAutoReuseSharing: state.canAutoReuseSharing,
    canKeepSharing: state.canKeepSharing,
    endSharing: state.endSharing,
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

it.each([
  ["inactive", 1],
  ["active", 2],
] as const)("checks the original job after a lost upload receipt (%s)", async (status, uploads) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const job = {
    id: "record-weak-network",
    threadId: "from-phone",
    action: "record-screen",
    durationSeconds: 7,
    expiresAt: 1_800_000_000_000,
  };
  let attempts = 0;
  state.unlocked.mockResolvedValue(true);
  state.capture.mockResolvedValue({
    status: "done",
    uri: "file:///cache/clip.mp4",
    name: "clip.mp4",
  });
  state.send.mockImplementation(async ({ environmentId, input }) => {
    expect(environmentId).toBe("env-android");
    if (input._tag !== "listen") expect(input.id).toBe(job.id);
    switch (input._tag) {
      case "listen":
        return { _tag: "Success", value: { _tag: "pending", job } };
      case "approve":
        return { _tag: "Success", value: { _tag: "active", job } };
      case "complete":
        return ++attempts === 1
          ? { _tag: "Failure" }
          : { _tag: "Success", value: { _tag: "accepted" } };
      case "status":
        return { _tag: "Success", value: { _tag: status, job } };
      default:
        throw new Error(input._tag);
    }
  });
  try {
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    await act(async () =>
      state.alert.mock.calls[0]?.[2].find(({ text }) => text === "继续系统授权")?.onPress(),
    );
    expect(state.send.mock.calls.map(([{ input }]) => input._tag)).toEqual([
      "listen",
      "approve",
      "complete",
      "status",
      ...(uploads === 2 ? ["complete"] : []),
    ]);
    expect(state.capture).toHaveBeenCalledOnce();
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

it("uses visible sharing automatically for the same action and restores consent after scope changes", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  const root = createRoot(document.createElement("div"));
  state.route = {
    name: "Thread",
    key: "original-route",
    params: { environmentId: "env-android", threadId: "original-thread" },
  };
  const screenshot = {
    id: "first-shot",
    threadId: "original-thread",
    action: "screenshot",
    durationSeconds: 10,
    expiresAt: 1_800_000_000_000,
  };
  let job = screenshot;
  let sharingVisible = false;
  const done = { status: "done", uri: "file:///cache/capture.png", name: "capture.png" };
  const reply = (value: unknown) => ({ _tag: "Success", value });
  state.unlocked.mockResolvedValue(true);
  state.canKeepSharing.mockResolvedValue(true);
  state.canAutoReuseSharing.mockImplementation(async () => sharingVisible);
  state.endSharing.mockImplementation(async () => {
    sharingVisible = false;
  });
  state.scopedCapture.mockImplementation(async (...args: unknown[]) => {
    if (args[6] === "hold") sharingVisible = true;
    return done;
  });
  state.capture.mockResolvedValue(done);
  state.send.mockImplementation(async ({ input }) => {
    switch (input._tag) {
      case "listen":
        return reply({ _tag: "pending", job });
      case "approve":
      case "status":
        return reply({ _tag: "active", job });
      case "complete":
      case "reject":
        return reply({ _tag: "accepted" });
      default:
        throw new Error("Unexpected Android capture request");
    }
  });
  const next = async (newJob: typeof screenshot) => {
    job = newJob;
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
  };
  const press = async (text: string) => {
    const button = state.alert.mock.lastCall?.[2].find((action) => action.text === text);
    expect(button).toBeDefined();
    await act(async () => button?.onPress());
  };
  try {
    await act(async () => root.render(<AndroidCaptureCoordinator />));
    expect(state.scopedCapture).not.toHaveBeenCalled();
    expect(state.alert.mock.lastCall?.[1]).toContain("自动处理此会话的截图请求");
    await press("自动截图 60 秒");
    expect(state.scopedCapture).toHaveBeenLastCalledWith(
      "screenshot",
      "first-shot",
      10,
      "env-android",
      "original-thread",
      "original-route",
      "hold",
    );

    await next({ ...screenshot, id: "automatic-shot" });
    expect(state.alert).toHaveBeenCalledOnce();
    expect(state.scopedCapture).toHaveBeenLastCalledWith(
      "screenshot",
      "automatic-shot",
      10,
      "env-android",
      "original-thread",
      "original-route",
      "reuse",
    );

    await next({ ...screenshot, id: "different-operation", action: "record-screen" });
    expect(state.alert.mock.lastCall?.[0]).toBe("允许本次录屏？");
    expect(state.scopedCapture).toHaveBeenCalledTimes(2);
    await press("拒绝");

    await next({ ...screenshot, id: "different-thread", threadId: "other-thread" });
    expect(state.alert.mock.lastCall?.[2].map(({ text }) => text)).toEqual([
      "拒绝",
      "继续系统授权",
    ]);
    expect(state.scopedCapture).toHaveBeenCalledTimes(2);
    await press("拒绝");

    state.scopedCapture.mockResolvedValueOnce({ status: "sharing_unavailable" });
    await next({ ...screenshot, id: "expires-before-capture" });
    expect(state.alert.mock.lastCall?.[1]).toContain("共享已结束或不可用");
    expect(state.capture).not.toHaveBeenCalled();
    await press("继续系统授权");
    expect(state.capture).toHaveBeenCalledWith("screenshot", "expires-before-capture", 10);
    expect(state.send.mock.lastCall?.[0].input).toMatchObject({
      _tag: "complete",
      id: "expires-before-capture",
    });

    await next({ ...screenshot, id: "new-explicit-share" });
    await press("自动截图 60 秒");
    state.route = { name: "Home", key: "home", params: state.route.params };
    state.routeListener?.();
    expect(state.endSharing).toHaveBeenCalledTimes(2);
    await next({ ...screenshot, id: "after-route-change" });
    expect(state.alert.mock.lastCall?.[2].map(({ text }) => text)).toEqual([
      "拒绝",
      "继续系统授权",
    ]);
  } finally {
    await act(async () => root.unmount());
    state.route = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
