import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HeaderUsageCounters } from "./usage.ts";

describe("header request samples", () => {
  it("accepts legacy counters and bounds same-request details to five rows with nullable measurements", () => {
    const decode = Schema.decodeUnknownSync(HeaderUsageCounters);
    const legacy = {
      tokens: 100,
      cacheRate: 0.5,
      recentRate: 0.5,
      recentSamples: 1,
      partial: false,
    };
    expect(decode(legacy)).not.toHaveProperty("recentRequestSamples");
    const samples = Array.from({ length: 5 }, (_, index) => ({
      timestamp: `2026-11-14T00:00:0${index}Z`,
      totalTokens: index * 100,
      cacheRate: index % 2 ? null : 0.8,
      tokensPerSecond: index % 2 ? 20 : null,
    }));
    expect(decode({ ...legacy, recentRequestSamples: samples }).recentRequestSamples).toEqual(
      samples,
    );
    expect(decode({ ...legacy, recentRequestSamples: [] }).recentRequestSamples).toEqual([]);
    expect(() => decode({ ...legacy, recentRequestSamples: [...samples, samples[0]] })).toThrow();
    expect(() =>
      decode({ ...legacy, recentRequestSamples: [{ ...samples[0], totalTokens: -1 }] }),
    ).toThrow();
  });
});
