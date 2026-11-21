import { markdownSemanticHighlights } from "@t3tools/shared/markdownSemanticHighlight";
import type { Element, ElementContent, Root, RootContent, Text } from "hast";

function highlightedText(node: Text, inlineCode: boolean): ElementContent[] {
  const matches = markdownSemanticHighlights(node.value, inlineCode);
  if (matches.length === 0) return [node];

  const parts: ElementContent[] = [];
  let offset = 0;
  for (const { start, end, kind } of matches) {
    if (start > offset) parts.push({ type: "text", value: node.value.slice(offset, start) });
    parts.push({
      type: "element",
      tagName: "span",
      properties: { dataMarkdownHighlight: kind },
      children: [{ type: "text", value: node.value.slice(start, end) }],
    });
    offset = end;
  }
  if (offset < node.value.length) parts.push({ type: "text", value: node.value.slice(offset) });
  return parts;
}

export function rehypeMarkdownSemanticHighlights() {
  const visit = (node: Root | Element) => {
    if (
      node.type === "element" &&
      (node.tagName === "a" ||
        node.tagName === "pre" ||
        node.tagName === "math" ||
        (Array.isArray(node.properties.className) &&
          node.properties.className.some((name) => /^math-(?:inline|display)$/.test(String(name)))))
    ) {
      return;
    }
    const inlineCode = node.type === "element" && node.tagName === "code";
    const transform = (child: RootContent): RootContent[] => {
      if (child.type === "text") return highlightedText(child, inlineCode);
      if (child.type === "element") visit(child);
      return [child];
    };
    if (node.type === "root") node.children = node.children.flatMap(transform);
    else node.children = node.children.flatMap(transform) as ElementContent[];
  };
  return (root: Root) => visit(root);
}
