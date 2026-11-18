// @effect-diagnostics nodeBuiltinImport:off - Native event and subprocess boundary tests.
import * as NodeEvents from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  access: vi.fn(),
  dialog: vi.fn(),
  sender: vi.fn(),
  owner: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({
  access: mocks.access,
  readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
  writeFile: vi.fn().mockResolvedValue(undefined),
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
  safeDownloadName,
  validateDownloadUrl,
} from "./FileDownloads.ts";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(process, "platform", { ...platform, value: "linux" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
});
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

  it("submits structured arguments to IDM once without starting a second engine", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "(Default) REG_SZ C:\\Custom IDM\\IDMan.exe\n");
    });
    mocks.access.mockResolvedValue(undefined);
    const child = new NodeEvents.EventEmitter();
    const unref = vi.fn();
    Object.assign(child, { unref });
    mocks.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    expect(await downloadFile({ url, fileName: "安装包.exe" }, 7, "win32")).toEqual({
      method: "idm",
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(["/d", url, "/f", "安装包.exe"]);
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false });
    expect(mocks.dialog).not.toHaveBeenCalled();
  });

  it("cancelling the save picker leaves no download listener or network request", async () => {
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
