import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  foreground: null as null | (() => void),
  policy: "ask",
  listen: vi.fn(),
  post: vi.fn(),
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
