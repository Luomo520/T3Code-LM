import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { makeThreadFixture } from "../test-fixtures";
import type { Thread } from "../types";
import { useThreadFindStore } from "./chat/threadFindStore";
import { act, render } from "../../test/render";
import { CommandPalette } from "./CommandPalette";
import { openCommandPalette } from "../commandPaletteBus";
import { primaryServerKeybindingsAtom } from "../state/server";

const scopes = vi.hoisted(() => ({
  denied: undefined as string | undefined,
  sourceControl: undefined as unknown,
  threads: [] as ReadonlyArray<Thread>,
  matches: [] as ReadonlyArray<EnvironmentThreadSearchMatch>,
}));
const setup = (deniedScope?: string, sourceControl?: unknown) => {
  scopes.denied = deniedScope;
  scopes.sourceControl = sourceControl;
  scopes.threads = [];
  scopes.matches = [];
};
const githubAvailable = {
  versionControlSystems: [],
  sourceControlProviders: [
    {
      kind: "github",
      label: "GitHub",
      status: "available",
      version: { _tag: "None" },
      installHint: "Install GitHub CLI",
      detail: { _tag: "None" },
      auth: {
        status: "authenticated",
        account: { _tag: "Some", value: "demo" },
        host: { _tag: "None" },
        detail: { _tag: "None" },
      },
    },
  ],
};

vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) =>
    atom === primaryServerKeybindingsAtom ? DEFAULT_RESOLVED_KEYBINDINGS : [],
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "light",
  useTheme: () => ({ theme: "t3-chat", resolvedTheme: "light", appearanceMode: "light" }),
}));
vi.mock("../hooks/useCustomThemes", () => ({ useCustomThemes: () => [] }));
vi.mock("../hooks/useEnvironmentTheme", () => ({ useEnvironmentThemeDefinitions: () => [] }));
vi.mock("../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../hooks/useSettings")>()),
  useClientSettings: () => DEFAULT_CLIENT_SETTINGS,
  useUpdateEnvironmentSettings: () => () => undefined,
}));
vi.mock("../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ scratchEnvironmentId: () => null }),
}));
vi.mock("../hooks/useNewProject", () => ({ useNewProject: () => async () => undefined }));
vi.mock("../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: async () => undefined,
  }),
  useNewThreadHandler: () => async () => undefined,
}));
vi.mock("../hooks/useOpenPanelPullRequestUrl", () => ({ useOpenPanelPullRequestUrl: () => null }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("../state/use-atom-command", () => ({
  // The add-project destination step starts a clone and follows its project id.
  useAtomCommand: () => async () => ({ _tag: "Success", value: { projectId: "project-cloned" } }),
}));
vi.mock("../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Success", value: undefined }),
}));
vi.mock("../state/environments", async (original) => ({
  ...(await original<typeof import("../state/environments")>()),
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "Local",
        connection: { phase: "connected" },
        entry: { target: { _tag: "PrimaryConnectionTarget" } },
        serverConfig: {
          environment: { platform: { os: "linux" }, capabilities: { projectCloneTracking: true } },
          settings: { addProjectBaseDirectory: "/workspace/" },
          newProjectsRoot: "/workspace/",
        },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => "local",
  useEnvironmentProviders: () => new Map(),
}));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  useProjects: () => [],
  useThreadShells: () => [],
  useVisibleThreadShells: () => scopes.threads,
  useHiddenThreadKeys: () => new Set(),
  useAnyEnvironmentHiding: () => false,
  useEnvironmentThreadRefs: () => [],
  useServerConfigs: () => new Map(),
  waitForProject: async () => undefined,
}));
vi.mock("../state/queries", async (original) => ({
  ...(await original<typeof import("../state/queries")>()),
  useThreadSearch: (_environmentIds: unknown, query: string) => ({
    matches: query ? scopes.matches : [],
    query,
    isPending: false,
  }),
}));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  useEnvironmentScope: (_environmentId: unknown, scope: string) => scope !== scopes.denied,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/filesystem", async (original) => ({
  ...(await original<typeof import("../state/filesystem")>()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock("../state/query", async (original) => ({
  ...(await original<typeof import("../state/query")>()),
  useEnvironmentQuery: () => ({ data: scopes.sourceControl, isLoading: false }),
}));
vi.mock("./ThreadStatusIndicators", () => ({
  ThreadRowLeadingStatus: () => null,
  ThreadRowTrailingStatus: () => null,
  ThreadSearchPullRequestNumber: () => null,
}));
vi.mock("./settings/useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [],
}));

// The real palette and Base UI input must agree that confirming composition is typing.
describe.each(["repository", "folder", "destination"] as const)("add-project %s", (step) => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 },
  ])("keeps Enter in the input during composition: %j", async (composition) => {
    setup();
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(step === "folder" ? "Local folder" : "Git URL", { exact: true }).click();
    const input = () => page.getByRole("combobox");
    if (step === "destination") {
      await input().fill("https://example.com/team/project.git");
      await userEvent.keyboard("{Enter}");
    }
    const value = step === "repository" ? "https://example.com/team/計画.git" : "/workspace/計画";
    await input().fill(value);
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
      ...composition,
    });
    await act(() => input().element().dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    await expect.element(input()).toHaveValue(value);
    if (step === "repository") {
      await userEvent.keyboard("{Enter}");
      await expect.element(input()).toHaveValue("/workspace/計画");
    } else {
      await userEvent.keyboard("{Enter}");
      await expect.element(page.getByRole("combobox")).not.toBeInTheDocument();
    }
  });
});

it.each([
  { step: "folder", source: "Local folder", keys: "", description: /^(?!.*(Ctrl|⌘)).*Add.*Enter/ },
  {
    step: "highlighted folder",
    source: "Local folder",
    keys: "{ArrowDown}",
    description: /Add.*(Ctrl|⌘) Enter/,
  },
  { step: "repository", source: "Git URL", keys: "", description: /Continue.*Enter/ },
  { step: "new project", source: "New project", keys: "", description: /Create.*Enter/ },
  {
    step: "permission-blocked folder",
    source: "Local folder",
    keys: "",
    deniedScope: AuthOrchestrationOperateScope,
    description: "This connection cannot add projects.",
  },
  {
    step: "permission-blocked destination",
    source: "Git URL",
    keys: "https://example.com/team/project.git{Enter}",
    deniedScope: AuthSourceControlWriteScope,
    description: "This connection needs permission to write source control and add projects.",
  },
])(
  "tells screen readers how to submit the $step step",
  async ({ source, keys, deniedScope, description }) => {
    setup(deniedScope);
    await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
    await act(() => openCommandPalette({ open: "add-project" }));
    await page.getByText(source, { exact: true }).click();
    if (keys) await userEvent.keyboard(keys);
    await expect.element(page.getByRole("combobox")).toHaveAccessibleDescription(description);
  },
);

it("keeps the caret in place when an edit briefly makes the folder path not a path", async () => {
  setup();
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("Local folder", { exact: true }).click();
  const input = () => page.getByRole("combobox");
  await input().fill("/workspace/project");
  await userEvent.keyboard("{Home}{ArrowRight}{Backspace}");
  await expect.element(input()).toHaveValue("workspace/project");
  await userEvent.keyboard("/");
  await expect.element(input()).toHaveValue("/workspace/project");
  await userEvent.keyboard("w");
  await expect.element(input()).toHaveValue("/wworkspace/project");
});

it.each([
  { flow: "Git URL", value: "https://github.com/pingdotgg/t3code.git", submit: "Continue (Enter)" },
  { flow: "New project", value: "demo-tab-order", submit: /^Create \(/ },
])("moves focus from the $flow input to its enabled submit button on Tab", async (step) => {
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText(step.flow, { exact: true }).click();
  const input = page.getByRole("combobox");
  await input.fill(step.value);
  const submit = page.getByRole("button", { name: step.submit });
  await expect.element(submit).toBeEnabled();
  await userEvent.keyboard("{Tab}");
  await expect.element(submit).toHaveFocus();
});

it("tells screen readers whether a new project will be published", async () => {
  setup(undefined, githubAvailable);
  await using _screen = await render(<CommandPalette>{null}</CommandPalette>);
  await act(() => openCommandPalette({ open: "add-project" }));
  await page.getByText("New project", { exact: true }).click();
  await page.getByRole("combobox").fill("demo-project");
  const option = page.getByRole("option", { name: /Create private repository/ });
  await expect.element(option).toHaveAttribute("aria-checked", "false");
  await option.click();
  await expect.element(option).toHaveAttribute("aria-checked", "true");
});

it("returns from a message match to the search query and result scroll position", async () => {
  setup();
  const environmentId = EnvironmentId.make("local");
  const projectId = ProjectId.make("project");
  const threadId = ThreadId.make("message-match");
  const messageId = MessageId.make("matching-message");
  scopes.threads = [
    ...Array.from({ length: 20 }, (_, index) =>
      makeThreadFixture({
        environmentId,
        projectId,
        id: ThreadId.make(`title-${index}`),
        title: `pnpm test ${index}`,
      }),
    ),
    makeThreadFixture({ environmentId, projectId, id: threadId, title: "Release checks" }),
  ];
  scopes.matches = [
    {
      environmentId,
      projectId,
      threadId,
      messageId,
      source: "assistant",
      messageCreatedAt: null,
      snippet: "Before deploying, run pnpm test and review the report.",
    },
  ];
  await using screen = await render(
    <CommandPalette>
      <style>{`[data-command-palette] .overscroll-y-contain { max-height: 240px; overflow-y: auto; }`}</style>
    </CommandPalette>,
  );

  await act(() => openCommandPalette({ query: "pnpm test" }));
  const listbox = page.getByRole("listbox");
  const getScrollContainer = () =>
    listbox.element().querySelector<HTMLElement>(".overscroll-y-contain")!;
  await vi.waitFor(() => {
    const viewport = getScrollContainer();
    expect(viewport.scrollHeight - viewport.clientHeight).toBeGreaterThan(100);
  });
  await act(() => {
    const viewport = getScrollContainer();
    viewport.scrollTop = viewport.scrollHeight;
  });

  const result = page.getByRole("option", { name: /Release checks/ });
  await expect.element(result).toBeVisible();
  const position = getScrollContainer().scrollTop;
  expect(position).toBeGreaterThan(100);
  await result.click();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe("/local/message-match");
    expect(useThreadFindStore.getState().start?.entryId).toBe(messageId);
  });

  const returnToResults = useThreadFindStore.getState().onBackToResults;
  expect(returnToResults).toBeTypeOf("function");
  await act(() => returnToResults?.());
  await expect.element(page.getByRole("combobox")).toHaveValue("pnpm test");
  await vi.waitFor(() =>
    expect(Math.abs(getScrollContainer().scrollTop - position)).toBeLessThan(2),
  );
});
