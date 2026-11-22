import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import {
  collectValueUse,
  isInScope,
  type ScanContext,
  type ValueUseInfo,
} from "../plugin/matcher.ts";
import { transformCode } from "../plugin/vite-plugin-t3zh.ts";
import {
  createTranslator,
  installT3zhRuntime,
  LOCALE_STORAGE_KEY,
  type T3zhDict,
} from "../runtime/t3zh-runtime.ts";

const dict = JSON.parse(
  NodeFS.readFileSync(new URL("../dict/zh-CN.json", import.meta.url), "utf8"),
) as T3zhDict;
const allow = JSON.parse(
  NodeFS.readFileSync(new URL("../dict/allow-suspicious.json", import.meta.url), "utf8"),
) as string[];

function transform(source: string, file = "apps/web/src/SelectiveExample.tsx") {
  const values = new Map<string, ValueUseInfo>();
  collectValueUse(source, file, file, values);
  const context: ScanContext = { valueUse: values, allowSuspicious: new Set(allow), dict };
  return transformCode(source, file, context);
}

NodeTest.test("defaults to Chinese even when Electron reports English", () => {
  const documentElement = { lang: "en" };
  const runtime = installT3zhRuntime(dict, {
    navigator: { languages: ["en-US"], userAgent: "Electron/42" },
    document: { documentElement },
  });
  NodeAssert.equal(runtime.locale, "zh-CN");
  NodeAssert.equal(documentElement.lang, "zh-CN");
  NodeAssert.equal(runtime.t("Settings"), "设置");
});

NodeTest.test("retains an explicit English preference from the old package", () => {
  const runtime = installT3zhRuntime(dict, {
    localStorage: { getItem: () => "en", setItem: () => {} },
    navigator: { languages: ["zh-CN"] },
  });
  NodeAssert.equal(runtime.locale, "en");
  NodeAssert.equal(runtime.t("Settings"), "Settings");
});

NodeTest.test("retains explicit system language behavior", () => {
  const runtime = installT3zhRuntime(dict, {
    localStorage: { getItem: () => "system", setItem: () => {} },
    navigator: { languages: ["en-US"] },
  });
  NodeAssert.equal(runtime.locale, "en");
});

NodeTest.test("keeps the old locale API and reloads only when explicitly changed", () => {
  const writes: Array<[string, string]> = [];
  let reloads = 0;
  const target: Record<string, unknown> = {};
  const runtime = installT3zhRuntime(dict, {
    localStorage: { getItem: () => null, setItem: (key, value) => writes.push([key, value]) },
    location: { reload: () => reloads++ },
    target,
  });
  NodeAssert.equal(reloads, 0);
  NodeAssert.equal(target.__t3zh, runtime.api);
  runtime.api.setLocale("en");
  NodeAssert.deepEqual(writes, [[LOCALE_STORAGE_KEY, "en"]]);
  NodeAssert.equal(reloads, 1);
});

NodeTest.test("follows the saved UI language and delegates legacy changes", () => {
  const storage = new Map([[LOCALE_STORAGE_KEY, "system"]]);
  const requests: string[] = [];
  let reloads = 0;
  const env = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    location: { reload: () => reloads++ },
    navigator: { languages: ["en-US"] },
  };
  const original = installT3zhRuntime(dict, env);
  original.api.followClientSettings((locale) => requests.push(locale));
  original.api.setLocale("zh-CN");
  NodeAssert.deepEqual(requests, ["zh-CN"]);
  NodeAssert.equal(reloads, 0);
  original.api.syncClientLocale("zh-CN");
  original.api.syncClientLocale("zh-CN");
  NodeAssert.equal(reloads, 1);
  NodeAssert.equal(storage.get(LOCALE_STORAGE_KEY), "system");
  const restored = installT3zhRuntime(dict, env);
  NodeAssert.equal(restored.t("Settings"), "设置");
  restored.api.syncClientLocale("en");
  NodeAssert.equal(installT3zhRuntime(dict, env).t("Settings"), "Settings");
});

NodeTest.test("translates diagnosis sentences and preserves the host label and command", () => {
  const t = createTranslator(dict);
  const host = "Settings / 我的机器";
  NodeAssert.equal(t(`T3 Code on ${host} did not answer`), `${host} 上的 T3 Code 未响应`);
  NodeAssert.equal(
    t(`On ${host}, check Settings > Sharing & access or run \`t3 connect status\`.`),
    `在 ${host} 上查看「设置 → 共享与访问」，或运行 \`t3 connect status\`。`,
  );
  NodeAssert.equal(
    t(`Or run \`t3 auth connect-device approve <code>\` on ${host}.`),
    `也可以在 ${host} 上运行 \`t3 auth connect-device approve <code>\`。`,
  );
});

NodeTest.test("translates the startup summary without rewriting request diagnostics", () => {
  const t = createTranslator(dict);
  NodeAssert.equal(
    t("The server could not complete the connection (HTTP 500). Check that T3 Code is running on the server, then try again."),
    "服务端未能完成连接（HTTP 500）。请确认服务端正在运行 T3 Code，然后重试。",
  );
  NodeAssert.equal(
    t("The server requires a new sign-in (HTTP 401). Sign in again or open a new pairing link."),
    "服务端要求重新登录（HTTP 401）。请重新登录，或打开新的配对链接。",
  );
  const details = "Primary environment request failed during fetch-session-state (HTTP 500).";
  NodeAssert.equal(t(details), details);
});

NodeTest.test("preserves product, model, protocol and short statistics names", () => {
  const t = createTranslator(dict);
  for (const value of [
    "T3 Code",
    "T3 Code (Beta)",
    "Codex",
    "CC Switch",
    "gpt-6.1-sol",
    "API",
    "URL",
    "Token",
    "Tokens",
    "Bal",
    "Tok",
    "Cache",
    "C5",
    "C1",
    "t5",
    "t1",
    "t/s",
    "t/s5",
    "t/s1",
  ])
    NodeAssert.equal(t(value), value, value);
});

NodeTest.test("translates recent-task controls from exact old-style dictionary entries", () => {
  const t = createTranslator(dict);
  NodeAssert.equal(t("Recent tasks"), "最近任务");
  NodeAssert.equal(t("Recent"), "最近");
  NodeAssert.equal(t("Projects"), "项目");
  NodeAssert.equal(t("Status"), "状态");
  NodeAssert.equal(t("Thread list view"), "会话列表视图");
  NodeAssert.equal(t("No recent tasks"), "暂无最近任务");
  NodeAssert.equal(t("Collapse project"), "折叠项目");
  NodeAssert.equal(t("Expand project"), "展开项目");
});

NodeTest.test("numeric unit templates never consume dynamic titles or filenames", () => {
  const t = createTranslator(dict);
  for (const value of ["Message New thread", "Message Settings", "Record", "foo.md", "/path/read"])
    NodeAssert.equal(t(value), value, value);
  for (const [value, expected] of [
    ["3d", "3 天"],
    ["2h", "2 小时"],
    ["12m", "12 分钟"],
    ["1.5s", "1.5 秒"],
    ["250ms", "250 毫秒"],
  ])
    NodeAssert.equal(t(value), expected, value);
});

NodeTest.test("preserves full English PC statistics headings", () => {
  const t = createTranslator(dict);
  for (const label of [
    "Balance",
    "Quota balance",
    "Subscription balance",
    "Token usage",
    "Total token usage",
    "Today's spending",
    "Cache hit rate",
    "Cache hit rate · last 5 requests",
    "Tokens per second · last 5 requests",
    "Cache hit rate · last request",
    "Tokens per second · last request",
  ])
    NodeAssert.equal(t(label), label, label);
});

NodeTest.test("wraps static display text and accessible labels", () => {
  const result = transform(
    'export const view = <button aria-label="Settings">Recent tasks</button>;',
  );
  NodeAssert.match(result.output?.code ?? "", /__t3zh_t\("Settings"\)/);
  NodeAssert.match(result.output?.code ?? "", /__t3zh_t\("Recent tasks"\)/);
});

NodeTest.test(
  "dynamic titles and message text named Settings or Recent never enter the translator",
  () => {
    const source = `export const view = (thread, message, project) =>
    <section title={thread.title}><h2>{thread.title}</h2><p>{message.content}</p><small>{project.name}</small></section>;`;
    const result = transform(source);
    NodeAssert.equal(result.output, null);
  },
);

NodeTest.test(
  "leaves schema literals, action identifiers, comparisons and storage values unchanged",
  () => {
    const source = `const schema = Schema.Literals(["Settings", "Recent"]);
    type Mode = "Recent" | "Settings";
    const action = { type: "thread.create", event: "Settings" };
    localStorage.setItem("Settings", "Recent");
    const selected = mode === "Recent";
    export const view = <button>Settings</button>;`;
    const output = transform(source).output?.code ?? source;
    NodeAssert.ok(output.includes('Schema.Literals(["Settings", "Recent"])'));
    NodeAssert.ok(output.includes('type Mode = "Recent" | "Settings"'));
    NodeAssert.ok(output.includes('type: "thread.create", event: "Settings"'));
    NodeAssert.ok(output.includes('localStorage.setItem("Settings", "Recent")'));
    NodeAssert.ok(output.includes('mode === "Recent"'));
    NodeAssert.ok(output.includes('__t3zh_t("Settings")'));
  },
);

NodeTest.test("preserves source maps as original source content", () => {
  const source = "export const view = <button>Settings</button>;";
  const result = transform(source);
  NodeAssert.deepEqual(result.output?.map.sourcesContent, [source]);
});

NodeTest.test("preserves the model picker's English reasoning levels in a Chinese build", () => {
  const file = "apps/web/src/components/chat/ComposerModelEffort.tsx";
  const source = NodeFS.readFileSync(
    new URL("../../src/components/chat/ComposerModelEffort.tsx", import.meta.url),
    "utf8",
  );
  const result = transform(source, file);
  for (const level of ["Low", "Medium", "High", "Extra High", "Max", "Ultra"]) {
    NodeAssert.ok(
      result.candidates.some(
        (candidate) => candidate.key === level && candidate.reason === "skip-comment",
      ),
      level,
    );
  }
});

NodeTest.test("keeps brand suffixes after the T3 wordmark unchanged", () => {
  const source = "export const view = <div><T3Wordmark /> Code</div>;";
  const result = transform(source);
  NodeAssert.equal(result.output, null);
  NodeAssert.equal(result.candidates.find((item) => item.key === "Code")?.reason, "brand-name");
});

NodeTest.test("excludes mobile, server, test and code asset files from transformation", () => {
  NodeAssert.ok(isInScope("apps/web/src/components/Sidebar.tsx"));
  NodeAssert.ok(isInScope("packages/client-runtime/src/state/thread.ts"));
  for (const file of [
    "apps/mobile/src/Home.tsx",
    "apps/server/src/server.ts",
    "apps/web/src/foo.test.tsx",
    "apps/web/src/foo.browser.test.tsx",
    "apps/web/public/code.ts",
    "apps/web/src/example.txt",
  ])
    NodeAssert.equal(isInScope(file), false, file);
});
