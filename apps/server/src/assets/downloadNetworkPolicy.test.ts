import { describe, expect, it } from "vite-plus/test";
import { externalDownloadMaxBytes, permitsFileDownload } from "./downloadNetworkPolicy.ts";

describe("file download network policy", () => {
  const sizeBytes = 51n * 1024n * 1024n;
  const request = (address: string | undefined, headers: Record<string, string> = {}) => ({
    sizeBytes,
    source: { socket: { remoteAddress: address } },
    headers,
  });

  it("allows small remote files and enforces the exact configurable threshold", () => {
    expect(permitsFileDownload({ ...request("8.8.8.8"), sizeBytes: 50n * 1024n * 1024n })).toBe(
      true,
    );
    expect(permitsFileDownload(request("8.8.8.8"))).toBe(false);
    expect(
      permitsFileDownload({ ...request("8.8.8.8"), externalMaxBytes: 60n * 1024n * 1024n }),
    ).toBe(true);
    expect(externalDownloadMaxBytes("60")).toBe(60n * 1024n * 1024n);
    for (const value of [undefined, "", "NaN", "0", "-1", "1.5"]) {
      expect(externalDownloadMaxBytes(value)).toBe(50n * 1024n * 1024n);
    }
  });

  it("allows real private peers, including IPv4 mapped and IPv6 local peers", () => {
    for (const address of [
      "192.168.5.2",
      "10.2.3.4",
      "172.16.1.2",
      "127.0.0.1",
      "::ffff:192.168.5.2",
      "::ffff:c0a8:502",
      "::1",
      "0:0:0:0:0:0:0:1",
      "fd12::1",
      "fe80::2",
      "fe80::2%eth0",
    ]) {
      expect(permitsFileDownload(request(address)), address).toBe(true);
    }
  });

  it("rejects public, absent or malformed peers regardless of claimed host", () => {
    for (const address of [
      "8.8.8.8",
      "172.32.1.2",
      "192.168.evil",
      "100.64.0.1",
      "2001:4860::1",
      "::",
      undefined,
    ]) {
      expect(
        permitsFileDownload(request(address, { host: "192.168.5.25:3773" })),
        String(address),
      ).toBe(false);
    }
    expect(
      permitsFileDownload({ sizeBytes, source: new Request("http://localhost"), headers: {} }),
    ).toBe(false);
  });

  it("does not grant LAN access from forwarding headers or a local proxy", () => {
    for (const address of ["127.0.0.1", "192.168.5.2", "8.8.8.8"]) {
      for (const headers of [
        { "x-forwarded-for": "192.168.5.2" },
        { forwarded: "for=192.168.5.2" },
        { "x-real-ip": "192.168.5.2" },
      ]) {
        expect(permitsFileDownload(request(address, headers))).toBe(false);
      }
    }
  });
});
