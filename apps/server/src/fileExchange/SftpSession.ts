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
const chunkBytes = 64 * 1024;
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

export class SftpSession {
  private readonly stdout;
  private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  private buffered: Buffer = Buffer.alloc(0);
  private requestId = 0;

  constructor(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
    this.child = child;
    this.stdout = child.stdout[Symbol.asyncIterator]();
  }

  private async read(length: number) {
    while (this.buffered.length < length) {
      const result = await this.stdout.next();
      if (result.done) throw new Error("The SFTP connection closed during the file operation.");
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
      this.child.stdin.write(framed, (error) => (error ? reject(error) : resolve()));
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
    while (response.hasData) {
      const name = response.string().toString();
      const version = response.string().toString();
      if (name === hardlinkExtension && version === "1") return;
    }
    throw new Error("The SFTP server must support creating hard links for safe file publication.");
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

  async assertRegularFile(path: string, limit: number) {
    const reply = await this.request(Kind.lstat, Kind.attrs, protocolString(path));
    const flags = reply.uint32();
    if ((flags & 1) !== 0 && reply.read(8).readBigUInt64BE() > BigInt(limit)) {
      throw new Error("The source file is larger than the transfer limit.");
    }
    if ((flags & 2) !== 0) reply.read(8);
    if ((flags & 4) === 0 || (reply.uint32() & 0o170000) !== 0o100000) {
      throw new Error("Only regular files can be transferred.");
    }
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

  async writeFile(path: string, data: Buffer) {
    // WRITE | CREAT | EXCL，原子拒绝已有路径，包括符号链接。
    const handle = await this.open(path, 2 | 8 | 32);
    try {
      for (let offset = 0; offset < data.length; offset += chunkBytes) {
        const chunk = data.subarray(offset, offset + chunkBytes);
        await this.request(Kind.write, Kind.status, handle, uint64(offset), protocolString(chunk));
      }
    } finally {
      await this.request(Kind.close, Kind.status, handle);
    }
  }

  async readFile(path: string, limit: number) {
    const handle = await this.open(path, 1);
    const chunks: Array<Buffer> = [];
    let size = 0;
    try {
      for (;;) {
        const requested = Math.min(chunkBytes, limit - size + 1);
        try {
          const reply = await this.request(
            Kind.read,
            Kind.data,
            handle,
            uint64(size),
            uint32(requested),
          );
          const data = reply.string();
          if (data.length === 0 || data.length > requested) {
            throw new Error("The SFTP server returned an invalid file data packet.");
          }
          size += data.length;
          if (size > limit) throw new Error("The source file is larger than the transfer limit.");
          chunks.push(data);
        } catch (error) {
          if (Schema.is(SftpStatusError)(error) && error.status === 1) break;
          throw error;
        }
      }
      return Buffer.concat(chunks, size);
    } finally {
      await this.request(Kind.close, Kind.status, handle);
    }
  }
}
