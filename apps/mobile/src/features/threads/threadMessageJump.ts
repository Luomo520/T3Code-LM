import type { MessageId, OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import {
  findSearchTokenRanges,
  messagePhrase,
  splitSearchText,
} from "@t3tools/shared/paletteSearch";

// A palette message result opens its thread at that message. The thread
// screen reads the request while it shows that thread, and finishes it once
// the feed is there or the message cannot be found. A request whose thread
// never showed lapses, so a later plain open does not jump, as on web.
const PENDING_JUMP_MS = 30_000;
export interface ThreadMessageJump {
  readonly messageId: MessageId;
  readonly match: Pick<OrchestrationThreadSearchMatch, "snippet" | "source">;
  readonly query: string;
  readonly onBackToResults?: () => void;
}

let pending: (ThreadMessageJump & { readonly threadKey: string; readonly at: number }) | null =
  null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

export function requestThreadMessageJump(
  threadKey: string,
  match: OrchestrationThreadSearchMatch,
  query: string,
  onBackToResults?: () => void,
): void {
  if (!match.messageId) return;
  pending = {
    threadKey,
    messageId: match.messageId,
    match,
    query,
    at: Date.now(),
    ...(onBackToResults ? { onBackToResults } : {}),
  };
  notify();
}

export function threadMessageJumpTerms(jump: ThreadMessageJump): ReadonlyArray<string> {
  return [
    ...new Set(
      splitSearchText(jump.match.snippet, findSearchTokenRanges(jump.match.snippet, jump.query))
        .filter((part) => part.highlighted)
        .map((part) => part.text),
    ),
  ];
}

export function threadMessageJumpCandidates(jump: ThreadMessageJump): ReadonlyArray<string> {
  const snippet = jump.match.snippet.replace(/[‘’]/g, "'");
  const phrase = messagePhrase(jump.query)?.exec(snippet);
  const terms = [...threadMessageJumpTerms(jump)].sort((a, b) => b.length - a.length);
  if (phrase && !terms.includes(phrase[0])) {
    return [jump.match.snippet.slice(phrase.index, phrase.index + phrase[0].length), ...terms];
  }
  return terms;
}

/** The message this thread should open at, if a palette pick asked for one. */
export function pendingThreadMessageJump(threadKey: string): ThreadMessageJump | null {
  return pending?.threadKey === threadKey && Date.now() - pending.at < PENDING_JUMP_MS
    ? pending
    : null;
}

export function finishThreadMessageJump(threadKey: string, shown?: ThreadMessageJump): void {
  if (pending?.threadKey !== threadKey || (shown !== undefined && pending !== shown)) return;
  pending = null;
  notify();
}

export function subscribeThreadMessageJump(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
