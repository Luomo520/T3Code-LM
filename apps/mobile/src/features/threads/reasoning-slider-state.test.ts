import { describe, expect, it } from "vite-plus/test";
import { reasoningSliderIndex, reasoningLevelLabel } from "./reasoning-slider-state";

describe("reasoning slider touch snapping", () => {
  it("uses the thumb-centre travel and clamps touches beyond either rail end", () => {
    expect(reasoningSliderIndex(-20, 342, 6)).toBe(0);
    expect(reasoningSliderIndex(21, 342, 6)).toBe(0);
    expect(reasoningSliderIndex(81, 342, 6)).toBe(1);
    expect(reasoningSliderIndex(141, 342, 6)).toBe(2);
    expect(reasoningSliderIndex(321, 342, 6)).toBe(5);
    expect(reasoningSliderIndex(380, 342, 6)).toBe(5);
  });
  it("snaps at the half-distance between adjacent available choices", () => {
    expect(reasoningSliderIndex(110, 342, 6)).toBe(1);
    expect(reasoningSliderIndex(112, 342, 6)).toBe(2);
    expect(reasoningSliderIndex(171, 342, 3)).toBe(1);
  });
  it("handles unmeasured and single-choice rails without invalid indices", () => {
    expect(reasoningSliderIndex(80, 0, 6)).toBe(0);
    expect(reasoningSliderIndex(80, 42, 6)).toBe(0);
    expect(reasoningSliderIndex(80, 342, 1)).toBe(0);
    expect(reasoningSliderIndex(80, 342, 0)).toBe(0);
  });
  it("translates only known levels and retains provider-defined labels", () => {
    expect(reasoningLevelLabel({ id: "xhigh", label: "最高" })).toBe("Extra High");
    expect(reasoningLevelLabel({ id: "adaptive", label: "Adaptive" })).toBe("Adaptive");
  });
});
