import { expect, it } from "vite-plus/test";
import { replyPlainText } from "./replyClipboard.ts";

it("keeps rows, list nesting and code indentation in a plain-text reply", () => {
  const markdown = [
    "# Report",
    "",
    "| Key | Value |",
    "| --- | --- |",
    "| A | **1** |",
    "",
    "3. [label](https://example.com)",
    "   - child",
    "",
    "```js",
    "  a * b",
    "```",
  ].join("\n");
  expect(replyPlainText(markdown)).toBe(
    "Report\n\nKey\tValue\nA\t1\n\n3. label\n  • child\n\n  a * b",
  );
});

it("keeps separate paragraphs when a reply contains HTML", () => {
  expect(replyPlainText("<p>first</p><p>second</p>").trimEnd()).toBe("first\nsecond");
});
