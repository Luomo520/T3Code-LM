const left = String.raw`(?<![A-Za-z0-9_.+/-])`;
const right = String.raw`(?![A-Za-z0-9_+-]|\.[A-Za-z0-9])`;
const pathLeft = String.raw`(?<![\p{L}\p{N}_.+/\\-])`;
const segment = String.raw`[\p{L}\p{N}_@~+-]+(?:\.[\p{L}\p{N}_@~+-]+)*`;
const separator = String.raw`[/\\]`;
const filename = String.raw`${segment}\.(?:md|mdx|markdown|txt|json|jsonc|ya?ml|toml|csv|ts|tsx|js|jsx|mjs|py|go|rs|html|css|log|png|svg|zip|apk|exe)`;
const root = String.raw`(?:[A-Za-z]:${separator}|~${separator}|(?:\.{1,2}${separator})+|/)`;
const path = String.raw`(?:${root}(?:${segment}${separator})*${segment}${separator}?|(?:${segment}${separator})+(?:${filename})?|(?:${segment}${separator}){2,}${segment})`;

// Capture order is shared with the Android renderer. All groups within a rule are noncapturing.
const rules = {
  error: String.raw`${left}(?:HTTP[ \t]+[45]\d{2}|verification failed|check failed)${right}|(?:尚)?未(?:校验|验证|检查|验收)?通过|(?:校验|验证|检查|验收)未通过|校验失败|验证失败|构建失败|下载失败|连接失败|执行失败`,
  pending: String.raw`${left}(?:pending verification|awaiting verification|verification pending)${right}|待处理|待验证|待校验|待复测|尚未验证`,
  success: String.raw`${left}(?:verification passed|check passed)${right}|校验通过|验证通过|检查通过|验收通过`,
  path: String.raw`${pathLeft}(?:${path}|(?!(?:node|next|nuxt|vue|react|d3|three|bun)\.js${right})${filename})(?::\d+(?:-\d+)?)?${right}(?![/\\])`,
  uuid: String.raw`${left}[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}${right}`,
  date: String.raw`${left}\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T \t](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-][0-2]\d:?\d{2})?)?${right}`,
  version: String.raw`${left}v?\d+\.\d+\.\d+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?(?:\+[a-z0-9]+(?:[.-][a-z0-9]+)*)?${right}`,
  quantity: String.raw`${left}[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[kmb]?[ \t]*(?:tokens?(?:/s)?|t/s)|[ \t]*(?:%|ms|s|µs|μs|ns|ki?b|mi?b|gi?b|ti?b|bytes?))${right}`,
} as const;

export type MarkdownSemanticHighlightKind = keyof typeof rules;

export const markdownSemanticHighlightKinds = Object.keys(rules) as MarkdownSemanticHighlightKind[];
export const markdownSemanticHighlightPattern = Object.values(rules)
  .map((pattern) => `(${pattern})`)
  .join("|");
const highlightPattern = new RegExp(markdownSemanticHighlightPattern, "giu");
// Highlight a value in inline code with only whitespace or punctuation around it. A command
// that takes a version or path as an argument keeps its ordinary code styling.
export const markdownSemanticInlineCodeEdge = String.raw`^[\s()\[\]{}<>"'“”‘’：:，。,;!?]*$`;
const inlineCodeEdge = new RegExp(markdownSemanticInlineCodeEdge, "u");

export function markdownSemanticHighlights(text: string, inlineCode = false) {
  return Array.from(text.matchAll(highlightPattern))
    .filter(
      (match) =>
        !inlineCode ||
        (inlineCodeEdge.test(text.slice(0, match.index)) &&
          inlineCodeEdge.test(text.slice(match.index + match[0].length))),
    )
    .map((match) => ({
      kind: markdownSemanticHighlightKinds[
        match.findIndex((capture, index) => index > 0 && capture !== undefined) - 1
      ]!,
      start: match.index,
      end: match.index + match[0].length,
    }));
}
