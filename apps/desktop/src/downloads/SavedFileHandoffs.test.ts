// @effect-diagnostics nodeBuiltinImport:off - 在隔离目录验证持久化和真实文件状态。
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import { expect, it, vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  path: vi.fn<() => string>(),
  show: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: electron.path },
  shell: { showItemInFolder: electron.show },
}));

import {
  locateSavedFileHandoff,
  receivedHandoffKey,
  recordSavedFileHandoff,
} from "./SavedFileHandoffs.ts";

const threadId = "fixture-thread";
const transferId = "a0000000-0000-4000-a000-000000000003";
const threadKey = NodeCrypto.createHash("sha256").update(threadId).digest("hex");
const key = { threadKey, transferId };
const url = `https://test.invalid/api/assets/file-handoff/handoff.receive.${threadKey}.${transferId}.1800000000000.test-signature`;

it("recognizes the signed receive route and rejects uploads or altered paths", () => {
  expect(receivedHandoffKey(new URL(url))).toEqual(key);
  expect(receivedHandoffKey(new URL(url.replace(".receive.", ".upload.")))).toBeNull();
  expect(receivedHandoffKey(new URL(`${url}/extra`))).toBeNull();
  expect(receivedHandoffKey(new URL(`${url}?path=/tmp/file`))).toBeNull();
});

it("reads the completed local path from disk and refuses moved or replaced files", async () => {
  electron.show.mockClear();
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-saved-handoffs-"));
  electron.path.mockReturnValue(root);
  const saved = NodePath.join(root, "saved.txt");
  try {
    await NodeFSP.writeFile(saved, "saved bytes");
    const input = { threadId, transferId, reveal: false };
    expect(await locateSavedFileHandoff(input)).toBe("unknown");
    await recordSavedFileHandoff(key, saved);
    expect(
      await locateSavedFileHandoff({ ...input, threadId: "another-thread", reveal: true }),
    ).toBe("unknown");
    expect(await locateSavedFileHandoff(input)).toBe("available");
    expect(electron.show).not.toHaveBeenCalled();

    vi.resetModules();
    const reloaded = await import("./SavedFileHandoffs.ts");
    expect(await reloaded.locateSavedFileHandoff({ ...input, reveal: true })).toBe("available");
    expect(electron.show).toHaveBeenCalledExactlyOnceWith(saved);

    await NodeFSP.rename(saved, NodePath.join(root, "moved.txt"));
    expect(await reloaded.locateSavedFileHandoff({ ...input, reveal: true })).toBe("missing");
    await NodeFSP.writeFile(saved, "replacement");
    expect(await reloaded.locateSavedFileHandoff({ ...input, reveal: true })).toBe("missing");
    expect(electron.show).toHaveBeenCalledOnce();
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
