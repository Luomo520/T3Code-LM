import { AsyncResult } from "effect/reactivity";
import { AuthSessionId, EnvironmentId, ThreadId, type FileHandoffReply } from "@t3tools/contracts";
import { createSha256 } from "@t3tools/shared/sha256";
import { describe, expect, it, vi } from "vite-plus/test";
import { sendHandoffFile } from "./fileHandoff.ts";
import { receiveDirectFile, type HandoffFrame, type HandoffPeer } from "./fileHandoffDirect.ts";

const threadId = ThreadId.make("thread");
const id = "12345678-1234-1234-1234-123456789012";
const contents = Uint8Array.of(1, 2, 3, 4);
const sha = createSha256();
sha.update(contents);
const sha256 = sha.digestHex();

function peer(frames: HandoffFrame[]): HandoffPeer {
  return {
    offer: async () => "receiver SDP",
    answer: async () => "sender SDP",
    finish: async () => {},
    open: async () => {},
    send: async () => {},
    next: async () => frames.shift() ?? "",
    close() {},
  };
}

describe("文件直连接收", () => {
  it("校验完大小和 SHA-256 才发布接收文件", async () => {
    const request = async (): Promise<FileHandoffReply> => ({
      _tag: "direct",
      state: "active",
      answer: "sender SDP",
    });
    const publish = vi.fn(async () => {});
    const write = vi.fn(async () => {});
    const options = {
      threadId,
      id,
      item: {
        id,
        name: "test.bin",
        directSha256: sha256,
        sha256: null,
        sizeBytes: 4,
        senderLabel: "PC",
        recipientLabel: "Android",
        outgoing: false,
      },
      signal: new AbortController().signal,
      request,
      publish,
      write,
    };
    await expect(
      receiveDirectFile({ ...options, makePeer: () => peer([Uint8Array.of(9, 2, 3, 4), "done"]) }),
    ).rejects.toThrow("SHA-256");
    expect(publish).not.toHaveBeenCalled();
    await expect(
      receiveDirectFile({ ...options, makePeer: () => peer([contents, "done"]) }),
    ).resolves.toEqual({ id, sizeBytes: 4, sha256 });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("直连协商失败后沿用同一条传输记录和中转地址", async () => {
    const start = vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/file-handoff/staged",
        offset: 0,
        ready: false,
        direct: true,
      }),
    );
    const post = vi.fn(async () => ({ ok: true, status: 200 }));
    const request = vi.fn(
      async () => ({ _tag: "direct", state: "closed" }) satisfies FileHandoffReply,
    );
    await sendHandoffFile({
      httpBaseUrl: "http://127.0.0.1:3777",
      environmentId: EnvironmentId.make("env"),
      input: {
        threadId,
        id,
        name: "test.bin",
        sizeBytes: 4,
        recipient: AuthSessionId.make("device"),
        direct: true,
      },
      start,
      post,
      signal: new AbortController().signal,
      onProgress: () => {},
      slice: async () => contents,
      direct: { makePeer: () => peer([]), request },
    });
    expect(start).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: expect.objectContaining({ id, sha256 }) }),
    );
    expect(request).toHaveBeenCalledWith({ _tag: "directAbandon", threadId, id });
    expect(post).toHaveBeenCalledOnce();
  });

  it("成功直传只发送文件字节给接收端", async () => {
    const start = async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/file-handoff/staged",
        offset: 0,
        ready: false,
        direct: true,
      });
    const send = vi.fn(async () => {});
    const post = vi.fn(async () => ({ ok: true, status: 200 }));
    let statusReads = 0;
    const request = async (): Promise<FileHandoffReply> =>
      ++statusReads >= 3
        ? { _tag: "direct", state: "saved" }
        : { _tag: "direct", state: "active", offer: "peer SDP" };
    await sendHandoffFile({
      httpBaseUrl: "http://127.0.0.1:3777",
      environmentId: EnvironmentId.make("env"),
      input: {
        threadId,
        id,
        name: "test.bin",
        sizeBytes: 4,
        recipient: AuthSessionId.make("device"),
        direct: true,
      },
      start,
      post,
      signal: new AbortController().signal,
      onProgress: () => {},
      slice: async () => contents,
      direct: { makePeer: () => ({ ...peer(["next", "next"]), send }), request },
    });
    expect(send.mock.calls).toEqual([[contents], ["done"]]);
    expect(post).not.toHaveBeenCalled();
  });
});
