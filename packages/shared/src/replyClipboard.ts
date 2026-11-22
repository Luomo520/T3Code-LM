import { renderCodexDirectivesForCopy } from "./codexMarkdownDirectives.ts";
import type { Nodes } from "mdast";
import { parseMarkdownWithMath } from "./markdownMath.ts";

// 两端按同一棵 Markdown 语法树复制正文，避免用正则剥掉代码里的星号和缩进。
export function replyPlainText(markdown: string): string {
  return render(parseMarkdownWithMath(renderCodexDirectivesForCopy(markdown)));
}

function render(node: Nodes): string {
  switch (node.type) {
    case "root":
    case "blockquote":
      return node.children.map(render).filter(Boolean).join("\n\n");
    case "table":
      return node.children.map(render).join("\n");
    case "tableRow":
      return node.children.map(render).join("\t");
    case "list":
      return node.children
        .map((item, index) => {
          const marker = node.ordered ? `${(node.start ?? 1) + index}.` : "•";
          const check = item.checked == null ? "" : item.checked ? "☑ " : "☐ ";
          return `${marker} ${check}${render(item).replaceAll("\n", "\n  ")}`;
        })
        .join("\n");
    case "listItem":
      return node.children.map(render).join("\n");
    case "break":
      return "\n";
    case "image":
    case "imageReference":
      return node.alt ?? "";
    case "definition":
      return "";
    case "footnoteReference":
      return `[${node.label ?? node.identifier}]`;
    case "footnoteDefinition":
      return `[${node.label ?? node.identifier}] ${node.children.map(render).join("\n")}`;
    case "thematicBreak":
      return "───";
    case "html":
      return node.value
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
        .replace(/<br\b[^>]*>/gi, "\n")
        .replace(/<\/(?:p|div|blockquote|details|summary|h[1-6]|li|tr)\s*>/gi, "\n")
        .replace(/<\/?[A-Za-z][^>]*>/g, "");
    default:
      if ("value" in node) return node.value;
      return "children" in node ? node.children.map(render).join("") : "";
  }
}
