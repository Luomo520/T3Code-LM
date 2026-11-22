export const FLOATING_TABS = { edge: 16, bottom: 12, gap: 12, innerPadding: 6 };

export function floatingDockWidth(count: number) {
  return count * 64 + 2 * FLOATING_TABS.innerPadding;
}

function floatingDockHeight(fabSize: number) {
  return Math.min(68, Math.max(60, fabSize + 4));
}

export function floatingDockMetrics(count: number, fabSize: number, availableWidth: number) {
  const height = floatingDockHeight(fabSize);
  const width = Math.max(0, Math.min(floatingDockWidth(count), availableWidth));
  const diameter = Math.max(
    0,
    Math.min(
      height - 2 * FLOATING_TABS.innerPadding,
      (width - 2 * FLOATING_TABS.innerPadding) / count,
    ),
  );
  return { width, height, diameter };
}

export function floatingDockBottomClearance(
  bottomInset: number,
  fabSize: number,
  showCompose = false,
) {
  return (
    bottomInset +
    FLOATING_TABS.bottom +
    FLOATING_TABS.edge +
    floatingDockHeight(fabSize) +
    (showCompose ? FLOATING_TABS.gap + fabSize : 0)
  );
}
