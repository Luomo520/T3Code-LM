import type { MessageId, RunAttemptId, RunId } from "@t3tools/contracts";
import { createDeferredStorage } from "../../lib/storage";

export interface TimelineRunObservation {
  readonly threadKey: string | null;
  readonly hydrated: boolean;
  readonly runId: RunId | null;
}

export function observeTimelineRun(
  previous: TimelineRunObservation | null,
  input: TimelineRunObservation & {
    readonly queued: boolean;
    readonly messageId: MessageId | null;
  },
): { observation: TimelineRunObservation; anchorMessageId: MessageId | null } {
  const observation = {
    threadKey: input.threadKey,
    hydrated: input.hydrated,
    runId: input.queued ? null : input.runId,
  };
  if (previous?.threadKey !== input.threadKey || !previous.hydrated) {
    return { observation, anchorMessageId: null };
  }
  if (
    !input.hydrated ||
    input.runId === null ||
    input.queued ||
    previous.runId === input.runId ||
    input.messageId === null
  ) {
    return { observation: previous, anchorMessageId: null };
  }
  return { observation, anchorMessageId: input.messageId };
}
// Match the titlebar fade inset so draft promotion preserves the first row's position.
export const CHAT_TIMELINE_ANCHOR_OFFSET = 24;

export type TimelineScrollMode = "following-end" | "anchoring-new-turn" | "free-scrolling";

interface TimelineListMeasurementState {
  readonly data: readonly unknown[];
  readonly scroll: number;
  readonly scrollLength: number;
  readonly positionAtIndex: (index: number) => number | undefined;
  readonly sizeAtIndex: (index: number) => number | undefined;
}

function getRowBottom(state: TimelineListMeasurementState, index: number): number | null {
  const top = state.positionAtIndex(index);
  const height = state.sizeAtIndex(index);
  if (
    typeof top !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(top) ||
    !Number.isFinite(height)
  ) {
    return null;
  }

  return top + Math.max(1, height);
}

/**
 * The list's own content length includes the composer inset spacer, so this
 * measures from the last row instead. Unknown row positions or an unmeasured
 * viewport counts as fitting.
 */
export function timelineContentOverflowsViewport(
  state: TimelineListMeasurementState | undefined,
  input: { readonly composerInset: number; readonly anchorOffset: number },
): boolean {
  if (!state || !state.data || state.data.length === 0) {
    return false;
  }
  const scrollLength = state.scrollLength;
  if (typeof scrollLength !== "number" || !Number.isFinite(scrollLength) || scrollLength <= 0) {
    return false;
  }
  const lastIndex = state.data.length - 1;
  // Overflow can use an unmeasured tail's lower bound.
  const lastTop = state.positionAtIndex(lastIndex);
  const lastBottom =
    getRowBottom(state, lastIndex) ??
    (typeof lastTop === "number" && Number.isFinite(lastTop) ? lastTop + 1 : null);
  if (lastBottom === null) {
    return false;
  }
  const visibleScrollLength = Math.max(0, scrollLength - input.composerInset - input.anchorOffset);
  return lastBottom > visibleScrollLength;
}

export function resolveDisclosureRevealScrollDelta({
  rowTop,
  rowBottom,
  viewportTop,
  viewportBottom,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): number {
  const hiddenBelow = rowBottom - (viewportBottom - composerOverlayHeight);
  if (!(hiddenBelow > 0)) return 0;
  const roomAbove = rowTop - (viewportTop + anchorOffset);
  return Math.max(0, Math.min(hiddenBelow, roomAbove));
}

export interface RememberedTimelinePosition {
  readonly rowId: string;
  readonly offsetWithinRow: number;
  readonly scrollOffset: number;
  readonly atEnd: boolean;
  readonly disclosures?: {
    readonly runs: ReadonlySet<RunId>;
    readonly workGroups: ReadonlySet<string>;
    readonly attempts: ReadonlySet<RunAttemptId>;
    readonly workGroupState: {
      scrollPositions: Map<string, { readonly entryId: string; readonly offset: number }>;
      expandedEntries: Set<string>;
    };
  };
}

type StoredTimelinePosition = Omit<RememberedTimelinePosition, "disclosures">;
const POSITION_LIMIT = 100;
const POSITION_STORAGE_KEY = "t3code:timeline-reading-positions:v1";
const rememberedTimelinePositions = new Map<string, RememberedTimelinePosition>();
const pendingPositions = new Map<string, StoredTimelinePosition | null>();

function readStoredTimelinePositions(): Map<string, StoredTimelinePosition> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(POSITION_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return new Map();
    const positions = new Map<string, StoredTimelinePosition>();
    for (const entry of parsed.slice(-POSITION_LIMIT)) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
      const [key, position] = entry;
      if (
        typeof position?.rowId === "string" &&
        Number.isFinite(position.offsetWithinRow) &&
        Number.isFinite(position.scrollOffset) &&
        position.atEnd === false
      ) {
        positions.set(key, position);
      }
    }
    return positions;
  } catch {
    return new Map();
  }
}

const deferredPositions = createDeferredStorage(
  {
    getItem: () => null,
    removeItem: () => {},
    setItem: (name, value) => {
      try {
        window.localStorage.setItem(name, value);
        pendingPositions.clear();
      } catch {
        // 存储不可写时仍可在当前窗口恢复。
      }
    },
  },
  () => {
    const positions = readStoredTimelinePositions();
    for (const [key, position] of pendingPositions) {
      positions.delete(key);
      if (position !== null) positions.set(key, position);
    }
    return JSON.stringify([...positions].slice(-POSITION_LIMIT));
  },
);

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", deferredPositions.flush);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") deferredPositions.flush();
  });
}

export function readTimelinePosition(threadKey: string): RememberedTimelinePosition | undefined {
  return rememberedTimelinePositions.get(threadKey) ?? readStoredTimelinePositions().get(threadKey);
}

export function rememberTimelinePosition(
  threadKey: string,
  position: RememberedTimelinePosition,
  liveFollowEnabled: boolean,
) {
  const prior = rememberedTimelinePositions.get(threadKey);
  const atEnd = liveFollowEnabled || position.atEnd;
  rememberedTimelinePositions.delete(threadKey);
  rememberedTimelinePositions.set(threadKey, { ...position, atEnd });
  if (rememberedTimelinePositions.size > POSITION_LIMIT) {
    const oldest = rememberedTimelinePositions.keys().next().value;
    if (oldest !== undefined) rememberedTimelinePositions.delete(oldest);
  }

  if (typeof window === "undefined" || (atEnd && prior?.atEnd === true)) return;
  const { rowId, offsetWithinRow, scrollOffset } = position;
  pendingPositions.delete(threadKey);
  pendingPositions.set(threadKey, atEnd ? null : { rowId, offsetWithinRow, scrollOffset, atEnd });
  deferredPositions.setItem(POSITION_STORAGE_KEY, undefined);
}
