import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type Button = { readonly text: string; readonly onPress: () => void };
const mocks = vi.hoisted(() => ({
  dialogs: [] as Array<{
    readonly message: string;
    readonly buttons: readonly Button[];
    readonly onDismiss: () => void;
  }>,
  inbox: { _tag: "inbox", transfers: [], urlDownloads: [] as object[] },
  receive: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ _tag: "Initial" }) }));
vi.mock("@t3tools/client-runtime/state/fileHandoff", () => ({
  createFileHandoffAtoms: () => ({ list: () => ({}), receive: {} }),
  unwrapFileHandoff: (value: unknown) => value,
}));
vi.mock("react-native", () => ({
  Alert: {
    alert: (
      _title: string,
      message: string,
      buttons: readonly Button[],
      options: { onDismiss: () => void },
    ) => mocks.dialogs.push({ message, buttons, onDismiss: options.onDismiss }),
  },
  ToastAndroid: { show: vi.fn(), SHORT: 0 },
}));
vi.mock("@react-navigation/native", () => ({}));
vi.mock("../../components/ui/AppText", () => ({}));
vi.mock("../../components/ui/Dialog", () => ({}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("../../state/preferences", () => ({ mobilePreferencesAtom: {} }));
vi.mock("../../lib/appState", () => ({ isAppActive: () => true, useAppActive: () => true }));
vi.mock("../../lib/systemFileDownload", () => ({ supportsAutomaticFileHandoff: () => true }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: mocks.inbox,
    successResult: mocks.inbox,
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "http://localhost" } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.receive }));
vi.mock("../../state/workspace", () => ({
  useWorkspaceEnvironments: () => [
    { isEnabled: true, environmentId: "env", connectionState: "connected" },
  ],
}));
vi.mock("../agent-awareness/notificationNavigation", () => ({}));
vi.mock("./automatic-file-handoff", () => ({}));
vi.mock("./ReceivedApkInstallAction", () => ({}));

import { AutomaticFileHandoff } from "./AutomaticFileHandoff";

it("cancels the displayed download and ignores its late confirmation when a new download arrives", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  const file = {
    name: "LICENSE",
    senderLabel: "Test",
    sourceUrl: "https://files.example/LICENSE?x=1",
  };
  const first = { ...file, id: "first", threadId: "thread-1" };
  const second = { ...file, id: "second", threadId: "thread-2" };
  mocks.dialogs.length = 0;
  mocks.inbox = { ...mocks.inbox, urlDownloads: [first] };
  const canceled = Promise.withResolvers<{ _tag: "finished"; disposition: "cancelled" }>();
  mocks.receive.mockReturnValueOnce(canceled.promise).mockResolvedValueOnce({ _tag: "receive" });
  try {
    await act(async () => root.render(<AutomaticFileHandoff />));
    const original = mocks.dialogs[0]!;
    expect(original.message).toContain(file.sourceUrl);
    await act(async () => {
      original.buttons.find(({ text }) => text === "取消请求")?.onPress();
      original.onDismiss();
    });

    mocks.inbox = { ...mocks.inbox, urlDownloads: [first, second] };
    await act(async () => root.render(<AutomaticFileHandoff />));
    expect(mocks.dialogs).toHaveLength(1);
    await act(async () => canceled.resolve({ _tag: "finished", disposition: "cancelled" }));
    // 刷新结果仍可包含旧条目。已取消的请求不能再次占用确认框。
    mocks.inbox = { ...mocks.inbox };
    await act(async () => root.render(<AutomaticFileHandoff />));
    expect(mocks.dialogs).toHaveLength(2);
    await act(async () => {
      original.buttons.find(({ text }) => text === "确认下载")?.onPress();
      original.onDismiss();
      mocks.dialogs[1]?.buttons.find(({ text }) => text === "确认下载")?.onPress();
    });
    expect(mocks.receive.mock.calls.map(([request]) => request.input)).toEqual([
      { _tag: "cancel", id: "first", threadId: "thread-1" },
      { _tag: "approveUrl", id: "second", threadId: "thread-2" },
    ]);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  }
});
