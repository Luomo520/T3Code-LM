// @effect-diagnostics nodeBuiltinImport:off - Native Electron event boundary tests.
import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  downloadToFile: vi.fn(),
  dialog: vi.fn(),
  sender: vi.fn(),
  owner: vi.fn(),
  lstat: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  lstat: mocks.lstat,
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./ResumableDownload.ts", () => ({
  downloadKey: () => "destination",
  downloadToFile: mocks.downloadToFile,
}));
vi.mock("electron", () => ({
  webContents: { fromId: mocks.sender },
  BrowserWindow: { fromWebContents: mocks.owner },
  dialog: { showSaveDialog: mocks.dialog },
  app: { getPath: () => "/downloads" },
}));
import {
  cancelFileDownload,
  downloadFile,
  downloadHandoffFile,
  safeDownloadName,
  validateDownloadUrl,
} from "./FileDownloads.ts";

const url = "http://192.168.5.25:3773/api/assets/signed-token/file.exe";

describe("file downloads", () => {
  it("rejects executable protocols, credentials and non-asset endpoints", () => {
    for (const candidate of [
      "file:///tmp/test",
      "javascript:alert(1)",
      "https://u:p@host/api/assets/a/b",
      "https://host/api/environment",
    ]) {
      expect(() => validateDownloadUrl(candidate)).toThrow();
    }
    expect(validateDownloadUrl(url)).toBe(url);
    expect(safeDownloadName("../CON.exe")).not.toContain("/");
    expect(safeDownloadName("CON.exe")).toBe("download-CON.exe");
    expect(safeDownloadName("安装包.apk")).toBe("安装包.apk");
  });

  it("uses the built-in downloader on Windows and allows only the initiating renderer to cancel", async () => {
    vi.clearAllMocks();
    const session = new NodeEvents.EventEmitter();
    const events = new NodeEvents.EventEmitter();
    const sender = {
      id: 7,
      isDestroyed: () => false,
      session,
      send: (_channel: string, event: { state: string }) => events.emit(event.state, event),
      downloadURL: vi.fn(),
    };
    mocks.sender.mockReturnValue(sender);
    mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/downloads/安装包.exe" });
    mocks.downloadToFile.mockImplementation(({ signal, onProgress }) => {
      onProgress({ receivedBytes: 10, totalBytes: 20 });
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const finished = new Promise((resolve) => events.once("cancelled", resolve));
    const { method, id } = await downloadFile({ url, fileName: "安装包.exe" }, 7, "win32");
    expect(method).toBe("builtin");
    expect(id).toBeDefined();
    expect(sender.downloadURL).not.toHaveBeenCalled();
    expect(session.listenerCount("will-download")).toBe(0);
    cancelFileDownload(id!, 8);
    expect(mocks.downloadToFile.mock.calls[0]?.[0].signal.aborted).toBe(false);
    cancelFileDownload(id!, 7);
    expect(await finished).toMatchObject({ receivedBytes: 10, totalBytes: 20 });
  });

  it("saves one copy of an agent transfer with a verified size and checksum, without opening a picker", async () => {
    vi.clearAllMocks();
    const transferId = "a0000000-0000-4000-a000-000000000001";
    const sha256 = "b".repeat(64);
    const fileName = "收到的文件.txt";
    const signedUrl = `https://thread.test/api/assets/file-handoff/handoff.receive.${"a".repeat(64)}.${transferId}.1800000000000.test-signature`;
    const send = vi.fn();
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        headers: { etag: `"sha256-${sha256}"` },
      }),
    );
    mocks.sender.mockReturnValue({ id: 7, isDestroyed: () => false, session: { fetch }, send });
    mocks.lstat
      .mockResolvedValueOnce({ isFile: () => true, size: 20 })
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    mocks.downloadToFile.mockResolvedValue(undefined);

    const request = { url: signedUrl, fileName, transferId, sizeBytes: 22, sha256 };
    const result = await Promise.all([
      downloadHandoffFile(request, 7),
      downloadHandoffFile(request, 7),
    ]);
    expect(result[0]).toEqual(result[1]);
    expect(result[0]?.savedPath).toMatch(/收到的文件 \(00000001\)\.txt$/u);
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.downloadToFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        checksums: [{ algorithm: "sha256", expectedHex: sha256 }],
        expectedSizeBytes: 22,
        exclusiveDestination: true,
      }),
    );
    expect(send).toHaveBeenLastCalledWith(
      "desktop:file-download-event",
      expect.objectContaining({
        state: "completed",
        savedPath: result[0]?.savedPath,
      }),
    );
  });

  it("cancelling the save picker leaves no download listener or network request", async () => {
    vi.clearAllMocks();
    const session = new NodeEvents.EventEmitter();
    const downloadURL = vi.fn();
    mocks.sender.mockReturnValue({ id: 7, isDestroyed: () => false, session, downloadURL });
    mocks.dialog.mockResolvedValue({ canceled: true });
    expect(await downloadFile({ url, fileName: "file.exe" }, 7, "linux")).toEqual({
      method: "cancelled",
    });
    expect(session.listenerCount("will-download")).toBe(0);
    expect(downloadURL).not.toHaveBeenCalled();
  });

  it("routes progress, cancellation and completion to the initiating window", async () => {
    vi.clearAllMocks();
    const session = new NodeEvents.EventEmitter();
    const item = Object.assign(new NodeEvents.EventEmitter(), {
      getURLChain: () => [url],
      setSavePath: vi.fn(),
      getReceivedBytes: () => 5,
      getTotalBytes: () => 10,
      cancel: vi.fn(),
    });
    const sender = {
      id: 7,
      isDestroyed: () => false,
      session,
      send: vi.fn(),
      downloadURL: vi.fn(() => session.emit("will-download", {}, item, sender)),
    };
    mocks.sender.mockReturnValue(sender);
    mocks.dialog.mockResolvedValue({ canceled: false, filePath: "/downloads/file.exe" });
    const result = await downloadFile({ url, fileName: "file.exe" }, 7, "linux");
    expect(result.method).toBe("electron");
    expect(session.listenerCount("will-download")).toBe(0);
    item.emit("updated", {}, "progressing");
    expect(sender.send).toHaveBeenLastCalledWith(
      "desktop:file-download-event",
      expect.objectContaining({ state: "progressing", receivedBytes: 5 }),
    );
    cancelFileDownload(result.id!, 8);
    expect(item.cancel).not.toHaveBeenCalled();
    cancelFileDownload(result.id!, 7);
    expect(item.cancel).toHaveBeenCalledTimes(1);
    item.emit("done", {}, "completed");
    expect(sender.send).toHaveBeenLastCalledWith(
      "desktop:file-download-event",
      expect.objectContaining({ state: "completed" }),
    );
  });
});
