import { describe, expect, it } from "vite-plus/test";

import { markdownSemanticHighlights } from "./markdownSemanticHighlight.ts";

function values(text: string, inlineCode = false) {
  return markdownSemanticHighlights(text, inlineCode).map(({ kind, start, end }) => [
    kind,
    text.slice(start, end),
  ]);
}

describe("Markdown semantic highlights", () => {
  it("highlights complete values and excludes surrounding punctuation", () => {
    expect(
      values(
        "（Download/t3code/）、123e4567-e89b-12d3-a456-426614174000，2026-11-22 00:32:12，0.1.0-4；20.4M tokens、95.4%、48 t/s、320 ms、3.2 GiB。",
      ),
    ).toEqual([
      ["path", "Download/t3code/"],
      ["uuid", "123e4567-e89b-12d3-a456-426614174000"],
      ["date", "2026-11-22 00:32:12"],
      ["version", "0.1.0-4"],
      ["quantity", "20.4M tokens"],
      ["quantity", "95.4%"],
      ["quantity", "48 t/s"],
      ["quantity", "320 ms"],
      ["quantity", "3.2 GiB"],
    ]);
  });

  it("matches status phrases and codes without matching explanation fragments", () => {
    expect(
      values(
        "尚未通过，HTTP 502，尚未验证通过。待验证，校验通过。校验说明需确认，HTTP 200，HTTP 5021，check passedness。",
      ),
    ).toEqual([
      ["error", "尚未通过"],
      ["error", "HTTP 502"],
      ["error", "尚未验证通过"],
      ["pending", "待验证"],
      ["success", "校验通过"],
    ]);
  });

  it("preserves regular abbreviations, model IDs, numbers and commands", () => {
    expect(values("UUID CLI Node.js gpt-6.2-astra openai/gpt-4.1 123, t/s")).toEqual([]);
    expect(values("npm install ./src/index.ts@0.1.0-4", true)).toEqual([]);
    expect(values("(95.4%)", true)).toEqual([["quantity", "95.4%"]]);
    expect(values(String.raw`C:\Users\foo\README.md:12`, true)).toEqual([
      ["path", String.raw`C:\Users\foo\README.md:12`],
    ]);
    expect(values("./README.md", true)).toEqual([["path", "./README.md"]]);
  });
});
