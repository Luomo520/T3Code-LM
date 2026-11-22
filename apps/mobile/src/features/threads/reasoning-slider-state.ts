export const REASONING_THUMB_DIAMETER = 42;
const FIRST_STOP = REASONING_THUMB_DIAMETER / 2;

function reasoningSliderTravel(width: number): number {
  return Math.max(0, width - REASONING_THUMB_DIAMETER);
}

/** The thumb's centre travels between the same stops as the touch target. */
export function reasoningSliderIndex(x: number, width: number, count: number): number {
  const travel = reasoningSliderTravel(width);
  if (count < 2 || travel === 0) return 0;
  return Math.round(Math.max(0, Math.min(1, (x - FIRST_STOP) / travel)) * (count - 1));
}

export function reasoningSliderFillWidth(index: number, width: number, count: number): number {
  if (index < 0 || index >= count) return 0;
  return FIRST_STOP + (reasoningSliderTravel(width) * index) / Math.max(1, count - 1);
}

export const REASONING_FLOW_PERIOD = 180;
export const REASONING_FLOW_DURATION = 3600;

// 额外一段用于平移一整个周期，循环接头两侧保持相同颜色。
export function reasoningFlowTileCount(railWidth: number): number {
  return Math.ceil(railWidth / REASONING_FLOW_PERIOD) + 1;
}

export function reasoningRailHighlightMode(
  index: number,
  choiceCount: number,
  visibleAndEnabled: boolean,
  reducedMotion: boolean,
): "off" | "static" | "sweep" {
  if (!visibleAndEnabled || index < 0 || index >= choiceCount) return "off";
  return choiceCount === 1 || reducedMotion ? "static" : "sweep";
}

const labels: Readonly<Record<string, string>> = {
  auto: "Auto",
  default: "Default",
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};
export const reasoningLevelLabel = (choice: { readonly id: string; readonly label: string }) =>
  labels[choice.id] ?? choice.label;
