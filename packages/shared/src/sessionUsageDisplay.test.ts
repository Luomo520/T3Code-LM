import { expect, it } from "vite-plus/test";

import { sessionUsageDisplay } from "./sessionUsageDisplay.ts";

it("displays exact context counts and the real ratio even if the bar is full", () => {
  expect(sessionUsageDisplay(null, { usedTokens: 240_123, maxTokens: 200_000 })).toMatchObject({
    costLabel: "—",
    contextTokensLabel: "240,123 / 200,000 Token",
    contextPercentageLabel: "120.1%",
    contextBarPercentage: 100,
  });
});

it("keeps independently known costs, counts and limits, including a real zero", () => {
  const zeroCost = { costUsd: 0, costPartial: false, categoryCostUsd: null, turns: [] };
  expect(sessionUsageDisplay(zeroCost, { usedTokens: null, maxTokens: 200_000 })).toMatchObject({
    costLabel: "$0.00",
    contextTokensLabel: "— / 200,000 Token",
    contextPercentageLabel: "—",
  });
  expect(sessionUsageDisplay(null, { usedTokens: 0, maxTokens: null })).toMatchObject({
    costLabel: "—",
    contextTokensLabel: "0 / — Token",
    contextPercentageLabel: "—",
  });
  expect(sessionUsageDisplay(null, { usedTokens: 0, maxTokens: 200_000 })).toMatchObject({
    costLabel: "—",
    contextPercentageLabel: "0.0%",
    contextBarPercentage: 0,
  });
});
