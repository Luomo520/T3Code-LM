import { describe, expect, it } from "vite-plus/test";
import { isUsageDataExpired } from "./headerUsageStatus";

describe("expired statistics marker", () => {
  it("does not mark never-fetched data, but marks failures and elapsed freshness", () => {
    const readAt = "2026-10-28T10:00:00.000Z";
    const start = Date.parse(readAt);
    expect(isUsageDataExpired(null, 60000, true, start)).toBe(false);
    expect(isUsageDataExpired(readAt, 60000, false, start + 59999)).toBe(false);
    expect(isUsageDataExpired(readAt, 60000, false, start + 60000)).toBe(true);
    expect(isUsageDataExpired(readAt, 60000, true, start + 1000)).toBe(true);
    expect(
      isUsageDataExpired(new Date(start + 60000).toISOString(), 60000, false, start + 60001),
    ).toBe(false);
  });
});
