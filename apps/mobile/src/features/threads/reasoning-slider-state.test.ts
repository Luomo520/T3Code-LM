import { describe, expect, it } from "vite-plus/test";
import {
  REASONING_THUMB_DIAMETER,
  reasoningLevelLabel,
  reasoningRailHighlightMode,
  reasoningRailSweep,
  reasoningSliderFillWidth,
  reasoningSliderIndex,
} from "./reasoning-slider-state";

describe("reasoning slider touch snapping", () => {
  it("uses the thumb-centre travel and clamps touches beyond either rail end", () => {
    expect(reasoningSliderIndex(-20, 342, 6)).toBe(0);
    expect(reasoningSliderIndex(0, 342, 6)).toBe(0);
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
  it("keeps the fill edge at each thumb centre with symmetric stops", () => {
    const width = 342;
    const count = 6;
    const centres = Array.from({ length: count }, (_, index) =>
      reasoningSliderFillWidth(index, width, count),
    );
    expect(centres).toEqual([21, 81, 141, 201, 261, 321]);
    expect(centres.map((centre) => reasoningSliderIndex(centre, width, count))).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(centres[0]).toBe(REASONING_THUMB_DIAMETER / 2);
    expect(centres.at(-1)).toBe(width - REASONING_THUMB_DIAMETER / 2);
    expect(reasoningSliderFillWidth(-1, width, count)).toBe(0);
  });
  it("translates only known levels and retains provider-defined labels", () => {
    expect(reasoningLevelLabel({ id: "xhigh", label: "最高" })).toBe("Extra High");
    expect(reasoningLevelLabel({ id: "auto", label: "自动" })).toBe("Auto");
    expect(reasoningLevelLabel({ id: "adaptive", label: "Adaptive" })).toBe("Adaptive");
  });
});

describe("reasoning rail highlight", () => {
  it("scales the sweep width and its endpoint to the local fill length", () => {
    const fillWidths = [0, 2, 5].map((index) => reasoningSliderFillWidth(index, 342, 6));
    expect(fillWidths.map(reasoningRailSweep)).toEqual([
      { width: 12, start: -12, end: 21 },
      { width: 78, start: -78, end: 141 },
      { width: 177, start: -177, end: 321 },
    ]);
  });

  it("sweeps at every selected stop when multiple levels are available", () => {
    const modes = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        reasoningRailHighlightMode(index, count, true, false),
      );
    expect(modes(2)).toEqual(["sweep", "sweep"]);
    expect(modes(6)).toEqual(Array(6).fill("sweep"));
  });

  it("uses a static highlight on low, middle, and high stops with reduced motion", () => {
    expect(reasoningRailHighlightMode(0, 6, true, true)).toBe("static");
    expect(reasoningRailHighlightMode(2, 6, true, true)).toBe("static");
    expect(reasoningRailHighlightMode(5, 6, true, true)).toBe("static");
  });

  it("keeps a single selected stop static regardless of the motion setting", () => {
    expect(reasoningRailHighlightMode(0, 1, true, false)).toBe("static");
    expect(reasoningRailHighlightMode(0, 1, true, true)).toBe("static");
  });

  it("turns off for an invalid, unavailable, or hidden selection", () => {
    expect(reasoningRailHighlightMode(-1, 0, true, false)).toBe("off");
    expect(reasoningRailHighlightMode(-1, 6, true, false)).toBe("off");
    expect(reasoningRailHighlightMode(6, 6, true, false)).toBe("off");
    expect(reasoningRailHighlightMode(5, 6, false, false)).toBe("off");
    expect(reasoningRailHighlightMode(0, 1, false, true)).toBe("off");
  });
});
