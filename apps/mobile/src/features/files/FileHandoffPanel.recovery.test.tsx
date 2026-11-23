import {
  EnvironmentId,
  ThreadId,
  type FileHandoffRequest,
  type FileHandoffTransfer,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  appState: { currentState: "active" },
  appStateListeners: new Set<(value: string) => void>(),
  list: {
    data: {
      _tag: "list",
      recipients: [] as readonly object[],
      transfers: [] as readonly FileHandoffTransfer[],
    },
    refresh: vi.fn(),
    isPending: false,
  },
  direct: vi.fn(),
  receive: vi.fn(),
  readHandoff: vi.fn(),
  saveDirect: vi.fn(),
  enqueue: vi.fn(),
  prepared: { _tag: "Some", value: { httpBaseUrl: "http://127.0.0.1:3000" } },
}));

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  AppState: Object.assign(state.appState, {
    addEventListener: (_event: string, listener: (value: string) => void) => {
      state.appStateListeners.add(listener);
      return { remove: () => state.appStateListeners.delete(listener) };
    },
  }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo/fetch", () => ({ fetch: vi.fn() }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly exists = true;
    readonly uri = "file:///cache/handoff";
    create() {}
    delete() {}
    open() {
      return { writeBytes: vi.fn(), close: vi.fn() };
    }
  },
  Paths: { cache: "/cache" },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    disabled,
    label,
    onPress,
  }: {
    disabled?: boolean;
    label: string;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  usePreparedConnection: () => state.prepared,
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => state.list }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.receive }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "cache-file" }));
vi.mock("../../lib/systemFileDownload", () => ({
  enqueueFileDownload: state.enqueue,
  fileHandoffDownloadKey: async (_environment: string, _thread: string, id: string) => id,
  readFileDownload: vi.fn(),
  readHandoffDownload: state.readHandoff,
  saveDirectHandoff: state.saveDirect,
  supportsDirectHandoffSave: () => true,
  showDownloadedFiles: vi.fn(),
}));
vi.mock("./useAndroidHandoffPeer", () => ({
  useAndroidHandoffPeer: () => ({ makePeer: vi.fn(), view: null }),
}));
vi.mock("./ReceivedApkInstallAction", () => ({ ReceivedApkInstallAction: () => null }));
vi.mock("@t3tools/client-runtime/state/assets", () => ({ resolveAssetUrl: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/fileHandoff", () => ({
  createFileHandoffAtoms: () => ({ list: vi.fn() }),
  fileHandoffErrorMessage: (_error: unknown, fallback: string) => fallback,
  receiveDirectFile: state.direct,
  sendHandoffFile: vi.fn(),
  unwrapFileHandoff: (value: unknown) => value,
  waitForRelayedHandoff: vi.fn(),
}));

import { FileHandoffPanel } from "./FileHandoffPanel";

const androidBuild = process.env.T3_MOBILE_TEST_PLATFORM === "android";
const androidTest = it.runIf(androidBuild);

const environmentId = EnvironmentId.make("local-environment");
const firstTransfer = {
  id: "00000000-0000-0000-0000-000000000001",
  name: "原图.png",
  sizeBytes: 42,
  senderLabel: "书房电脑",
  recipientLabel: "手机",
  outgoing: false,
  expiresAt: 1_800_000_000_000,
  sha256: null,
  directSha256: "1".repeat(64),
} satisfies FileHandoffTransfer;
const nextTransfer: FileHandoffTransfer = {
  ...firstTransfer,
  id: "00000000-0000-0000-0000-000000000002",
  name: "下一份.png",
};
const localUri = "content://downloads/42";
const finished = { _tag: "finished", disposition: "saved" } as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.appState.currentState = "active";
  state.appStateListeners.clear();
  state.list.data.transfers = [firstTransfer];
  state.readHandoff.mockResolvedValue(null);
  state.saveDirect.mockResolvedValue(localUri);
  state.receive.mockResolvedValue(finished);
  state.direct.mockImplementation(
    async ({ item, publish }: { item: FileHandoffTransfer; publish: () => Promise<void> }) => {
      await publish();
      return { id: item.id, sizeBytes: item.sizeBytes, sha256: item.directSha256 };
    },
  );
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

function button(label: string) {
  const element = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!element) throw new Error(`找不到按钮「${label}」`);
  return element;
}

async function openPanel(threadId: ThreadId) {
  await act(async () =>
    root.render(<FileHandoffPanel environmentId={environmentId} threadId={threadId} />),
  );
  await act(async () => button("设备间传文件").click());
}

androidTest(
  "retries a saved direct receipt after reentering and then accepts the next file",
  async () => {
    const threadId = ThreadId.make("restore-direct-receipt");
    const lostReceipt = Promise.withResolvers<typeof finished>();
    state.receive.mockReturnValueOnce(lostReceipt.promise);
    state.saveDirect.mockImplementationOnce(async () => {
      state.readHandoff.mockImplementation(async (key: string) =>
        key === firstTransfer.id
          ? { status: "downloaded", bytesDownloaded: firstTransfer.sizeBytes, uri: localUri }
          : null,
      );
      return localUri;
    });

    try {
      await openPanel(threadId);
      await act(async () => button("直连接收").click());
      expect(state.saveDirect).toHaveBeenCalledOnce();
      expect(state.receive).toHaveBeenCalledExactlyOnceWith({
        environmentId,
        input: {
          _tag: "confirmSaved",
          threadId,
          id: firstTransfer.id,
          sizeBytes: firstTransfer.sizeBytes,
          sha256: firstTransfer.directSha256,
          savedPath: localUri,
        } satisfies FileHandoffRequest,
      });

      await act(async () => root.render(null));
      state.list.data.transfers = [firstTransfer, nextTransfer];
      await openPanel(threadId);
      expect(state.receive).toHaveBeenCalledTimes(2);
      expect(state.receive.mock.calls[1]).toEqual(state.receive.mock.calls[0]);
      expect(state.direct).toHaveBeenCalledTimes(1);
      expect(state.enqueue).not.toHaveBeenCalled();

      state.list.data.transfers = [{ ...firstTransfer, disposition: "saved" }, nextTransfer];
      await act(async () =>
        root.render(<FileHandoffPanel environmentId={environmentId} threadId={threadId} />),
      );
      await act(async () => button("直连接收").click());
      expect(state.direct).toHaveBeenCalledTimes(2);
      expect(state.direct.mock.calls[1]?.[0]).toMatchObject({ item: { id: nextTransfer.id } });
      expect(state.receive.mock.calls[2]?.[0]).toMatchObject({
        input: { _tag: "confirmSaved", id: nextTransfer.id },
      });
      expect(state.enqueue).not.toHaveBeenCalled();
    } finally {
      await act(async () => lostReceipt.reject(new Error("原连接已关闭")));
    }
  },
);

androidTest(
  "opens a single direct connection for two taps in one event loop and shows receipt progress",
  async () => {
    const threadId = ThreadId.make("direct-double-tap");
    const transfer = Promise.withResolvers<never>();
    state.direct.mockReturnValue(transfer.promise);
    try {
      await openPanel(threadId);
      const receive = button("直连接收");
      await act(async () => {
        receive.click();
        receive.click();
      });
      expect(state.direct).toHaveBeenCalledOnce();
      expect(button("正在接收…").disabled).toBe(true);
    } finally {
      await act(async () => root.render(null));
      await act(async () => transfer.reject(new Error("面板已离开")));
    }
  },
);

androidTest("refreshes immediately on opening and returning to the foreground", async () => {
  const threadId = ThreadId.make("refresh-visible-handoffs");
  await openPanel(threadId);
  expect(state.list.refresh).toHaveBeenCalled();
  state.list.refresh.mockClear();
  for (const value of ["background", "active"]) {
    await act(async () => {
      state.appState.currentState = value;
      for (const listener of state.appStateListeners) listener(value);
    });
  }
  expect(state.list.refresh).toHaveBeenCalledOnce();
});

it.skipIf(androidBuild)("keeps the Android handoff panel out of the iOS build", async () => {
  await act(async () =>
    root.render(<FileHandoffPanel environmentId={environmentId} threadId={ThreadId.make("ios")} />),
  );
  expect(container.querySelector("button")).toBeNull();
});
