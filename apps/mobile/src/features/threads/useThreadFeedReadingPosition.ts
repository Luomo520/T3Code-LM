import type { LegendListRef } from "@legendapp/list/react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, type RefObject } from "react";

interface ReadingPosition {
  readonly key: string;
  readonly offset: number;
  readonly scroll: number;
}

const readingPositions = new Map<string, ReadingPosition>();

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
    if (state.isAtEnd) {
      readingPositions.delete(threadKey);
      return;
    }
    const anchor = list.anchorVisibleContent({ hold: false });
    if (!anchor) return;
    readingPositions.delete(threadKey);
    readingPositions.set(threadKey, { ...anchor, scroll: state.scroll });
    if (readingPositions.size > 100) {
      const oldest = readingPositions.keys().next().value;
      if (oldest !== undefined) readingPositions.delete(oldest);
    }
  }, [listRef, threadKey]);

  const restore = useCallback(() => {
    if (!focused.current || loadedThread.current !== threadKey) return;
    const list = listRef.current;
    const position = readingPositions.get(threadKey);
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
      return () => {
        remember();
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
