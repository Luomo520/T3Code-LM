import appCss from "../index.css?inline";
import {
  PrimaryConnectionTarget,
  type EnvironmentServerConfig,
} from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useUiStateStore } from "../uiStateStore";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import type { Project } from "../types";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: () => null,
  SidebarChromeFooter: () => null,
}));

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

it("shows only the current environment and clears a visible project filter in one click", async () => {
  using stack = new DisposableStack();
  const previousUi = useUiStateStore.getState();
  stack.defer(() => useUiStateStore.setState(previousUi));
  const key = "t3.sidebar.task-view.v1";
  const previousView = localStorage.getItem(key);
  stack.defer(() =>
    previousView === null ? localStorage.removeItem(key) : localStorage.setItem(key, previousView),
  );
  localStorage.setItem(key, JSON.stringify("recent"));

  const occupied = project("occupied");
  const empty = project("empty");
  const remote = { ...project("remote"), environmentId: EnvironmentId.make("remote") };
  const localThread = threadShell(occupied.id, 6100);
  const remoteThread = {
    ...threadShell(remote.id, 6101),
    environmentId: remote.environmentId,
  };
  const localTarget = new PrimaryConnectionTarget({
    environmentId: occupied.environmentId,
    label: "local",
    httpBaseUrl: "http://localhost",
    wsBaseUrl: "ws://localhost",
  });
  const localEnvironment = {
    environmentId: occupied.environmentId,
    label: "local",
    displayUrl: null,
    relayManaged: false,
    entry: { target: localTarget, profile: Option.none(), enabled: true },
    connection: { phase: "offline" as const, error: null, traceId: null },
    serverConfig: null,
  };

  vi.mocked(useProjects).mockReturnValue([occupied, empty, remote]);
  vi.mocked(useQuietThreadShells).mockReturnValue([localThread, remoteThread]);
  vi.mocked(useThreadRouteTarget).mockReturnValue(null);
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(occupied.environmentId);
  vi.mocked(useEnvironments).mockReturnValue({
    isReady: true,
    networkStatus: "online",
    environments: [],
    presentationById: new Map(),
  });
  stack.defer(() => {
    vi.mocked(usePrimaryEnvironmentId).mockReset();
    vi.mocked(useEnvironments).mockReset();
  });
  useUiStateStore.setState({ sidebarProjectScopeKeys: ["local:/projects/empty"] });
  const sidebar = () => (
    <SidebarProvider style={{ maxWidth: 200 }}>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  await using screen = await render(sidebar());
  await expect.element(screen.getByRole("button", { name: "清除项目筛选：empty" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "查看全部项目" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "清除项目筛选：empty" }));
  expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([]);
  expect(screen.container.textContent).toContain(localThread.title);
  expect(screen.container.textContent).not.toContain(remoteThread.title);

  vi.mocked(useQuietThreadShells).mockReturnValue([]);
  vi.mocked(useEnvironments).mockReturnValue({
    isReady: true,
    networkStatus: "online",
    environments: [localEnvironment],
    presentationById: new Map(),
  });
  await screen.rerender(sidebar());
  await expect
    .element(screen.getByRole("status").filter({ hasText: "环境连接已中断" }))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("No threads yet");

  vi.mocked(useEnvironments).mockReturnValue({
    isReady: true,
    networkStatus: "online",
    environments: [
      { ...localEnvironment, connection: { ...localEnvironment.connection, phase: "connecting" } },
    ],
    presentationById: new Map(),
  });
  await screen.rerender(sidebar());
  await expect
    .element(screen.getByRole("status").filter({ hasText: "正在载入会话…" }))
    .toBeVisible();
});

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const previousView = localStorage.getItem("t3.sidebar.task-view.v1");
    stack.defer(() => {
      if (previousView === null) localStorage.removeItem("t3.sidebar.task-view.v1");
      else localStorage.setItem("t3.sidebar.task-view.v1", previousView);
    });
    localStorage.setItem("t3.sidebar.task-view.v1", JSON.stringify("status"));
    const activeProject = project("active");
    const threads = Array.from({ length: 250 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

it("shows current pin activity and keeps paged project icons colored", async () => {
  using stack = new DisposableStack();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  stack.defer(() => style.remove());
  const previousSettings = getClientSettings();
  stack.defer(() => __setClientSettingsForTests(previousSettings));
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  const key = "t3.sidebar.task-view.v1";
  const previousView = localStorage.getItem(key);
  stack.defer(() =>
    previousView === null ? localStorage.removeItem(key) : localStorage.setItem(key, previousView),
  );
  localStorage.setItem(key, JSON.stringify("project"));

  const previousUi = useUiStateStore.getState();
  stack.defer(() => useUiStateStore.setState(previousUi));
  useUiStateStore.setState({
    sidebarProjectScopeKeys: ["local:/projects/scoped"],
    projectExpandedById: {},
  });

  const scoped: Project = {
    ...project("scoped"),
    projectIcon: { kind: "monogram", text: "通用", color: "orange" },
  };
  const other = project("other");
  const active = {
    ...threadShell(scoped.id, 1000),
    latestConversationMessageAt: "2026-04-01T00:00:00Z",
  };
  const firstPin = {
    ...threadShell(scoped.id, 1001),
    branch: "release/one",
    latestConversationMessageAt: "2026-01-01T00:00:00Z",
    pinnedAt: "2026-04-02T00:00:00Z",
    pinOrderKey: "a",
  };
  const secondPin = {
    ...threadShell(scoped.id, 1002),
    latestConversationMessageAt: "2026-03-01T00:00:00Z",
    pinnedAt: "2026-04-03T00:00:00Z",
    pinOrderKey: "b",
  };
  const history = Array.from({ length: 201 }, (_, index) => ({
    ...threadShell(scoped.id, index),
    settledOverride: "settled" as const,
    settledAt: "2026-04-01T00:00:00Z",
    latestConversationMessageAt: "2026-04-01T00:00:00Z",
  }));
  const outsideScope = {
    ...threadShell(other.id, 1003),
    pinnedAt: firstPin.pinnedAt,
    pinOrderKey: "0",
  };
  const legacySettledPin = {
    ...threadShell(scoped.id, 1004),
    settledOverride: "settled" as const,
    settledAt: "2026-01-01T00:00:00Z",
    latestConversationMessageAt: "2026-01-02T00:00:00Z",
    pinnedAt: firstPin.pinnedAt,
    pinOrderKey: "c",
  };
  const snoozedPin = {
    ...threadShell(scoped.id, 1005),
    latestConversationMessageAt: "2026-02-01T00:00:00Z",
    snoozedUntil: "2099-01-01T00:00:00Z",
    pinnedAt: firstPin.pinnedAt,
    pinOrderKey: "0",
  };
  const allThreads = [
    active,
    secondPin,
    firstPin,
    outsideScope,
    legacySettledPin,
    snoozedPin,
    ...history,
  ];
  vi.mocked(useProjects).mockReturnValue([scoped, other]);
  vi.mocked(useQuietThreadShells).mockReturnValue(allThreads);
  const routeThreadRef = { environmentId: scoped.environmentId, threadId: active.id };
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: { environmentId: scoped.environmentId, projectId: scoped.id },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef,
  });
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        scoped.environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  const sidebar = () => (
    <SidebarProvider>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
    </SidebarProvider>
  );
  await using screen = await render(sidebar());
  const rowKeys = () =>
    [...screen.container.querySelectorAll<HTMLElement>("[data-thread-item]")].map(
      (element) => element.dataset.threadItem,
    );
  const threadKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const row = (thread: EnvironmentThreadShell) =>
    screen.container.querySelector<HTMLElement>(`[data-sidebar-row="${threadKey(thread)}"]`)!;
  const pinOrder = [secondPin, legacySettledPin, firstPin].map(threadKey);
  expect(rowKeys().slice(0, 3)).toEqual(pinOrder);
  expect(row(firstPin).dataset.testid).toBe("sidebar-row-card");

  const recent = screen.getByRole("button", { name: "Recent", exact: true });
  await act(() => (recent.element() as HTMLButtonElement).click());
  expect(rowKeys().slice(0, 3)).toEqual(pinOrder);
  expect(row(firstPin).dataset.testid).toBe("sidebar-row-card");
  expect(row(firstPin).textContent).toContain(scoped.title);
  expect(row(firstPin).textContent).toContain("release/one");
  expect(row(firstPin).querySelector("time")?.dateTime).toBe(firstPin.latestConversationMessageAt);
  expect(
    row(firstPin).querySelector('[aria-label="Unpin thread"], [aria-label="Pinned"]'),
  ).not.toBeNull();
  expect(row(active).dataset.testid).toBe("sidebar-row-slim");
  expect(rowKeys()).toHaveLength(205);
  expect(rowKeys()).not.toContain(threadKey(outsideScope));
  expect(rowKeys().indexOf(threadKey(snoozedPin))).toBeGreaterThan(
    rowKeys().indexOf(threadKey(active)),
  );
  const more = screen.getByRole("button", { name: "Show 1 more", exact: true });
  await act(() => (more.element() as HTMLButtonElement).click());
  expect(rowKeys().slice(0, 3)).toEqual(pinOrder);
  expect(rowKeys()).toHaveLength(206);

  const firstPinWithNewMessage = {
    ...firstPin,
    latestConversationMessageAt: "2026-04-01T12:00:00Z",
  };
  const updatedPins = [firstPin, secondPin, legacySettledPin].map(threadKey);
  const updatedThreads = allThreads.map((thread) =>
    thread.id === firstPin.id
      ? firstPinWithNewMessage
      : { ...thread, updatedAt: "2026-04-04T00:00:00Z" },
  );
  vi.mocked(useQuietThreadShells).mockReturnValue(updatedThreads);
  await screen.rerender(sidebar());
  expect(rowKeys().slice(0, 3)).toEqual(updatedPins);
  const projects = screen.getByRole("button", { name: "Projects", exact: true });
  await act(() => (projects.element() as HTMLButtonElement).click());
  expect(rowKeys().slice(0, 3)).toEqual(updatedPins);
  await act(() => (recent.element() as HTMLButtonElement).click());

  vi.mocked(useQuietThreadShells).mockReturnValue(
    updatedThreads.map((thread) =>
      thread.id === legacySettledPin.id ? { ...thread, pinnedAt: null, pinOrderKey: null } : thread,
    ),
  );
  vi.mocked(useThreadRouteTarget).mockReturnValue({
    kind: "server",
    threadRef: { ...routeThreadRef, threadId: firstPin.id },
  });
  await screen.rerender(sidebar());
  expect(rowKeys().slice(0, 2)).toEqual(updatedPins.slice(0, 2));
  expect(rowKeys().at(-1)).toBe(threadKey(legacySettledPin));
  expect(row(legacySettledPin).dataset.testid).toBe("sidebar-row-slim");
  expect(row(firstPin).getAttribute("aria-current")).toBe("page");

  const monogram = (thread: EnvironmentThreadShell) =>
    row(thread).querySelector<SVGElement>('[data-slot="project-monogram"] svg')!;
  const wasDark = document.documentElement.classList.contains("dark");
  stack.defer(() => document.documentElement.classList.toggle("dark", wasDark));
  const colors: string[] = [];
  for (const dark of [false, true]) {
    document.documentElement.classList.toggle("dark", dark);
    const color = getComputedStyle(monogram(firstPin)).color;
    expect(getComputedStyle(monogram(legacySettledPin)).color).toBe(color);
    expect(getComputedStyle(monogram(history[0]!)).color).toBe(color);
    expect(
      row(firstPin).getBoundingClientRect().top - recent.element().getBoundingClientRect().bottom,
    ).toBeGreaterThanOrEqual(4);
    colors.push(color);
  }
  expect(colors[0]).not.toBe(colors[1]);
});

describe("sidebar project completeness", () => {
  it.each([68, 230])(
    "lists %i settled conversations inside the scoped project with history collapsed",
    async (settledCount) => {
      using stack = new DisposableStack();
      const style = document.createElement("style");
      style.textContent = appCss;
      document.head.append(style);
      stack.defer(() => style.remove());
      const previousSettings = getClientSettings();
      stack.defer(() => __setClientSettingsForTests(previousSettings));
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
      for (const [key, value] of [
        ["t3.sidebar.task-view.v1", "project"],
        ["t3code:sidebar:settled-expanded", false],
        ["t3code:sidebar:snoozed-expanded", false],
      ] as const) {
        const previous = localStorage.getItem(key);
        stack.defer(() =>
          previous === null ? localStorage.removeItem(key) : localStorage.setItem(key, previous),
        );
        localStorage.setItem(key, JSON.stringify(value));
      }
      const previousUi = useUiStateStore.getState();
      stack.defer(() => useUiStateStore.setState(previousUi));
      const scopedProject = project("scoped");
      const otherProject = project("other");
      const active = threadShell(scopedProject.id, 1000);
      const pinned = {
        ...threadShell(scopedProject.id, 1001),
        pinnedAt: "2026-01-01T00:00:00.000Z",
      };
      const snoozed = {
        ...threadShell(scopedProject.id, 1002),
        snoozedAt: "2026-01-01T00:00:00.000Z",
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      };
      const settled = Array.from({ length: settledCount }, (_, index) =>
        makeThreadFixture({
          environmentId: scopedProject.environmentId,
          projectId: scopedProject.id,
          id: ThreadId.make(`history-${String(index).padStart(3, "0")}`),
          title: `History ${index}`,
          settledOverride: "settled",
          settledAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const threads = [
        active,
        pinned,
        snoozed,
        ...settled,
        threadShell(otherProject.id, 2000),
        { ...threadShell(scopedProject.id, 2001), archivedAt: "2026-01-01T00:00:00.000Z" },
        { ...threadShell(scopedProject.id, 2002), deletedAt: "2026-01-01T00:00:00.000Z" },
        {
          ...threadShell(scopedProject.id, 2003),
          lineage: {
            rootThreadId: active.id,
            parentThreadId: active.id,
            relationshipToParent: "subagent" as const,
          },
        },
      ];
      useUiStateStore.setState({
        sidebarProjectScopeKeys: ["local:/projects/scoped"],
        projectExpandedById: {},
      });
      vi.mocked(useProjects).mockReturnValue([scopedProject, otherProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue(threads);
      const routeThreadRef = { environmentId: scopedProject.environmentId, threadId: active.id };
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: scopedProject.environmentId,
          projectId: scopedProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      vi.mocked(useServerConfigs).mockReturnValue(
        new Map([
          [
            scopedProject.environmentId,
            {
              scratchWorkspaceRoot: null,
              shellThreadFamilies: false,
            } as unknown as EnvironmentServerConfig,
          ],
        ]),
      );
      await using screen = await render(
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>,
      );
      const rows = () => [...screen.container.querySelectorAll<HTMLElement>("[data-thread-item]")];
      const folderRows = () =>
        rows().filter((row) =>
          row
            .querySelector("[data-sidebar-parent]")
            ?.getAttribute("data-sidebar-parent")
            ?.startsWith("folder:"),
        );
      const initialCount = Math.min(settledCount, 200);
      expect(rows()).toHaveLength(initialCount + 3);
      expect(folderRows()).toHaveLength(initialCount + 2);
      const expectedKeys = [active, pinned, snoozed, ...settled.slice(0, initialCount)].map(
        (thread) => `${thread.environmentId}:${thread.id}`,
      );
      expect(new Set(rows().map((row) => row.dataset.threadItem))).toEqual(new Set(expectedKeys));
      expect(
        screen.container.querySelectorAll('[data-testid="sidebar-project-folder"]'),
      ).toHaveLength(1);
      expect(screen.container.querySelector('[data-sidebar-row="shelf:settled"]')).toBeNull();
      expect(screen.container.querySelector('[data-sidebar-row="shelf:snoozed"]')).toBeNull();
      const folder = screen.container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-project-folder"] button',
      )!;
      await act(() => folder.click());
      // Only the route row remains in a closed folder; pinned stays outside it.
      expect(rows()).toHaveLength(2);
      expect(folderRows()).toHaveLength(1);
      await act(() => folder.click());
      expect(rows()).toHaveLength(initialCount + 3);
      if (settledCount > 200) {
        const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
        expect(more.element().getAttribute("data-sidebar-parent")).toBeNull();
        await act(() => (more.element() as HTMLButtonElement).click());
        expect(rows()).toHaveLength(228);
        await userEvent.click(screen.getByRole("button", { name: "Show 5 more", exact: true }));
        await expect.element(screen.getByText("History 229", { exact: true })).toBeInTheDocument();
        expect(rows()).toHaveLength(settledCount + 3);
      }
      expect(vi.mocked(shelfHooks.useOlderSettledShelf).mock.calls.at(-1)?.[0]).toMatchObject({
        expanded: true,
        visibleCount: settledCount > 200 ? 250 : 200,
      });
      expect(useUiStateStore.getState().sidebarProjectScopeKeys).toEqual([
        "local:/projects/scoped",
      ]);
      expect(localStorage.getItem("t3code:sidebar:settled-expanded")).toBe("false");
    },
  );
});
