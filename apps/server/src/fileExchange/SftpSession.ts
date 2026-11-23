// @effect-diagnostics-next-line nodeBuiltinImport:off - SFTP 使用同一子进程的双向二进制管道。
import type * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// OpenSSH SFTP v3 的文件操作依照服务端声明的协议扩展执行。
const Kind = {
  init: 1,
  version: 2,
  open: 3,
  close: 4,
  read: 5,
  write: 6,
  lstat: 7,
  remove: 13,
  mkdir: 14,
  rmdir: 15,
  realpath: 16,
  status: 101,
  handle: 102,
  data: 103,
  name: 104,
  attrs: 105,
  extended: 200,
} as const;
const hardlinkExtension = "hardlink@openssh.com";
const renameExtension = "posix-rename@openssh.com";
export const sftpChunkBytes = 64 * 1024;
const maxPacketBytes = 256 * 1024;

function uint32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function uint64(value: number) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function protocolString(value: string | Buffer) {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([uint32(bytes.length), bytes]);
}

class Packet {
  private remaining: Buffer;

  constructor(bytes: Buffer) {
    this.remaining = bytes;
  }

  get hasData() {
    return this.remaining.length > 0;
  }

  read(length: number) {
    if (length > this.remaining.length) {
      throw new Error("The SFTP server returned an incomplete packet.");
    }
    const value = this.remaining.subarray(0, length);
    this.remaining = this.remaining.subarray(length);
    return value;
  }

  uint32() {
    return this.read(4).readUInt32BE();
  }

  string() {
    return this.read(this.uint32());
  }
}

class SftpStatusError extends Schema.TaggedError<
  SftpStatusError,
  { readonly brand: unique symbol }
>()("SftpStatusError", { status: Schema.Int }) {}

export class SftpConnectionError extends Schema.TaggedError<
  SftpConnectionError,
  { readonly brand: unique symbol }
>()("SftpConnectionError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export class SftpSession {
  private readonly stdout;
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private buffered: Buffer = Buffer.alloc(0);
  private requestId = 0;
  supportsPosixRename = false;

  constructor(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
    this.child = child;
    this.stdout = child.stdout[Symbol.asyncIterator]();
  }

  private async read(length: number) {
    while (this.buffered.length < length) {
      const result = await this.stdout.next().catch((cause: unknown) => {
        throw new SftpConnectionError({ message: "The SFTP connection could not be read.", cause });
      });
      if (result.done)
        throw new SftpConnectionError({
          message: "The SFTP connection closed during the file operation.",
        });
      this.buffered = Buffer.concat([this.buffered, result.value]);
    }
    const value = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    return value;
  }

  private async send(kind: number, ...parts: ReadonlyArray<Buffer>) {
    const body = Buffer.concat([Buffer.from([kind]), ...parts]);
    const framed = Buffer.concat([uint32(body.length), body]);
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(framed, (error) =>
        error
          ? reject(
              new SftpConnectionError({
                message: "The SFTP connection could not be written.",
                cause: error,
              }),
            )
          : resolve(),
      );
    });
    const length = (await this.read(4)).readUInt32BE();
    if (length === 0 || length > maxPacketBytes) {
      throw new Error("The SFTP server returned an invalid packet length.");
    }
    const response = new Packet(await this.read(length));
    return { kind: response.read(1)[0], response };
  }

  async initialize() {
    const { kind, response } = await this.send(Kind.init, uint32(3));
    if (kind !== Kind.version || response.uint32() !== 3) {
      throw new Error("The server must support SFTP version 3.");
    }
    let supportsHardlink = false;
    while (response.hasData) {
      const name = response.string().toString();
      const version = response.string().toString();
      if (name === hardlinkExtension && version === "1") supportsHardlink = true;
      if (name === renameExtension && version === "1") this.supportsPosixRename = true;
    }
    if (!supportsHardlink) {
      throw new Error(
        "The SFTP server must support creating hard links for safe file publication.",
      );
    }
  }

  private async request(kind: number, expected: number, ...parts: ReadonlyArray<Buffer>) {
    const id = ++this.requestId;
    const reply = await this.send(kind, uint32(id), ...parts);
    if (reply.response.uint32() !== id) {
      throw new Error("The SFTP server returned an invalid request identifier.");
    }
    if (reply.kind === Kind.status) {
      const status = reply.response.uint32();
      if (status !== 0 || expected !== Kind.status) throw new SftpStatusError({ status });
    }
    if (reply.kind !== expected) throw new Error("The SFTP server returned an unexpected reply.");
    return reply.response;
  }

  async realpath(path: string) {
    const reply = await this.request(Kind.realpath, Kind.name, protocolString(path));
    if (reply.uint32() !== 1) throw new Error("The SFTP server returned an invalid directory.");
    return reply.string().toString();
  }

  async regularFile(path: string, limit: number) {
    const reply = await this.request(Kind.lstat, Kind.attrs, protocolString(path));
    const flags = reply.uint32();
    const size = (flags & 1) !== 0 ? reply.read(8).readBigUInt64BE() : undefined;
    if ((flags & 2) !== 0) reply.read(8);
    if (size === undefined || (flags & 4) === 0 || (reply.uint32() & 0o170000) !== 0o100000) {
      throw new Error("Only regular files with a reported size can be transferred.");
    }
    if (size > BigInt(limit)) throw new Error("The source file is larger than the transfer limit.");
    const modifiedAt = (flags & 8) !== 0 ? reply.read(8).readUInt32BE(4) : undefined;
    return { size: Number(size), modifiedAt };
  }

  async existingRegularFile(path: string, limit: number) {
    try {
      return await this.regularFile(path, limit);
    } catch (error) {
      if (Schema.is(SftpStatusError)(error) && error.status === 2) return null;
      throw error;
    }
  }

  async exists(path: string) {
    try {
      await this.request(Kind.lstat, Kind.attrs, protocolString(path));
      return true;
    } catch (error) {
      if (Schema.is(SftpStatusError)(error) && error.status === 2) return false;
      throw error;
    }
  }

  async atomicRename(source: string, destination: string) {
    if (!this.supportsPosixRename)
      throw new Error("The SFTP server cannot capture a source atomically.");
    await this.request(
      Kind.extended,
      Kind.status,
      protocolString(renameExtension),
      protocolString(source),
      protocolString(destination),
    );
  }

  async mkdir(path: string) {
    await this.request(Kind.mkdir, Kind.status, protocolString(path), uint32(4), uint32(0o700));
  }

  async rmdir(path: string) {
    await this.request(Kind.rmdir, Kind.status, protocolString(path));
  }

  async remove(path: string) {
    await this.request(Kind.remove, Kind.status, protocolString(path));
  }

  async link(source: string, destination: string) {
    await this.request(
      Kind.extended,
      Kind.status,
      protocolString(hardlinkExtension),
      protocolString(source),
      protocolString(destination),
    );
  }

  private async open(path: string, flags: number) {
    const reply = await this.request(
      Kind.open,
      Kind.handle,
      protocolString(path),
      uint32(flags),
      uint32(4),
      uint32(0o600),
    );
    return protocolString(reply.string());
  }

  private async withHandle<T>(path: string, flags: number, use: (handle: Buffer) => Promise<T>) {
    const handle = await this.open(path, flags);
    let completed = false;
    try {
      const result = await use(handle);
      completed = true;
      return result;
    } finally {
      const close = this.request(Kind.close, Kind.status, handle);
      if (completed) await close;
      else await close.catch(() => {});
    }
  }

  async writeChunks(
    path: string,
    offset: number,
    create: boolean,
    readChunk: (offset: number) => Promise<Buffer | null>,
    acknowledge: (offset: number) => void,
  ) {
    // 重连复用私有目录中的暂存文件。未收到确认的块从原位置重写。
    await this.withHandle(path, create ? 2 | 8 | 32 : 2, async (handle) => {
      let next = offset;
      for (;;) {
        const chunk = await readChunk(next);
        if (chunk === null) return;
        await this.request(Kind.write, Kind.status, handle, uint64(next), protocolString(chunk));
        next += chunk.length;
        acknowledge(next);
      }
    });
  }

  async readChunks(
    path: string,
    limit: number,
    offset: number,
    onChunk: (data: Buffer) => Promise<void> | void,
  ) {
    return this.withHandle(path, 1, async (handle) => {
      let size = offset;
      for (;;) {
        const requested = Math.min(sftpChunkBytes, limit - size + 1);
        let reply: Packet;
        try {
          reply = await this.request(Kind.read, Kind.data, handle, uint64(size), uint32(requested));
        } catch (error) {
          if (Schema.is(SftpStatusError)(error) && error.status === 1) return size;
          throw error;
        }
        const data = reply.string();
        if (data.length === 0 || data.length > requested) {
          throw new Error("The SFTP server returned an invalid file data packet.");
        }
        size += data.length;
        if (size > limit) throw new Error("The source file is larger than the transfer limit.");
        await onChunk(data);
      }
    });
  }
}
