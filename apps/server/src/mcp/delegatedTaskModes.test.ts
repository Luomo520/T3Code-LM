import { describe, expect, it } from "vite-plus/test";
import { taskPrompt } from "./delegatedTaskModes.ts";

describe("delegated task provider titles", () => {
  it("puts the task title before role instructions while preserving the complete task", () => {
    expect(taskPrompt({ title: "审查缓存统计", role: "review", task: "保留真实零值。" })).toBe(
      "[T3子任务] 审查缓存统计\n\nAct as the review sub-agent for this task.\n\n保留真实零值。",
    );
  });

  it("keeps general task content intact and normalizes only the title", () => {
    expect(taskPrompt({ title: "  检查\n状态  ", role: "general", task: "第一行\n\n第二行" })).toBe(
      "[T3子任务] 检查 状态\n\n第一行\n\n第二行",
    );
  });

  it("uses a recognizable fallback when the caller omits the title", () => {
    expect(taskPrompt({ task: "请核对实现" })).toBe("[T3子任务] 委派任务\n\n请核对实现");
  });
});
