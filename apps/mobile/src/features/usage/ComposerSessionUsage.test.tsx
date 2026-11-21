import { RunId, type ConversationUsage } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, onTestFinished, vi } from "vite-plus/test";

import { ComposerSessionUsage } from "./ComposerSessionUsage";

const keyboardDismiss = vi.hoisted(() => vi.fn());
vi.mock("react-native", () => {
  const Container = ({ children }: { children: ReactNode }) => <div>{children}</div>;
  return {
    Keyboard: { dismiss: keyboardDismiss },
    Modal: (props: { children: ReactNode; onRequestClose: () => void }) => (
      <div
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") props.onRequestClose();
        }}
      >
        {props.children}
      </div>
    ),
    Pressable: (props: {
      children: ReactNode;
      accessibilityLabel?: string;
      accessibilityState?: { expanded?: boolean };
      onPress: () => void;
    }) => (
      <button
        aria-label={props.accessibilityLabel}
        aria-expanded={props.accessibilityState?.expanded}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
    ScrollView: Container,
    View: Container,
    useWindowDimensions: () => ({ height: 500, width: 320 }),
  };
});
vi.mock("../../components/ui/AppText", () => ({
  AppText: (props: { children: ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ themeAppearance: "dark" }),
}));

it("opens the details, reflects live changes in both views and closes with Android Back", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  onTestFinished(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });
  const usage: ConversationUsage = {
    costUsd: 1.25,
    costPartial: true,
    categoryCostUsd: { input: 0.3, output: 0.5, cacheRead: 0.1, cacheWrite: 0.05 },
    turns: [
      {
        runId: RunId.make("latest"),
        cumulativeTokens: 250_000,
        tokensPerSecond: null,
        estimatedTokensPerSecond: null,
        costUsd: 0.5,
        costPartial: false,
        cacheRate: 0.6,
      },
    ],
  };
  const render = (props: ComponentProps<typeof ComposerSessionUsage>) =>
    act(() => root.render(<ComposerSessionUsage {...props} />));

  render({ usage, contextWindow: { usedTokens: 20, maxTokens: 100 } });
  const trigger = container.querySelector("button")!;
  expect(trigger.textContent).toBe("$1.25*");
  act(() => trigger.click());
  expect(keyboardDismiss).toHaveBeenCalledOnce();
  const details = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(details.textContent).toContain("最近一轮费用$0.50");
  expect(details.textContent).toContain("最近一轮缓存命中率60");
  expect(details.textContent).toContain("缓存读取$0.10");
  expect(details.textContent).toContain("分类未知$0.30");
  expect(details.textContent).toContain("仅含已知费用");
  expect(details.textContent).toContain("上下文占用 20");

  render({ usage: null, contextWindow: null });
  expect(trigger.textContent).toBe("—上下文用量未知");
  expect(trigger.getAttribute("aria-label")).toContain("上下文用量未知");
  expect(details.textContent).toContain("最近一轮费用—");
  expect(details.textContent).toContain("最近一轮缓存命中率—");
  expect(details.textContent).not.toContain("仅含已知费用");

  act(() => details.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
