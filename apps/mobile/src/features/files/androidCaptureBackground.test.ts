import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  foreground: null as null | (() => void),
  policy: "ask",
  listen: vi.fn(),
  post: vi.fn(() => true),
}));

vi.mock("react-native", () => ({
  AppState: {
    currentState: "background",
    addEventListener: (_event: string, onState: (state: string) => void) => {
      mocks.foreground = () => onState("active");
      return { remove: () => (mocks.foreground = null) };
    },
  },
}));
vi.mock("../../state/atom-registry", async () => ({
  appAtomRegistry: (await import("effect/reactivity")).AtomRegistry.make(),
}));
vi.mock("../../state/workspace", async () => ({
  workspaceConnections: {
    environmentsAtom: (await import("effect/reactivity")).Atom.make(() => [
      {
        isEnabled: true,
        environmentId: "paired-env",
        environmentLabel: "书房",
        connectionState: "connected",
      },
    ]),
  },
}));
vi.mock("../../state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const scope = Atom.make(true);
  return {
    environmentSession: { sessionStateAtom: () => scope },
    sessionHasScope: (permitted: boolean) => permitted,
  };
});
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: mocks.listen }));
vi.mock("./androidCaptureClient", () => ({
  androidCapturePhoneName: () => "Android 手机",
  captureCommand: {},
}));
vi.mock("./androidCapturePolicy", () => ({ readAndroidCapturePolicy: () => mocks.policy }));
vi.mock("../agent-awareness/androidNotifications", () => ({
  canNotifyAndroidCaptureRequests: () => true,
  postAndroidCaptureRequest: mocks.post,
  readAndroidCaptureBackgroundWatch: () => Infinity,
}));

import { checkAndroidCaptureRequestsInBackground } from "./androidCaptureBackground";

it("posts only the original paired request and honors a policy revoked before delivery", async () => {
  const response = {
    _tag: "Success",
    value: {
      _tag: "pending",
      job: { id: "job", threadId: "original", action: "record-screen", expiresInMs: 120_000 },
    },
  };
  mocks.policy = "ask";
  mocks.listen.mockResolvedValueOnce(response);
  let check = checkAndroidCaptureRequestsInBackground();
  await Promise.resolve();
  expect(mocks.listen.mock.calls[0]?.[2]).toEqual({
    environmentId: "paired-env",
    input: { _tag: "listen", name: "Android 手机", delivery: "background" },
  });
  expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
    environmentId: "paired-env",
    environmentLabel: "书房",
    threadId: "original",
    jobId: "job",
    recording: true,
    expiresInMs: 120_000,
  });
  mocks.foreground?.();
  await check;

  const pending = Promise.withResolvers<typeof response>();
  mocks.listen.mockReturnValueOnce(pending.promise);
  check = checkAndroidCaptureRequestsInBackground();
  mocks.policy = "deny";
  mocks.listen.mockResolvedValueOnce({ _tag: "Success", value: { _tag: "accepted" } });
  pending.resolve(response);
  await Promise.resolve();
  mocks.foreground?.();
  await check;
  expect(mocks.post).toHaveBeenCalledOnce();
  expect(mocks.listen.mock.lastCall?.[2]).toEqual({
    environmentId: "paired-env",
    input: { _tag: "reject", id: "job", reason: "denied" },
  });
});

it("rechecks the queue after an empty response or network failure without posting twice", async () => {
  vi.useFakeTimers();
  mocks.listen.mockReset();
  mocks.post.mockReset().mockReturnValue(true);
  mocks.policy = "ask";
  const pending = {
    _tag: "Success",
    value: {
      _tag: "pending",
      job: { id: "late-job", threadId: "original", action: "screenshot", expiresInMs: 120_000 },
    },
  };
  const late = Promise.withResolvers<typeof pending>();
  mocks.listen
    .mockResolvedValueOnce({ _tag: "Success", value: { _tag: "pending", job: null } })
    .mockResolvedValueOnce({ _tag: "Failure", error: new Error("network unavailable") })
    .mockResolvedValueOnce(pending)
    .mockResolvedValueOnce(pending)
    .mockReturnValueOnce(late.promise);

  try {
    const check = checkAndroidCaptureRequestsInBackground();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.listen).toHaveBeenCalledTimes(2);
    expect(mocks.post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith({
      environmentId: "paired-env",
      environmentLabel: "书房",
      threadId: "original",
      jobId: "late-job",
      recording: false,
      expiresInMs: 120_000,
    });

    await vi.advanceTimersByTimeAsync(12_000);
    await check;
    expect(mocks.listen).toHaveBeenCalledTimes(5);
    expect(mocks.post).toHaveBeenCalledOnce();

    late.resolve({
      ...pending,
      value: { ...pending.value, job: { ...pending.value.job, id: "expired-check" } },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.post).toHaveBeenCalledOnce();
    expect(mocks.listen).toHaveBeenCalledTimes(5);
  } finally {
    mocks.foreground?.();
    vi.useRealTimers();
  }
});

it("retries the same queued request if Android did not accept the notification", async () => {
  vi.useFakeTimers();
  mocks.policy = "ask";
  mocks.post.mockReset().mockReturnValueOnce(false).mockReturnValue(true);
  mocks.listen.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      _tag: "pending",
      job: {
        id: "delivery-retry",
        threadId: "original",
        action: "record-screen",
        expiresInMs: 90_000,
      },
    },
  });
  try {
    const check = checkAndroidCaptureRequestsInBackground();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(mocks.post).toHaveBeenCalledTimes(2);
    mocks.foreground?.();
    await check;
  } finally {
    mocks.foreground?.();
    vi.useRealTimers();
  }
});
