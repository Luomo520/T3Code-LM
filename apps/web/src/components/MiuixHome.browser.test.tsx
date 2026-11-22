import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "@fontsource-variable/inter";
import "~/index.css";

import { AppRoot } from "~/AppRoot";
import "~/components/ChatView";
import { __setClientSettingsForTests, getClientSettings } from "~/hooks/useSettings";
import { getThemeSnapshot, setAppearanceMode } from "~/hooks/useTheme";
import { getRouter } from "~/router";
import {
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

// 模拟项目没有 .t3project 文件。测试环境的文件查询不会返回结果。
vi.mock(import("~/lib/t3ProjectFileDefaults"), async (original) => ({
  ...(await original()),
  readT3ProjectFile: async () => null,
}));

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it.each([
  { width: 1440, height: 900, overlay: false },
  { width: 390, height: 780, overlay: true },
])("styles and preserves navigation on the $width px home", async ({ width, height, overlay }) => {
  using cleanup = new DisposableStack();
  const originalSettings = getClientSettings();
  cleanup.defer(() => __setClientSettingsForTests(originalSettings));
  const previousAppearanceMode = getThemeSnapshot().appearanceMode;
  cleanup.defer(() => setAppearanceMode(previousAppearanceMode));
  const taskViewKey = "t3.sidebar.task-view.v1";
  const previousTaskView = localStorage.getItem(taskViewKey);
  cleanup.defer(() =>
    previousTaskView === null
      ? localStorage.removeItem(taskViewKey)
      : localStorage.setItem(taskViewKey, previousTaskView),
  );
  localStorage.setItem(taskViewKey, JSON.stringify("recent"));
  await page.viewport(width, height);

  const first = threadWithHistory("home-recent", 1);
  const second = {
    ...threadWithHistory("home-long", 1),
    title: "核对会话正文文件链接和历史用量的一次长标题测试".repeat(4),
  };
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
    panelAnimationDurationMs: 0,
  });
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const heading = page.getByRole("heading", { name: /What should we build/ });
  const sidebar = page.getByRole("navigation", { name: "Threads", exact: true });
  const recent = sidebar.getByRole("button", { name: "Recent", exact: true });
  const longRow = sidebar.getByRole("button", { name: new RegExp(second.title) });
  const toggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
  const assistantMarkdown = page.getByText("Sidebar.tsx", { exact: true });

  for (const theme of [
    {
      appearance: "light",
      canvas: "rgb(244, 245, 248)",
      paper: "rgb(255, 255, 255)",
      selected: "rgb(231, 239, 255)",
    },
    {
      appearance: "dark",
      canvas: "rgb(23, 25, 30)",
      paper: "rgb(36, 38, 45)",
      selected: "rgb(41, 56, 83)",
    },
  ] as const) {
    await act(() => setAppearanceMode(theme.appearance));
    await expect.element(heading, { timeout: 10_000 }).toBeVisible();
    const home = heading.element().closest<HTMLElement>("[data-miuix-home]")!;
    expect(getComputedStyle(home).backgroundColor).toBe(theme.canvas);
    expect(getComputedStyle(heading.element()).fontWeight).toBe("680");
    expect(home.scrollWidth).toBe(home.clientWidth);
    const timeline = home.querySelector<HTMLElement>('[data-workspace-area="conversation"]')!;
    expect(getComputedStyle(timeline).backgroundColor).toBe(theme.canvas);

    if (overlay) await userEvent.click(toggle);
    await expect.element(recent, { timeout: 5_000 }).toHaveAttribute("aria-pressed", "true");
    expect(getComputedStyle(recent.element()).backgroundColor).toBe(theme.selected);
    await expect.element(longRow).toBeVisible();
    const title = longRow.element().querySelector<HTMLElement>("[data-sidebar-thread-title]")!;
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
    const rowGroup = sidebar.element().querySelectorAll("[data-sidebar-thread-group]");
    expect(rowGroup).toHaveLength(2);
    expect(getComputedStyle(rowGroup[0]!).backgroundColor).toBe(theme.paper);
    expect(getComputedStyle(rowGroup[0]!).borderStartStartRadius).toBe("18px");
    expect(getComputedStyle(rowGroup[0]!).borderEndStartRadius).toBe("0px");
    expect(getComputedStyle(rowGroup[1]!).borderEndStartRadius).toBe("18px");
    expect(getComputedStyle(rowGroup[1]!).borderStartStartRadius).toBe("0px");

    longRow.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(assistantMarkdown).toBeVisible();
    expect(assistantMarkdown.element().closest("[data-miuix-home]")).toBeNull();
    expect(assistantMarkdown.element().closest(".chat-markdown")).not.toBeNull();

    if (overlay) await userEvent.click(toggle);
    await expect.element(longRow).toHaveAttribute("aria-current", "page");
    expect(getComputedStyle(longRow.element()).backgroundColor).toBe(theme.selected);
    if (overlay) await userEvent.keyboard("{Escape}");
    await act(() => router.history.back());
    await expect.element(heading, { timeout: 10_000 }).toBeVisible();
  }
});
