import type { DesktopFileDownloadEvent } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn() },
}));
import { startVerifiedDesktopDownload } from "./fileDownload";

const expected = "a".repeat(64);
const file = {
  url: "https://test.invalid/api/assets/file-handoff/token",
  fileName: "archive.zip",
  sha256: expected,
};
let event: DesktopFileDownloadEvent;
const listeners = new Set<(event: DesktopFileDownloadEvent) => void>();

beforeEach(() => {
  event = {
    id: "desktop-download",
    fileName: file.fileName,
    state: "completed",
    receivedBytes: 12,
    totalBytes: 12,
    savedPath: "C:\\downloads\\archive.zip",
  };
  vi.stubGlobal("window", {
    desktopBridge: {
      onFileDownload: (listener: (event: DesktopFileDownloadEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      downloadFile: async () => {
        for (const listener of listeners) listener(event);
        return { method: "builtin", id: event.id };
      },
    },
  });
});

it("rejects the old completion-only event and mismatched digest", async () => {
  await expect(startVerifiedDesktopDownload(file)).rejects.toThrow("SHA-256");
  event = { ...event, verifiedSha256: "b".repeat(64) };
  await expect(startVerifiedDesktopDownload(file)).rejects.toThrow("SHA-256");
});

it("returns a completed handoff with the expected verified digest", async () => {
  event = { ...event, verifiedSha256: expected };
  await expect(startVerifiedDesktopDownload(file)).resolves.toEqual(event);
});
