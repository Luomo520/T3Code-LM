// @effect-diagnostics nodeBuiltinImport:off - Exercise real HTTP streams and on-disk checkpoints.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { downloadToFile } from "./ResumableDownload.ts";

async function fixture(reply: NodeHttp.RequestListener) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-download-"));
  const server = NodeHttp.createServer(reply);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("Server did not listen");
  return {
    directory,
    url: `http://127.0.0.1:${address.port}/asset`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(directory, { recursive: true, force: true });
    },
  };
}

function sendRange(
  response: NodeHttp.ServerResponse,
  data: Buffer,
  range: string | undefined,
  etag: string,
) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
  if (!match) {
    response.writeHead(200, { "content-length": data.length, etag }).end(data);
    return;
  }
  const from = Number(match[1]);
  const to = Number(match[2]);
  response
    .writeHead(206, {
      "content-length": to - from + 1,
      "content-range": `bytes ${from}-${to}/${data.length}`,
      etag,
    })
    .end(data.subarray(from, to + 1));
}

const checksum = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

it("resumes only completed ranges after a network failure and a refreshed URL", async () => {
  const segmentBytes = 8 * 1024 * 1024;
  const data = Buffer.concat([
    Buffer.alloc(segmentBytes, 1),
    Buffer.alloc(segmentBytes, 2),
    Buffer.alloc(segmentBytes, 3),
    Buffer.alloc(segmentBytes, 4),
    Buffer.alloc(4096, 5),
  ]);
  const ranges: string[] = [];
  const initialRequests: Array<() => void> = [];
  let parallel = false;
  await using source = await fixture((request, response) => {
    const range = request.headers.range;
    if (range !== undefined && range !== "bytes=0-0") {
      ranges.push(range);
      expect(request.headers["if-range"]).toBe('"v1"');
      if (request.url?.endsWith("first")) {
        if (range.startsWith(`bytes=${segmentBytes * 4}-`)) {
          response.writeHead(503).end();
          return;
        }
        initialRequests.push(() => sendRange(response, data, range, '"v1"'));
        if (initialRequests.length === 4) {
          parallel = true;
          for (const reply of initialRequests) reply();
        }
        return;
      }
    }
    sendRange(response, data, range, '"v1"');
  });
  const destination = NodePath.join(source.directory, "saved.bin");
  const options = {
    fetch,
    url: `${source.url}?token=first`,
    destination,
    stagingDirectory: NodePath.join(source.directory, "partial"),
    source: "asset",
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  await expect(downloadToFile(options)).rejects.toThrow("HTTP 503");
  expect(parallel).toBe(true);
  await expect(NodeFSP.access(destination)).rejects.toMatchObject({ code: "ENOENT" });
  const done = (await NodeFSP.readdir(options.stagingDirectory)).filter((file) =>
    file.startsWith("done-"),
  );
  expect(done.length).toBeGreaterThan(0);
  ranges.length = 0;
  const received: number[] = [];
  await downloadToFile({
    ...options,
    url: `${source.url}?token=second`,
    onProgress: (progress) => received.push(progress.receivedBytes),
  });
  expect(received[0]).toBe(done.length * segmentBytes);
  for (const file of done) {
    const start = Number(file.slice("done-".length)) * segmentBytes;
    expect(ranges).not.toContain(`bytes=${start}-${start + segmentBytes - 1}`);
  }
  expect(checksum(await NodeFSP.readFile(destination))).toBe(checksum(data));
  await expect(NodeFSP.access(options.stagingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("falls back to a sequential download and publishes only a verified installer", async () => {
  const data = Buffer.from("the update artifact");
  await using source = await fixture((_request, response) =>
    sendRange(response, data, undefined, '"v1"'),
  );
  const destination = NodePath.join(source.directory, "installer.exe");
  await NodeFSP.writeFile(destination, "existing file");
  const options = {
    fetch,
    url: source.url,
    destination,
    stagingDirectory: NodePath.join(source.directory, "partial"),
    source: "installer",
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  await expect(
    downloadToFile({
      ...options,
      checksums: [{ algorithm: "sha256", expectedHex: "0".repeat(64) }],
    }),
  ).rejects.toThrow("checksum");
  expect(await NodeFSP.readFile(destination, "utf8")).toBe("existing file");
  await downloadToFile({
    ...options,
    checksums: [{ algorithm: "sha256", expectedHex: checksum(data) }],
  });
  expect(await NodeFSP.readFile(destination)).toEqual(data);
});
