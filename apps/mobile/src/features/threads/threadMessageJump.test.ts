import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  finishThreadMessageJump,
  pendingThreadMessageJump,
  requestThreadMessageJump,
  threadMessageJumpCandidates,
  threadMessageJumpTerms,
} from "./threadMessageJump";

describe("threadMessageJump", () => {
  it("lets a jump lapse when its thread never showed", () => {
    using now = vi.spyOn(Date, "now").mockReturnValue(0);
    requestThreadMessageJump(
      "thread-a",
      {
        messageId: MessageId.make("message-1"),
        threadId: ThreadId.make("thread-a"),
        projectId: ProjectId.make("project-a"),
        messageCreatedAt: null,
        source: "assistant",
        snippet: "…在 Café.ts 中执行 pnpm test 后仍失败。",
      },
      "cafe.ts pnpm test",
    );
    const jump = pendingThreadMessageJump("thread-a");
    expect(jump?.messageId).toBe("message-1");
    expect(jump && threadMessageJumpTerms(jump)).toEqual(["Café.ts", "pnpm", "test"]);
    expect(jump && threadMessageJumpCandidates({ ...jump, query: "pnpm test" })).toEqual([
      "pnpm test",
      "pnpm",
      "test",
    ]);
    expect(jump && threadMessageJumpCandidates({ ...jump, query: "cafe.ts pnpm" })).toEqual([
      "Café.ts",
      "pnpm",
    ]);
    expect(pendingThreadMessageJump("thread-b")).toBeNull();
    now.mockReturnValue(30_000);
    expect(pendingThreadMessageJump("thread-a")).toBeNull();
    finishThreadMessageJump("thread-a");
  });
});
