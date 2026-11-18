/** The thumb's centre travels inside the rail, matching the six inset reference stops. */
export function reasoningSliderIndex(x: number, width: number, count: number): number {
  if (count < 2 || width <= 42) return 0;
  return Math.round(Math.max(0, Math.min(1, (x - 21) / (width - 42))) * (count - 1));
}

const labels: Readonly<Record<string, string>> = {
  low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max", ultra: "Ultra",
};
export const reasoningLevelLabel = (choice: { readonly id: string; readonly label: string }) =>
  labels[choice.id] ?? choice.label;

