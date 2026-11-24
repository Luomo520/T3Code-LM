import { AndroidDirectoryFileName } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isAndroidDirectoryFileName = Schema.is(AndroidDirectoryFileName);

const unquote = (value: string) =>
  value
    .trim()
    .replace(/^(?:「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"|`([^`]*)`)$/u, "$1$2$3$4$5");

export function androidDirectoryIntent(message: string) {
  const text = message
    .trim()
    .replace(/[。！!]$/u, "")
    .trim();
  if (/[\r\n？?]/u.test(text)) return;
  const prefix = String.raw`^(?:(?:请你?|帮我|麻烦|给我|替我)\s*)*`;
  const source = String.raw`(?:从\s*)?(.+?)(?:\s*的\s*(?:授权目录|已授权目录)(?:里|内|中)?(?:的)?(?:\s*(?:取出|取回))?|\s*的)\s*(?:把\s*)?(.+?)`;
  const send =
    new RegExp(
      prefix +
        String.raw`(?:把\s*)?` +
        source +
        String.raw`\s*(?:传到|发送?到|发给|传给|保存到|复制到)\s*(.+)$`,
      "u",
    ).exec(text) ??
    /^(?:please\s+)?(?:send|transfer|copy)\s+(.+?)\s+from\s+(.+?)(?:'s authorized folder)?\s+to\s+(.+)$/iu
      .exec(text)
      ?.map((value, index, all) => (index === 1 ? all[2] : index === 2 ? all[1] : value));
  const view =
    new RegExp(
      prefix +
        String.raw`(?:在(?:本|原|当前)会话(?:里|中)?\s*)?(?:看看|看一下|查看|预览)\s*` +
        source +
        String.raw`(?:\s*(?:的内容|内容))?$`,
      "u",
    ).exec(text) ??
    /^(?:please\s+)?(?:view|preview|show)\s+(.+?)\s+from\s+(.+?)(?:'s authorized folder)?(?:\s+in (?:this|the) conversation)?$/iu
      .exec(text)
      ?.map((value, index, all) => (index === 1 ? all[2] : index === 2 ? all[1] : value));
  const match = send ?? view;
  if (!match?.[1] || !match[2]) return;
  const sourceDevice = unquote(match[1]);
  const name = unquote(match[2]);
  const target = send?.[3] ? unquote(send[3]) : undefined;
  if (!sourceDevice || (send && !target) || !isAndroidDirectoryFileName(name)) return;
  return { sourceDevice, name, target };
}
