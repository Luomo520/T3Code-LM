import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { DraftHeroProjectHeading } from "~/components/chat/DraftHeroProjectHeading";
import { RightPanelMaximizeControl } from "~/components/chat/PanelLayoutControls";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import dictionary from "../../localization/dict/zh-CN.json";
import { installT3zhRuntime, LOCALE_STORAGE_KEY } from "../../localization/runtime/t3zh-runtime";
import {
  emitVcsStatus,
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render, stubGlobal } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// 隔离环境没有工作区文件查询，创建草稿时直接使用默认配置。
vi.mock(import("~/lib/t3ProjectFileDefaults"), async (original) => ({
  ...(await original()),
  readT3ProjectFile: async () => null,
}));

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it.each([
  {
    preference: null,
    locale: "zh-CN",
    placeholder: "输入问题，@ 引用文件，$ 使用技能，/ 输入命令",
    editor: "在编辑器中打开",
    commit: "提交",
    uncommitted: "未提交",
    draftHeading: "想在 render 中构建什么？",
    headingWithUserText: "想在 Open in editor 中构建什么？",
    branch: "分支：feature/Commit",
    voice: "开始语音输入",
    maximize: "最大化面板",
    resize: "调整侧栏宽度",
    permissions: "权限：完全访问",
    submit: "发送消息",
  },
  {
    preference: "en",
    locale: "en",
    placeholder: "Ask anything. @ files, $ skills, / commands",
    editor: "Open in editor",
    commit: "Commit",
    uncommitted: "Uncommitted",
    draftHeading: "What should we build in render?",
    headingWithUserText: "What should we build in Open in editor?",
    branch: "Branch: feature/Commit",
    voice: "Start voice input",
    maximize: "Maximize panel",
    resize: "Resize Sidebar",
    permissions: "Permissions: Full access",
    submit: "Submit message",
  },
])("shows thread controls in $locale while preserving workspace content", async (labels) => {
  using cleanup = new DisposableStack();
  const previousSettings = getClientSettings();
  cleanup.defer(() => __setClientSettingsForTests(previousSettings));
  const localization = installT3zhRuntime(dictionary, {
    navigator: { languages: ["en-US"] },
    localStorage: {
      getItem: (key) => (key === LOCALE_STORAGE_KEY ? labels.preference : null),
      setItem: () => {},
    },
  });
  cleanup.use(stubGlobal("__t3zh", localization.api));
  expect(localization.locale).toBe(labels.locale);
  await page.viewport(1440, 900);

  const thread = { ...threadWithHistory("interface-localization", 1), title: "Commit" };
  using _environment = installFakeEnvironment([thread]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const path = `/${ENVIRONMENT_ID}/${thread.id}`;
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  await expect
    .element(page.getByText("Sidebar.tsx", { exact: true }), { timeout: 8_000 })
    .toBeVisible();

  const branch = "feature/Commit";
  const local = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: branch,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "src/app.ts", insertions: 2, deletions: 0 }],
      insertions: 2,
      deletions: 0,
    },
  };
  await vi.waitFor(() => act(() => emitVcsStatus({ _tag: "snapshot", local, remote: null })), {
    timeout: 5_000,
  });

  await expect
    .element(page.getByTestId("composer-editor"), { timeout: 3_000 })
    .toHaveAttribute("aria-placeholder", labels.placeholder);
  for (const name of [labels.editor, labels.commit, labels.resize, labels.voice, labels.submit]) {
    await expect
      .element(page.getByRole("button", { name, exact: true }), { timeout: 3_000 })
      .toBeVisible();
  }
  await expect
    .element(page.getByText(labels.uncommitted, { exact: true }), { timeout: 3_000 })
    .toBeVisible();
  await expect
    .element(page.getByRole("combobox", { name: labels.branch, exact: true }), { timeout: 3_000 })
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "GPT-5.4", exact: true }), { timeout: 3_000 })
    .toBeVisible();
  await expect
    .element(
      page.getByRole("navigation", { name: "Threads" }).getByRole("button", { name: /^Commit\b/ }),
      { timeout: 3_000 },
    )
    .toBeVisible();

  await userEvent.click(page.getByRole("button", { name: "New thread in render" }));
  await expect
    .element(page.getByRole("heading", { name: labels.draftHeading }), { timeout: 5_000 })
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: labels.permissions }), { timeout: 3_000 })
    .toBeVisible();

  await using isolated = await render(
    <>
      <DraftHeroProjectHeading projectName="Open in editor">
        <button type="button">Open in editor</button>
      </DraftHeroProjectHeading>
      <RightPanelMaximizeControl maximized={false} onToggle={() => {}} />
    </>,
  );
  await expect
    .element(isolated.getByRole("heading", { name: labels.headingWithUserText }))
    .toBeVisible();
  await expect.element(isolated.getByRole("button", { name: "Open in editor" })).toBeVisible();
  await expect.element(isolated.getByRole("button", { name: labels.maximize })).toBeVisible();
});
