import { RunId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { ComposerSessionUsage } from "./ComposerSessionUsage";

it("previews on hover, pins by click, and closes when clicked outside", async () => {
  await using screen = await render(
    <>
      <button type="button">Outside</button>
      <ComposerSessionUsage
        theme="light"
        usage={{
          costUsd: 0.12,
          costPartial: true,
          categoryCostUsd: { input: 0.03, output: 0.02, cacheRead: 0.01, cacheWrite: 0.01 },
          turns: [
            {
              runId: RunId.make("latest-run"),
              costUsd: 0.02,
              costPartial: false,
              cacheRate: 0.34,
              cumulativeTokens: 12_400,
              tokensPerSecond: 48,
              estimatedTokensPerSecond: null,
            },
          ],
        }}
        contextWindow={{ usedTokens: 29_000, maxTokens: 100_000 }}
      />
    </>,
  );
  const trigger = screen.getByRole("button", { name: /会话费用.*上下文占用/ });
  await expect.element(trigger.getByText("$0.12*")).toBeVisible();
  await expect.element(trigger.getByText("29.0%")).toBeVisible();
  const popup = page.getByRole("dialog", { name: "会话用量" });
  const outside = screen.getByRole("button", { name: "Outside" });
  await userEvent.hover(trigger);
  await expect.element(popup.getByText("仅含已知费用", { exact: false })).toBeVisible();
  await expect.element(popup.getByText("34.0%", { exact: true })).toBeVisible();
  await expect.element(popup.getByText("29,000 / 100,000 Token", { exact: true })).toBeVisible();
  await expect.element(popup.getByText("分类未知", { exact: true })).toBeVisible();
  await userEvent.hover(outside);
  await expect.element(popup).not.toBeInTheDocument();

  await userEvent.hover(trigger);
  await expect.element(popup).toBeVisible();
  await trigger.click();
  await userEvent.hover(outside);
  await expect.element(popup).toBeVisible();
  await outside.click();
  await expect.element(popup).not.toBeInTheDocument();
});

it("keeps a known context count when the limit and costs are unavailable", async () => {
  await using screen = await render(
    <ComposerSessionUsage
      theme="dark"
      usage={null}
      contextWindow={{ usedTokens: 10, maxTokens: null }}
    />,
  );
  await screen.getByRole("button", { name: /会话费用 —，上下文占用未知/ }).click();
  await expect.element(page.getByText("10 / — Token", { exact: true })).toBeVisible();
});
