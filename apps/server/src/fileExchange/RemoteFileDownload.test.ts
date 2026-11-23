// @effect-diagnostics nodeBuiltinImport:off -- 使用 Node 类型和文件验证生产下载写入。
import * as NodeFSP from "node:fs/promises";
import type * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import { expect, it, vi } from "vite-plus/test";

import {
  fetchRemoteFile,
  isPublicFileDownloadAddress,
  remoteFileUrl,
} from "./RemoteFileDownload.ts";

function response(
  statusCode: number,
  headers: NodeHttp.IncomingMessage["headers"] = {},
  chunks: string[] = [],
) {
  return Object.assign(NodeStream.Readable.from(chunks), {
    statusCode,
    headers,
  }) as NodeHttp.IncomingMessage;
}

it("streams an ordinary file after a redirect and calculates its digest", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-url-download-test-"));
  const file = NodePath.join(directory, "report.bin");
  try {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: "https://files.example.com/report.bin" }))
      .mockResolvedValueOnce(response(200, { "content-length": "3" }, ["a", "bc"]));
    const result = await fetchRemoteFile(
      "https://example.com/report.bin",
      file,
      4,
      new AbortController().signal,
      request,
    );
    expect(request.mock.calls.map(([url]) => url.href)).toEqual([
      "https://example.com/report.bin",
      "https://files.example.com/report.bin",
    ]);
    expect(await NodeFSP.readFile(file, "utf8")).toBe("abc");
    expect(result).toEqual({
      sizeBytes: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("rejects private addresses, redirects to unsupported URLs, and a response beyond its streaming limit", async () => {
  expect(isPublicFileDownloadAddress("8.8.8.8", 4)).toBe(true);
  expect(isPublicFileDownloadAddress("2606:4700:4700::1111", 6)).toBe(true);
  expect(isPublicFileDownloadAddress("127.0.0.1", 4)).toBe(false);
  expect(isPublicFileDownloadAddress("169.254.169.254", 4)).toBe(false);
  expect(isPublicFileDownloadAddress("100.64.0.1", 4)).toBe(false);
  expect(isPublicFileDownloadAddress("::ffff:127.0.0.1", 6)).toBe(false);
  expect(isPublicFileDownloadAddress("64:ff9b::c0a8:101", 6)).toBe(false);
  expect(isPublicFileDownloadAddress("fec0::1", 6)).toBe(false);
  expect(() => remoteFileUrl("https://user:pass@example.com/file")).toThrow();
  expect(() => remoteFileUrl("http://example.com:3000/file")).toThrow();
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-url-download-test-"));
  try {
    const file = NodePath.join(directory, "report.bin");
    const signal = new AbortController().signal;
    const redirect = vi
      .fn()
      .mockResolvedValue(response(302, { location: "http://example.com/file" }));
    await expect(
      fetchRemoteFile("https://example.com/one", file, 4, signal, redirect),
    ).rejects.toMatchObject({
      message: "请使用公开的 HTTP 或 HTTPS 文件网址。",
    });
    expect(redirect).toHaveBeenCalledTimes(1);
    const tooLarge = vi.fn().mockResolvedValue(response(200, {}, ["12", "345"]));
    await expect(
      fetchRemoteFile("https://example.com/one", file, 4, signal, tooLarge),
    ).rejects.toMatchObject({
      message: "文件超过下载大小限制。",
    });
    expect(await NodeFSP.readFile(file, "utf8")).toBe("12");
    const alreadyCancelled = AbortSignal.abort(new Error("cancelled"));
    const cancelled = vi.fn();
    await expect(
      fetchRemoteFile("https://example.com/one", file, 4, alreadyCancelled, cancelled),
    ).rejects.toThrow("cancelled");
    expect(cancelled).not.toHaveBeenCalled();
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
