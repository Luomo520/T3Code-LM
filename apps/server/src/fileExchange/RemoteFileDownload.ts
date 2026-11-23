// @effect-diagnostics nodeBuiltinImport:off -- 固定连接地址并流式保存文件，避免重复 DNS 解析和无边界缓冲。
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeNet from "node:net";
import { FileHandoffError } from "@t3tools/contracts";

import {
  isLocalNetworkAddress,
  resolveNetworkAddresses,
} from "../assets/publicNetworkAddresses.ts";

const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 45_000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const publicIPv6 = new NodeNet.BlockList();
publicIPv6.addSubnet("2000::", 3, "ipv6");
const nonPublicAddresses = new NodeNet.BlockList();
for (const [network, prefix] of [
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
] as const) {
  nonPublicAddresses.addSubnet(network, prefix, "ipv4");
}
nonPublicAddresses.addSubnet("2001::", 23, "ipv6");
nonPublicAddresses.addSubnet("2001:db8::", 32, "ipv6");
nonPublicAddresses.addSubnet("2002::", 16, "ipv6");
nonPublicAddresses.addSubnet("3fff::", 20, "ipv6");

const failure = (message: string) => new FileHandoffError({ message });

export function remoteFileUrl(input: string, base?: URL): URL {
  const url = URL.parse(input, base?.href);
  if (
    !url ||
    url.href.length > 4096 ||
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    (base?.protocol === "https:" && url.protocol !== "https:")
  ) {
    throw failure("请使用公开的 HTTP 或 HTTPS 文件网址。");
  }
  url.hash = "";
  return url;
}

export function remoteFileName(url: URL): string {
  let name = url.pathname.split("/").at(-1) ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // 遇到非法编码时保留原文件名。
  }
  const safe = Array.from(name.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, "_").trim())
    .slice(0, 220)
    .join("")
    .replace(/[. ]+$/u, "");
  return !safe || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(safe)
    ? "download.bin"
    : safe;
}

export function isPublicFileDownloadAddress(address: string, family: number): boolean {
  const kind = family === 6 ? "ipv6" : "ipv4";
  return (
    !isLocalNetworkAddress(address, family) &&
    !nonPublicAddresses.check(address, kind) &&
    (family !== 6 || publicIPv6.check(address, "ipv6"))
  );
}

async function requestFile(url: URL, signal: AbortSignal): Promise<NodeHttp.IncomingMessage> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "");
  const addresses = await resolveNetworkAddresses(hostname);
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some(({ address, family }) => !isPublicFileDownloadAddress(address, family))
  ) {
    throw failure("该文件网址无法解析到公开网络地址。");
  }
  // 连接固定在刚核对的 DNS 结果，TLS 仍按原域名校验。
  return new Promise((resolve, reject) => {
    const get = url.protocol === "https:" ? NodeHttps.get : NodeHttp.get;
    const options: NodeHttp.RequestOptions & Pick<NodeNet.TcpNetConnectOpts, "autoSelectFamily"> = {
      agent: false,
      autoSelectFamily: true,
      headers: { "Accept-Encoding": "identity" },
      signal,
      lookup: (_hostname, lookupOptions, callback) =>
        lookupOptions.all
          ? callback(null, addresses)
          : callback(null, addresses[0]!.address, addresses[0]!.family),
    };
    const request = get(url, options, resolve);
    request.once("error", reject);
  });
}

export async function fetchRemoteFile(
  address: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  request = requestFile,
): Promise<{ sizeBytes: number; sha256: string }> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]);
  let url = remoteFileUrl(address);
  let redirects = 0;
  while (true) {
    deadline.throwIfAborted();
    const response = await request(url, deadline);
    try {
      if (REDIRECT_CODES.has(response.statusCode ?? 0)) {
        const location = response.headers.location;
        if (!location || redirects++ >= MAX_REDIRECTS) throw failure("下载网址重定向次数过多。");
        url = remoteFileUrl(location, url);
        continue;
      }
      if (response.statusCode !== 200) throw failure("下载来源未返回文件。");
      if (
        !response.headers["content-disposition"]?.toLowerCase().startsWith("attachment") &&
        /^(?:text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(
          response.headers["content-type"] ?? "",
        )
      ) {
        throw failure("该网址返回的是网页，请使用文件的直接下载网址。");
      }
      const length = response.headers["content-length"];
      if (length !== undefined && Number(length) > maxBytes)
        throw failure("文件超过下载大小限制。");
      const output = await NodeFSP.open(path, "wx", 0o600);
      let sizeBytes = 0;
      const hash = NodeCrypto.createHash("sha256");
      try {
        for await (const part of response) {
          deadline.throwIfAborted();
          const chunk = Buffer.from(part);
          sizeBytes += chunk.byteLength;
          if (sizeBytes > maxBytes) throw failure("文件超过下载大小限制。");
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        if (length !== undefined && sizeBytes !== Number(length))
          throw failure("下载中断，请重试。");
        await output.sync();
        return { sizeBytes, sha256: hash.digest("hex") };
      } finally {
        await output.close();
      }
    } finally {
      response.destroy();
    }
  }
}
