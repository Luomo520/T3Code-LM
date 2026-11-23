import type { LegendListRef } from "@legendapp/list/react-native";
import { useFocusEffect } from "@react-navigation/native";
import { File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { writeFileAtomically } from "../../lib/atomic-file";
import { SerializedAsyncQueue } from "../../lib/serialized-async-queue";
import { useCallback, useRef, type RefObject } from "react";

interface ReadingPosition {
  readonly key: string;
  readonly offset: number;
  readonly scroll: number;
}

const MAX_POSITIONS = 100;
const positionsFile = () => new File(Paths.document, "thread-reading-positions-v1.json");
const writes = new SerializedAsyncQueue();
let persistedPositions: Map<string, ReadingPosition> | undefined;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function positions(): Map<string, ReadingPosition> {
  if (persistedPositions !== undefined) return persistedPositions;
  const restored = new Map<string, ReadingPosition>();
  try {
    const file = positionsFile();
    const parsed: unknown = file.exists ? JSON.parse(file.textSync()) : [];
    if (Array.isArray(parsed)) {
      for (const entry of parsed.slice(-MAX_POSITIONS)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
        const [key, position] = entry;
        if (
          typeof position?.key === "string" &&
          Number.isFinite(position.offset) &&
          Number.isFinite(position.scroll)
        ) {
          restored.set(key, position);
        }
      }
    }
  } catch {
    // 文件丢失或损坏时仍可在应用内恢复位置。
  }
  persistedPositions = restored;
  return restored;
}

function persistPositions() {
  clearTimeout(timer);
  timer = undefined;
  if (!dirty) return;
  dirty = false;
  void writes
    .run(() => writeFileAtomically(positionsFile(), JSON.stringify([...positions()])))
    .catch(() => {
      dirty = true;
    });
}

function schedulePositionSave() {
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(persistPositions, 300);
}

export function useThreadFeedReadingPosition(
  threadKey: string,
  listRef: RefObject<LegendListRef | null>,
  jumpPending: boolean,
  leadingInset: number,
) {
  const focused = useRef(false);
  const loadedThread = useRef<string | null>(null);
  const restoring = useRef<Promise<void> | null>(null);

  const remember = useCallback(() => {
    const list = listRef.current;
    if (!focused.current || restoring.current || loadedThread.current !== threadKey || !list) {
      return;
    }
    const state = list.getState();
    if (state.dataKey !== threadKey) return;
    const readingPositions = positions();
    if (state.isAtEnd) {
      if (readingPositions.delete(threadKey)) schedulePositionSave();
      return;
    }
    const anchor = list.anchorVisibleContent({ hold: false });
    if (!anchor) return;
    const previous = readingPositions.get(threadKey);
    if (
      previous?.key === anchor.key &&
      previous.offset === anchor.offset &&
      previous.scroll === state.scroll
    ) {
      return;
    }
    readingPositions.delete(threadKey);
    readingPositions.set(threadKey, { ...anchor, scroll: state.scroll });
    if (readingPositions.size > MAX_POSITIONS) {
      const oldest = readingPositions.keys().next().value;
      if (oldest !== undefined) readingPositions.delete(oldest);
    }
    schedulePositionSave();
  }, [listRef, threadKey]);

  const restore = useCallback(() => {
    if (!focused.current || loadedThread.current !== threadKey) return;
    const list = listRef.current;
    const position = positions().get(threadKey);
    if (!list || !position) return;
    const state = list.getState();
    if (state.dataKey !== threadKey) return;
    const anchor = list.anchorVisibleContent({ hold: false });
    if (anchor?.key === position.key && Math.abs(anchor.offset - position.offset) < 1) return;
    const scroll =
      state.indexByKey(position.key) === undefined
        ? list.scrollToOffset({ offset: position.scroll, animated: false })
        : list.scrollToKey({
            key: position.key,
            viewPosition: 0,
            viewOffset: -position.offset - leadingInset,
            animated: false,
          });
    restoring.current = scroll;
    const finish = () => {
      if (restoring.current === scroll) restoring.current = null;
    };
    void scroll.then(finish, finish);
  }, [leadingInset, listRef, threadKey]);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      restore();
      const appState = AppState.addEventListener("change", (status) => {
        if (status === "background") {
          remember();
          persistPositions();
        }
      });
      return () => {
        appState.remove();
        remember();
        persistPositions();
        focused.current = false;
      };
    }, [remember, restore]),
  );

  return {
    remember,
    onReady: () => {
      loadedThread.current = threadKey;
      if (!jumpPending) restore();
    },
  };
}
