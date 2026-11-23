import { EnvironmentId, ThreadId, type FileHandoffInboxTransfer } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  enqueueFileDownload: vi.fn(),
  fileHandoffDownloadKey: vi.fn(() => Promise.resolve("device-transfer-key")),
  readHandoffDownload: vi.fn(),
}));
vi.mock("../../lib/systemFileDownload", () => native);

import { advanceAutomaticHandoff } from "./automatic-file-handoff";

function fixture() {
  native.enqueueFileDownload.mockReset();
  native.fileHandoffDownloadKey.mockClear();
  native.readHandoffDownload.mockReset();
  const item: FileHandoffInboxTransfer = {
    id: "00000000-0000-0000-0000-000000000001",
    threadId: ThreadId.make("origin-thread"),
    name: "report.txt",
    sizeBytes: 12,
    sha256: "a".repeat(64),
    senderLabel: "会话文件",
    expiresAt: Number.MAX_SAFE_INTEGER,
    autoReceive: true,
  };
  const options = {
    environmentId: EnvironmentId.make("linked-environment"),
    httpBaseUrl: "http://127.0.0.1:3773",
    active: vi.fn(() => true),
    request: vi.fn(),
  };
  return { item, options };
}

it("resends a locally verified receipt to the originating thread without another download", async () => {
  const { item, options } = fixture();
  native.readHandoffDownload.mockResolvedValue({
    status: "downloaded",
    uri: "content://downloads/7",
  });
  options.request.mockResolvedValue({ _tag: "finished", disposition: "saved" });

  expect(await advanceAutomaticHandoff(item, options)).toBe("saved");
  expect(native.fileHandoffDownloadKey).toHaveBeenCalledWith(
    options.environmentId,
    item.threadId,
    item.id,
  );
  expect(options.request).toHaveBeenCalledWith({
    _tag: "confirmSaved",
    threadId: item.threadId,
    id: item.id,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    savedPath: "content://downloads/7",
  });
  expect(native.enqueueFileDownload).not.toHaveBeenCalled();
});

it("reuses the transfer key with a fresh token and skips an active download", async () => {
  const { item, options } = fixture();
  native.readHandoffDownload
    .mockResolvedValueOnce({ status: "downloading", nativeId: "first-task" })
    .mockResolvedValueOnce({ status: "paused", retryable: true });
  options.request.mockResolvedValue({
    _tag: "receive",
    name: item.name,
    sizeBytes: item.sizeBytes,
    sha256: item.sha256,
    relativeUrl: "/api/assets/file-handoff/refreshed-token",
  });

  expect(await advanceAutomaticHandoff(item, options)).toBe("waiting");
  expect(options.request).not.toHaveBeenCalled();
  await advanceAutomaticHandoff(item, options);
  expect(native.enqueueFileDownload).toHaveBeenCalledExactlyOnceWith(
    `${options.httpBaseUrl}/api/assets/file-handoff/refreshed-token`,
    item.name,
    item.sizeBytes,
    item.sha256,
    "device-transfer-key",
    true,
  );
});

it("does not start a download if the app goes into the background while obtaining a token", async () => {
  const { item, options } = fixture();
  native.readHandoffDownload.mockResolvedValue(null);
  options.request.mockImplementation(async () => {
    options.active.mockReturnValue(false);
    return {
      _tag: "receive",
      name: item.name,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      relativeUrl: "/api/assets/file-handoff/token",
    };
  });

  await advanceAutomaticHandoff(item, options);
  expect(native.enqueueFileDownload).not.toHaveBeenCalled();
});
