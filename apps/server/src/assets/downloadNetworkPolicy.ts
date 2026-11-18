import * as NodeNet from "node:net";

const MIB = 1024n * 1024n;
const DEFAULT_EXTERNAL_DOWNLOAD_MIB = 50n;
const privateDownloadPeers = new NodeNet.BlockList();
privateDownloadPeers.addSubnet("10.0.0.0", 8, "ipv4");
privateDownloadPeers.addSubnet("127.0.0.0", 8, "ipv4");
privateDownloadPeers.addSubnet("172.16.0.0", 12, "ipv4");
privateDownloadPeers.addSubnet("192.168.0.0", 16, "ipv4");
privateDownloadPeers.addSubnet("169.254.0.0", 16, "ipv4");
privateDownloadPeers.addAddress("::1", "ipv6");
privateDownloadPeers.addSubnet("fc00::", 7, "ipv6");
privateDownloadPeers.addSubnet("fe80::", 10, "ipv6");

export function externalDownloadMaxBytes(value: string | undefined): bigint {
  return value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))
    ? BigInt(value) * MIB
    : DEFAULT_EXTERNAL_DOWNLOAD_MIB * MIB;
}

function privateDownloadPeer(address: string): boolean {
  const normalized = address.split("%", 1)[0] ?? "";
  const version = NodeNet.isIP(normalized);
  return version !== 0 && privateDownloadPeers.check(normalized, version === 4 ? "ipv4" : "ipv6");
}

export function permitsFileDownload(input: {
  readonly sizeBytes: bigint;
  readonly externalMaxBytes?: bigint;
  readonly source: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}): boolean {
  if (input.sizeBytes <= (input.externalMaxBytes ?? DEFAULT_EXTERNAL_DOWNLOAD_MIB * MIB))
    return true;
  // Forwarded requests cannot establish the downloader's LAN location from the socket alone.
  if (
    ["forwarded", "x-forwarded-for", "x-real-ip", "x-forwarded-host", "x-forwarded-proto"].some(
      (name) => input.headers[name] !== undefined,
    )
  )
    return false;
  if (input.source === null || typeof input.source !== "object") return false;
  const source = input.source as {
    readonly remoteAddress?: unknown;
    readonly socket?: { readonly remoteAddress?: unknown } | null;
  };
  const address = source.socket?.remoteAddress ?? source.remoteAddress;
  return typeof address === "string" && privateDownloadPeer(address);
}
