import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HeaderUsageSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import "../../index.css";

const state = vi.hoisted(() => ({
  data: null as HeaderUsageSummary | null,
  refresh: vi.fn(),
  update: vi.fn(),
  now: 0,
  canManage: true,
  pending: false,
}));

vi.mock(import("../../state/server"), async () => {
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make({
    environment: { capabilities: { headerUsage: true } },
    settings: { providerInstances: {} },
    providers: [{ instanceId: "codex", driver: "codex", enabled: true, displayName: "Test Codex" }],
  });
  const allowed = Atom.make(true);
  return {
    environmentServerConfigsAtom: Atom.make(new Map()),
    serverEnvironment: {
      configValueAtom: () => config,
      mutateProviderInstance: { permissionAtom: () => allowed },
    },
  } as never;
});
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  useEnvironmentIds: () => [],
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../state/session"), () => ({
  useEnvironmentScope: () => state.canManage,
  readEnvironmentScope: () => state.canManage,
}));
vi.mock(import("../../state/use-atom-command"), () => ({ useAtomCommand: () => state.update }));
vi.mock("./headerUsageQuery", () => ({
  useHeaderUsageQuery: () => ({
    data: state.data,
    config: {
      environment: { capabilities: { headerUsage: true } },
      settings: { providerInstances: {} },
      providers: [
        { instanceId: "codex", driver: "codex", enabled: true, displayName: "Test Codex" },
      ],
    },
    supported: true,
    resolvedInstanceId: "codex",
    refresh: state.refresh,
    now: state.now,
    error: null,
    isPending: state.pending,
  }),
}));

import { HeaderUsageStats } from "./HeaderUsageStats";

function setup() {
  const counters = {
    tokens: 12345,
    todayTokens: 2000,
    cacheRate: 0.994,
    recentRate: 0.89,
    lastRate: 0.925,
    recentSpeed: 12.5,
    lastSpeed: null,
    speedSamples: 3,
    recentSamples: 5,
    partial: false,
    recentRequestSamples: [],
  };
  state.data = {
    providerInstanceId: "codex",
    providerLabel: "Test Codex",
    readAt: "1970-01-01T00:00:00.000Z",
    localReadAt: "1970-01-01T00:00:00.000Z",
    localRefreshing: false,
    account: {
      balance: 12.5,
      balanceKind: "balance",
      currency: "USD",
      totalTokens: 1234567,
      todayCost: 0.5,
      readAt: "1970-01-01T00:00:00.000Z",
      stale: false,
      message: "测试数据",
      refreshSeconds: 60,
    },
    conversation: counters,
    allConversations: { ...counters, todayTokens: 50000, cacheRate: 0.905 },
  };
  state.now = 0;
  state.canManage = true;
  state.pending = false;
  state.refresh.mockReset();
  state.update.mockReset().mockResolvedValue({ _tag: "Success", value: { providerInstances: {} } });
}

function surface(home = false) {
  return (
    <RegistryProvider>
      <div className="@container/header flex w-96 items-center gap-2">
        <span className="min-w-10 flex-1 truncate">当前会话标题</span>
        <HeaderUsageStats
          environmentId={EnvironmentId.make("test-environment")}
          providerInstanceId={ProviderInstanceId.make("codex")}
          {...(home ? { home: true } : { threadId: "test-thread" })}
        />
      </div>
    </RegistryProvider>
  );
}

it("keeps eight requested metrics aligned and scrollable outside the title drag region", async () => {
  setup();
  await using screen = await render(surface());
  const trigger = screen.container.querySelector<HTMLButtonElement>("[data-header-usage=thread]")!;
  expect(trigger.textContent).toBe(
    "余额$12.50用量12.3KDay2.0K总缓存99.4%缓存589.0%缓存92.5%t/s512.5t/s—",
  );
  expect(getComputedStyle(trigger).getPropertyValue("-webkit-app-region")).toBe("no-drag");
  const items = [...trigger.children] as HTMLElement[];
  expect(new Set(items.map((item) => item.getBoundingClientRect().height)).size).toBe(1);
  for (const item of items) {
    const heading = item.firstElementChild!.getBoundingClientRect();
    const value = item.lastElementChild!.getBoundingClientRect();
    expect(Math.abs((heading.left + heading.right - value.left - value.right) / 2)).toBeLessThan(
      0.5,
    );
  }
  expect(parseFloat(getComputedStyle(trigger).columnGap)).toBe(12);
  expect(trigger.scrollWidth).toBeGreaterThan(trigger.clientWidth);
  expect(getComputedStyle(trigger).overflowX).toBe("auto");
  expect(screen.container.querySelector("span")!.getBoundingClientRect().width).toBeGreaterThan(40);
  expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(
    screen.container.firstElementChild!.getBoundingClientRect().right,
  );
});

it("keeps centered labels and values apart across narrow and wide headers with long counters", async () => {
  setup();
  state.data = {
    ...state.data!,
    account: { ...state.data!.account, balance: 9999.99 },
    conversation: {
      ...state.data!.conversation,
      tokens: 99_900_000_000,
      lastSpeed: 153.7,
      speedSampleAt: "1970-01-01T00:00:00.000Z",
      speedStale: true,
    },
  };
  await using screen = await render(surface());
  const container = screen.container.firstElementChild as HTMLElement;
  const trigger = container.querySelector<HTMLElement>("[data-header-usage=thread]")!;
  for (const width of [320, 360, 384, 600, 1000]) {
    container.style.width = `${width}px`;
    const items = [...trigger.children] as HTMLElement[];
    const expectedGap = width < 544 ? 12 : 16;
    expect(parseFloat(getComputedStyle(trigger).columnGap)).toBe(expectedGap);
    for (const [index, item] of items.entries()) {
      const heading = item.firstElementChild!.getBoundingClientRect();
      const value = item.lastElementChild!.getBoundingClientRect();
      expect(Math.abs((heading.left + heading.right - value.left - value.right) / 2)).toBeLessThan(
        0.5,
      );
      if (index > 0) {
        expect(
          item.getBoundingClientRect().left - items[index - 1]!.getBoundingClientRect().right,
        ).toBeGreaterThanOrEqual(expectedGap - 0.5);
      }
    }
    expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(
      container.getBoundingClientRect().right + 0.5,
    );
    expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(width * 0.7 + 0.5);
    expect(container.firstElementChild!.getBoundingClientRect().width).toBeGreaterThan(40);
  }
});

it("opens refresh and manual query settings and saves through the existing environment command", async () => {
  setup();
  await using screen = await render(surface());
  await screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  expect(state.refresh).toHaveBeenCalledOnce();
  await page.getByRole("button", { name: "查询设置", exact: true }).click();
  await page.getByRole("textbox", { name: "余额查询网址" }).fill("example.test");
  await page.getByLabelText("余额查询 Key").fill("test-only");
  await page.getByRole("button", { name: "保存查询设置", exact: true }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("查询设置已保存。");
  expect(state.update).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-environment"),
    input: {
      patch: {},
      providerInstanceMutation: {
        operation: "upsert",
        instanceId: ProviderInstanceId.make("codex"),
        instance: {
          driver: ProviderDriverKind.make("codex"),
          config: {
            billingUrl: "https://example.test/v1/usage",
            billingKey: "test-only",
            billingRefreshSeconds: "60",
            billingSource: "environment",
          },
        },
      },
    },
  });
});

it("shows home metrics and expiry stars with missing last speed preserved", async () => {
  setup();
  state.now = 60000;
  await using screen = await render(surface(true));
  const trigger = screen.container.querySelector<HTMLButtonElement>("[data-header-usage=home]")!;
  expect(trigger.textContent).toContain("余额*$12.50用量*1.2MDay*50.0K总缓存*90.5%");
  expect(trigger.querySelectorAll("sup")).toHaveLength(4);
});

it("saves CC Switch following without a manual query address or key", async () => {
  setup();
  state.data = {
    ...state.data!,
    account: { ...state.data!.account, sourceLabel: "CC Switch · 测试供应商" },
  };
  state.update.mockResolvedValueOnce({
    _tag: "Success",
    value: {
      providerInstances: {
        codex: { config: { billingSource: "ccSwitch", billingRefreshSeconds: "60" } },
      },
    },
  });
  await using screen = await render(surface());
  await screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ }).click();
  await expect
    .element(page.getByText("Test Codex · 账单来源：CC Switch · 测试供应商"))
    .toBeVisible();
  await page.getByRole("button", { name: "查询设置", exact: true }).click();
  await page.getByRole("switch", { name: "跟随 CC Switch", exact: true }).click();
  await expect.element(page.getByRole("textbox", { name: "余额查询网址" })).toBeDisabled();
  await expect.element(page.getByLabelText("余额查询 Key")).toBeDisabled();
  await page.getByRole("button", { name: "保存查询设置", exact: true }).click();
  expect(state.update).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        providerInstanceMutation: expect.objectContaining({
          instance: expect.objectContaining({
            config: { billingSource: "ccSwitch", billingRefreshSeconds: "60" },
          }),
        }),
      }),
    }),
  );
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("已保存：跟随 CC Switch 当前 Codex 默认供应商。");
});

it("shows five authoritative request rows without mixing separate cache and speed windows", async () => {
  setup();
  const samples = Array.from({ length: 6 }, (_, index) => ({
    timestamp: new Date(Date.UTC(2026, 9, 31, 12, 5 - index)).toISOString(),
    totalTokens: 1200 + index,
    cacheRate: index === 0 ? null : index === 1 ? 0 : 0.925,
    tokensPerSecond: index === 1 ? null : 201.74 + index,
  }));
  state.data = {
    ...state.data!,
    conversation: {
      ...state.data!.conversation,
      recentRequestSamples: samples,
      recentCacheSamples: [
        {
          timestamp: samples[0]!.timestamp,
          inputTokens: 999999,
          cachedInputTokens: 999999,
          cacheRate: 1,
        },
      ],
      recentSpeedSamples: [
        { timestamp: samples[0]!.timestamp, outputTokens: 1, seconds: 1, tokensPerSecond: 999 },
      ],
    },
  };
  await using screen = await render(surface());
  await screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ }).click();
  await expect.element(page.getByRole("table", { name: "最近5次请求" })).toBeVisible();
  const table = document.querySelector<HTMLTableElement>('table[aria-label="最近5次请求"]')!;
  expect([...table.querySelectorAll("thead th")].map((cell) => cell.textContent)).toEqual([
    "时间",
    "Token",
    "缓存率",
    "速度 t/s",
  ]);
  const rows = [...table.querySelectorAll("tbody tr")];
  expect(rows).toHaveLength(5);
  expect(rows[0]!.textContent).toContain("1,200");
  expect(rows[0]!.textContent).toContain("201.7");
  expect(rows[0]!.textContent).not.toContain("999");
  expect(rows[1]!.textContent).toContain("0.0%");
  expect(rows[1]!.querySelectorAll("td")[2]!.textContent).toBe("—");
  expect([...table.querySelectorAll("time")].map((time) => time.dateTime)).toEqual(
    samples.slice(0, 5).map((sample) => sample.timestamp),
  );
  const popup = table.closest('[data-slot="popover-popup"]')!;
  expect(popup.querySelector("dl")).not.toBeNull();
  expect(popup.textContent).toContain("今日用量");
  expect(popup.textContent).not.toContain("统计说明");
});

it("does not invent request totals or join old windows when the backend lacks request rows", async () => {
  setup();
  const conversation = { ...state.data!.conversation };
  Reflect.deleteProperty(conversation, "recentRequestSamples");
  state.data = { ...state.data!, conversation };
  await using screen = await render(surface());
  await screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ }).click();
  await expect.element(page.getByText("更新后台以查看逐次统计。", { exact: true })).toBeVisible();
  expect(document.querySelector('table[aria-label="最近5次请求"]')).toBeNull();
  state.data = { ...state.data!, conversation: { ...conversation, recentRequestSamples: [] } };
  await screen.rerender(surface());
  await expect.element(page.getByText("暂无请求记录。", { exact: true })).toBeVisible();
});

it("keeps request rows inside narrow viewports with refresh still reachable", async () => {
  setup();
  state.data = {
    ...state.data!,
    conversation: {
      ...state.data!.conversation,
      recentRequestSamples: Array.from({ length: 5 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 9, 31, 12, index)).toISOString(),
        totalTokens: 999_999_999_999,
        cacheRate: 0.888,
        tokensPerSecond: 999999999.9,
      })),
    },
  };
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await using screen = await render(surface());
  try {
    for (const width of [260, 320]) {
      await page.viewport(width, 480);
      (screen.container.firstElementChild as HTMLElement).style.width = `${width}px`;
      const trigger = screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ });
      await trigger.click();
      await expect.element(page.getByRole("table", { name: "最近5次请求" })).toBeVisible();
      const popup = document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!;
      const details = document.querySelector<HTMLElement>("[data-header-usage-details]")!;
      await vi.waitFor(() => {
        expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
        expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth + 1);
        expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
        expect(popup.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
        expect(popup.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1);
      });
      details.scrollTop = details.scrollHeight;
      await page.getByRole("button", { name: "刷新", exact: true }).click();
      await trigger.click();
    }
    expect(state.refresh).toHaveBeenCalledTimes(2);
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});

it("keeps the refresh control stable during background polls and only locks a manual request", async () => {
  setup();
  let finish!: () => void;
  state.refresh.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await using screen = await render(surface());
  await screen.getByRole("button", { name: /点击查看余额与用量详情和查询设置/ }).click();
  const button = page.getByRole("button", { name: "刷新", exact: true });
  const element = [...document.querySelectorAll("button")].find((e) => e.textContent === "刷新")!;
  state.pending = true;
  await screen.rerender(surface());
  await expect.element(button).toBeEnabled();
  expect([...document.querySelectorAll("button")].find((e) => e.textContent === "刷新")).toBe(
    element,
  );
  await button.click();
  await expect.element(button).toBeDisabled();
  expect(element.textContent).toBe("刷新");
  finish();
  await expect.element(button).toBeEnabled();
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
