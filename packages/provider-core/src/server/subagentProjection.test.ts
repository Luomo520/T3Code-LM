import { describe, expect, it } from "vite-plus/test";

import { codexActivityTitle, codexTaskName, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

it("保留嵌套任务的中文显示名，兼容历史路径和无效编码", () => {
  for (const title of ["列表筛选", "Android 验收", "𠀀测试"]) {
    expect(codexActivityTitle("/root/parent/" + codexTaskName(title))).toBe(title);
  }
  for (const path of ["/root/old_name", "/root/t3n_fffffe", "/root/t3n_0a", "/root/t3n_d800"]) {
    expect(codexActivityTitle(path)).toBe(path);
  }
});
