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
  using _bridge = stubGlobal("desktopBridge", undefined);
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
  await expect
    .element(screen.getByRole("button", { name: "打开所在位置" }))
    .not.toBeInTheDocument();
});

it("offers the local folder action through transfer identity and handles a file moved since render", async () => {
  const locate = vi.fn().mockResolvedValueOnce("available").mockResolvedValueOnce("missing");
  using _bridge = stubGlobal("desktopBridge", { locateSavedFileHandoff: locate });
  mocks.list = [{ ...transfer, disposition: "saved", savedPath: "C:\\remote\\untrusted.zip" }];
  await using screen = await render(
    <ThreadFileSaveStatus thread={thread} id={transfer.id} fallback="等待保存" />,
    { router: false },
  );
  const open = screen.getByRole("button", { name: "打开所在位置" });
  await expect.element(open).toBeVisible();
  await userEvent.click(open);
  expect(locate.mock.calls).toEqual([
    [{ threadId: thread.threadId, transferId: transfer.id, reveal: false }],
    [{ threadId: thread.threadId, transferId: transfer.id, reveal: true }],
  ]);
  await expect.element(screen.getByText("文件已移动、删除或替换。")).toBeVisible();
});

it("withholds the folder action when the local desktop has no matching record", async () => {
  const locate = vi.fn().mockResolvedValue("unknown");
  using _bridge = stubGlobal("desktopBridge", { locateSavedFileHandoff: locate });
  mocks.list = [{ ...transfer, disposition: "saved", savedPath: "C:\\remote\\untrusted.zip" }];
  await using screen = await render(
    <ThreadFileSaveStatus thread={thread} id={transfer.id} fallback="等待保存" />,
    { router: false },
  );
  await expect.poll(() => locate.mock.calls.length).toBe(1);
  await expect
    .element(screen.getByRole("button", { name: "打开所在位置" }))
    .not.toBeInTheDocument();
});

it("shows a cancelled installation and its later verified retry in the original conversation", async () => {
  const apk = {
    ...transfer,
    name: "sample.apk",
    disposition: "saved" as const,
    savedPath: "Download/t3code/sample.apk",
    installation: { status: "cancelled" as const },
  };
  mocks.list = [apk];
  const result = <ThreadFileSaveStatus thread={thread} id={apk.id} fallback="等待保存" />;
  await using screen = await render(result, { router: false });
  await expect.element(screen.getByText(/已取消安装，文件已保留/)).toBeVisible();
  mocks.list = [
    {
      ...apk,
      installation: {
        status: "verified",
        packageName: "dev.t3.fixture",
        version: "1.0",
        versionCode: "9223372036854775807",
      },
    },
  ];
  await screen.rerender(<ThreadFileSaveStatus thread={thread} id={apk.id} fallback="等待保存" />);
  await expect
    .element(screen.getByText(/dev\.t3\.fixture 1\.0（9223372036854775807）/))
    .toBeVisible();
  await expect.element(screen.getByText(/已取消安装/)).not.toBeInTheDocument();
});
