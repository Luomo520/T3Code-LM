import { EnvironmentId, ThreadId, type FileHandoffTransfer } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { ThreadFileReception, ThreadFileSaveStatus } from "./ThreadFileReception";

const mocks = vi.hoisted(() => ({
  list: [] as FileHandoffTransfer[],
  request: vi.fn(),
  download: vi.fn(),
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: () =>
    Option.some({ httpBaseUrl: "https://thread.test" }) as ReturnType<
      typeof import("~/state/session").usePreparedConnection
    >,
  useEnvironmentScope: () => true,
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { _tag: "list", transfers: mocks.list },
    refresh: vi.fn(),
    isPending: false,
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.request }));
vi.mock("~/lib/fileDownload", () => ({
  startFileDownload: mocks.download,
  observeFileDownloads: vi.fn(),
  startVerifiedDesktopDownload: vi.fn(),
}));

const thread = {
  environmentId: EnvironmentId.make("file-receipt-environment"),
  threadId: ThreadId.make("file-receipt-thread"),
};
const transfer = {
  id: "a0000000-0000-4000-a000-000000000002",
  name: "test.zip",
  sizeBytes: 50,
  sha256: "b".repeat(64),
  senderLabel: "T3",
  recipientLabel: "浏览器",
  outgoing: false,
  autoReceive: true,
} satisfies FileHandoffTransfer;

it("hands the file to the browser from the original thread and reports browser status", async () => {
  using _picker = stubGlobal("showSaveFilePicker", undefined);
  using _bridge = stubGlobal("desktopBridge", undefined);
  const { autoReceive: _autoReceive, ...manual } = transfer;
  mocks.list = [transfer, { ...manual, id: "manual-item" }];
  mocks.request.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      _tag: "receive",
      relativeUrl: "/api/assets/file-handoff/signed",
      name: transfer.name,
      sizeBytes: transfer.sizeBytes,
      sha256: transfer.sha256,
    },
  });
  await using screen = await render(<ThreadFileReception thread={thread} />, { router: false });
  const save = screen.getByRole("button", { name: "保存到我的设备" });
  await expect.element(save).toBeVisible();
  expect(mocks.download).not.toHaveBeenCalled();

  await userEvent.click(save);
  await expect
    .element(screen.getByText("已交给浏览器下载，请在浏览器下载列表查看。"))
    .toBeVisible();
  expect(mocks.request).toHaveBeenCalledExactlyOnceWith({
    environmentId: thread.environmentId,
    input: { _tag: "receive", threadId: thread.threadId, id: transfer.id },
  });
  expect(mocks.download).toHaveBeenCalledExactlyOnceWith({
    url: "https://thread.test/api/assets/file-handoff/signed",
    fileName: transfer.name,
  });
});

it("replaces the original pending tool result with the verified destination", async () => {
  mocks.list = [
    {
      ...transfer,
      outgoing: true,
      recipientLabel: "Windows PC",
      disposition: "saved",
      savedPath: "C:\\Users\\test\\Downloads\\test.zip",
    },
  ];
  await using screen = await render(
    <ThreadFileSaveStatus thread={thread} id={transfer.id} fallback="等待保存" />,
    { router: false },
  );
  await expect.element(screen.getByText(/Windows PC 已保存并校验 test\.zip/)).toBeVisible();
  await expect.element(screen.getByText(/Downloads\\test\.zip/)).toBeVisible();
  await expect.element(screen.getByText("等待保存")).not.toBeInTheDocument();
});
