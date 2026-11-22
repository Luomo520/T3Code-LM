import { createMemoryHistory } from "@tanstack/react-router";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import "~/index.css";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  CLAUDE_PROVIDER,
  CODEX_PROVIDER,
  ENVIRONMENT_ID,
  dispatchedCommands,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/components/usage/useConversationUsage"), () => {
  const sessionUsage = {
    costUsd: 123_456_789.12,
    costPartial: false,
    categoryCostUsd: null,
    turns: [],
  };
  return { useConversationUsage: () => sessionUsage };
});

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A Claude thread whose 250k-token context went cold long ago, with its native thread kept for handoff. */
function coldClaudeThread() {
  const thread = threadWithHistory("thread-claude", 3, {
    instanceId: CLAUDE,
    model: "claude-opus-4-6",
  });
  const at = DateTime.makeUnsafe("2026-03-17T19:12:28.000Z");
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread-claude"),
    driver: CLAUDE_DRIVER,
    providerInstanceId: CLAUDE,
    providerSessionId: null,
    appThreadId: thread.id,
    ownerNodeId: null,
    nativeThreadRef: { driver: CLAUDE_DRIVER, nativeId: "native-claude", strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 3,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: { usedTokens: 250_000, maxTokens: 1_000_000 },
    nativeMetadata: null,
    goal: null,
    createdAt: at,
    updatedAt: at,
  };
  return { ...thread, providerThreads: [providerThread] };
}

it("keeps usage readable in a narrow composer and sends a cross-provider follow-up", async () => {
  await page.viewport(680, 800);
  const thread = coldClaudeThread();
  using _environment = installFakeEnvironment([thread], {
    acceptCommands: true,
    providers: [
      {
        ...CLAUDE_PROVIDER,
        models: CLAUDE_PROVIDER.models.map((model) => ({
          ...model,
          name: "Claude Opus 4.6 with a long custom model name",
        })),
      },
      CODEX_PROVIDER,
    ],
  });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${thread.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 2 for ${thread.id}.`)).toBeVisible();
  const compactAndSend = page.getByRole("button", { name: "Compact and send" });
  await expect.element(compactAndSend).toBeVisible();

  const model = page.getByRole("button", { name: /Claude Opus 4\.6/ });
  const sessionUsage = page.getByRole("button", { name: /会话费用.*上下文占用 25\.0%/ });
  const amount = sessionUsage.getByText("$123,456,789.12");
  await expect.element(amount).toBeVisible();
  await vi.waitFor(() => {
    const amountElement = amount.element();
    const modelBounds = model.element().getBoundingClientRect();
    const usageBounds = sessionUsage.element().getBoundingClientRect();
    const actionBounds = compactAndSend.element().getBoundingClientRect();
    expect(modelBounds.right).toBeLessThanOrEqual(usageBounds.left);
    expect(usageBounds.right).toBeLessThanOrEqual(actionBounds.left);
    expect(usageBounds.top).toBeLessThan(actionBounds.bottom);
    expect(usageBounds.bottom).toBeGreaterThan(actionBounds.top);
    expect(actionBounds.right).toBeLessThanOrEqual(window.innerWidth);
    expect(amountElement.scrollWidth).toBeLessThanOrEqual(amountElement.clientWidth);
  });
  await sessionUsage.click();
  await expect.element(page.getByText("250K / 1M")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await model.click();
  await page.getByRole("button", { name: "搜索模型" }).click();
  await userEvent.type(page.getByPlaceholder("查找模型"), "GPT-5.4");
  await page.getByRole("option", { name: "GPT-5.4", exact: false }).click();
  await expect.element(page.getByRole("button", { name: "GPT-5.4", exact: true })).toBeVisible();
  await expect.element(compactAndSend).not.toBeInTheDocument();
  // Picking a model leaves the composer's settings menu open.
  await userEvent.keyboard("{Escape}");

  const editor = page.getByTestId("composer-editor");
  await userEvent.click(editor);
  await userEvent.type(editor, "keep going");
  await page.getByRole("button", { name: "Submit message" }).click();

  const messages = () =>
    dispatchedCommands().flatMap((command) =>
      command.type === "message.dispatch"
        ? [{ text: command.text, instanceId: command.modelSelection?.instanceId }]
        : [],
    );
  const sent = { text: "keep going", instanceId: CODEX_PROVIDER.instanceId };
  await vi.waitFor(() => expect(messages()).toContainEqual(sent));
  expect(messages()).toEqual([sent]);
});
