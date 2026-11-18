import { describe, expect, it, vi } from "vite-plus/test";
import {
  BillingCache,
  BillingHttpError,
  decodeSub2Api,
  querySub2Api,
  usageUrl,
} from "./sub2api.ts";

const at = "2026-10-28T12:00:00Z";
const wallet = {
  mode: "wallet",
  balance: 12.5,
  unit: "USD",
  usage: { total: { total_tokens: 123456 }, today: { actual_cost: 1.25, cost: 99 } },
};

describe("Sub2API billing", () => {
  it("normalizes root, v1, and explicit query paths without changing the host", () => {
    for (const path of ["", "/", "/v1", "/v1/", "/v1/usage"]) {
      expect(usageUrl("https://example.test" + path)).toBe("https://example.test/v1/usage");
    }
    expect(usageUrl("https://example.test/proxy/v1")).toBe("https://example.test/proxy/v1/usage");
    for (const url of [
      "http://example.test",
      "https://key@example.test",
      "https://example.test/#key",
      "file:///tmp/test",
    ]) {
      expect(() => usageUrl(url)).toThrow();
    }
    expect(usageUrl("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234/v1/usage");
  });

  it("uses actual Key cost and preserves a real zero balance", () => {
    expect(decodeSub2Api(wallet, at)).toMatchObject({
      balance: 12.5,
      balanceKind: "balance",
      totalTokens: 123456,
      todayCost: 1.25,
    });
    expect(decodeSub2Api({ balance: 0 }, at)).toMatchObject({
      balance: 0,
      totalTokens: null,
      todayCost: null,
    });
    expect(decodeSub2Api({ data: wallet }, at)).toMatchObject({ balance: 12.5 });
    expect(() => decodeSub2Api({ message: "ok" }, at)).toThrow();
    expect(() => decodeSub2Api({ ...wallet, isValid: false }, at)).toThrow();
  });

  it("distinguishes Key quota, subscription and unavailable values", () => {
    expect(
      decodeSub2Api({ mode: "quota_limited", quota: { remaining: 3, unit: "USD" } }, at),
    ).toMatchObject({ balance: 3, balanceKind: "quota" });
    expect(decodeSub2Api({ subscription: { id: 1 }, remaining: 4, unit: "USD" }, at)).toMatchObject(
      { balance: 4, balanceKind: "subscription" },
    );
    expect(decodeSub2Api({ mode: "quota_limited", quota: {} }, at).balance).toBeNull();
  });

  it("performs a bounded authenticated GET and refuses redirects", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(wallet)));
    await expect(
      querySub2Api("https://example.test", "test-only", 60, fetcher),
    ).resolves.toMatchObject({ balance: 12.5 });
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/usage");
    expect(options).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer test-only" },
    });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    fetcher.mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "120" } }),
    );
    await expect(
      querySub2Api("https://example.test", "test-only", 60, fetcher),
    ).rejects.toMatchObject({ status: 429, retryAfterMs: 120000 });
    fetcher.mockResolvedValueOnce(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(querySub2Api("https://example.test", "test-only", 60, fetcher)).rejects.toThrow(
      "大小限制",
    );
  });

  it("merges parallel clients, enforces cadence and isolates changed credentials", async () => {
    let now = 0;
    const cache = new BillingCache(() => now);
    const load = vi.fn(async () => decodeSub2Api(wallet, at));
    cache.read("a", load, 60);
    cache.read("a", load, 60);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(1);
    now = 59999;
    expect(cache.read("a", load, 60).balance).toBe(12.5);
    expect(load).toHaveBeenCalledTimes(1);
    now = 60000;
    cache.read("a", load, 60);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(2);
    cache.read("b", load, 60);
    await cache.settle("b");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("retains last values and honors Retry-After during failure backoff", async () => {
    let now = 0;
    const cache = new BillingCache(() => now);
    const load = vi.fn(async () => decodeSub2Api(wallet, at));
    cache.read("a", load, 30);
    await cache.settle("a");
    now = 30000;
    load.mockRejectedValueOnce(BillingHttpError.fromStatus(429, 120000));
    cache.read("a", load, 30);
    await cache.settle("a");
    expect(cache.read("a", load, 30)).toMatchObject({ balance: 12.5, stale: true });
    now = 149999;
    cache.read("a", load, 30);
    expect(load).toHaveBeenCalledTimes(2);
    now = 150000;
    cache.read("a", load, 30);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.read("a", load, 30).stale).toBe(false);
  });

  it("allows page-entry refresh after 30 seconds and merges it with scheduled polling", async () => {
    let now = 0;
    const cache = new BillingCache(() => now);
    const load = vi.fn(async () => decodeSub2Api(wallet, at));
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    now = 29999;
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(1);
    now = 30000;
    cache.read("a", load, 60, undefined, true);
    cache.read("a", load, 60, undefined, true);
    cache.read("a", load, 60);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(2);
    now = 60000;
    cache.read("a", load, 60);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(2);
    now = 90000;
    cache.read("a", load, 60);
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("never lets page entry bypass failure backoff or Retry-After", async () => {
    let now = 0;
    const cache = new BillingCache(() => now);
    const load = vi.fn(async () => decodeSub2Api(wallet, at));
    cache.read("a", load, 60);
    await cache.settle("a");
    now = 30000;
    load.mockRejectedValueOnce(BillingHttpError.fromStatus(429, 120000));
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    expect(cache.read("a", load, 60, undefined, true)).toMatchObject({
      balance: 12.5,
      stale: true,
    });
    now = 149999;
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(2);
    now = 150000;
    cache.read("a", load, 60, undefined, true);
    await cache.settle("a");
    expect(load).toHaveBeenCalledTimes(3);
    expect(cache.read("a", load, 60).stale).toBe(false);
  });
});
