import type { NavigationState } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Linking from "expo-linking";
import { AppState, Dimensions, Platform } from "react-native";

import { environmentCatalog } from "../../../connection/catalog";
import { deriveLayout } from "../../../lib/layout";
import {
  NATIVE_METRICS_TIMEOUT_MS,
  nativeWorkspaceColumnsSupportedFor,
} from "../../../native/NativeWorkspaceColumns";
import {
  currentNativeLayoutMetrics,
  firstNativeLayoutMetrics,
} from "../../../native/native-layout-metrics";
import { loadPreferences, savePreferencesPatch } from "../../../persistence/imperative";
import { rootStackState, type RootStackNavigation } from "../../../lib/root-stack-reset";
import { workspaceRoutesOf } from "../workspace-overlay-routes";
import type { WorkspaceSelections } from "../../../persistence/mobile-preferences";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import {
  environmentThreadShells,
  startOpeningEnvironmentThread,
  threadEnvironment,
} from "../../../state/threads";
import {
  rememberedSettingsPage,
  workspaceSelectionsIn,
  type WorkspaceSelectionCheck,
} from "./workspace-tab-navigation";

const REMEMBERS = Platform.OS === "ios" || Platform.OS === "android";

// Read synchronously when a tab opens, so it lives in memory and is saved when the app leaves
// the foreground rather than on every chat switch.
const initialSelections: WorkspaceSelections = {};
let selections = initialSelections;
let saved = selections;
let hydration: Promise<void> | null = null;

function save() {
  const writing = selections;
  if (saved === writing) return;
  // Marked saved only once written, so a failed write is retried on the next background.
  void savePreferencesPatch({ workspaceSelections: writing })
    .then(() => {
      saved = writing;
    })
    .catch(() => undefined);
}

// Route keys only name routes of the session that wrote them; a saved one would make a tab rebuild
// its page under a stale key, which UIKit animates as a pop and a push.
function withoutRouteKeys(saved: WorkspaceSelections | undefined): WorkspaceSelections {
  const omitKey = <Selection extends { readonly key?: string }>({ key: _, ...rest }: Selection) =>
    rest;
  const { threads, pullRequests, settingsKey: _, threadsDraft: _draft, ...rest } = saved ?? {};
  return {
    ...rest,
    ...(threads ? { threads: omitKey(threads) } : {}),
    ...(pullRequests ? { pullRequests: omitKey(pullRequests) } : {}),
  };
}

/** Loads the saved selections once; pages visited before it resolves win over saved ones. */
export function hydrateWorkspaceSelections() {
  if (!REMEMBERS) return Promise.resolve();
  hydration ??= loadPreferences()
    .then((preferences) => {
      saved = withoutRouteKeys(preferences.workspaceSelections);
      if (Platform.OS !== "android" || selections === initialSelections) {
        selections = { ...saved, ...selections };
        saved = selections;
      }
      AppState.addEventListener("change", (status) => {
        if (status !== "active") save();
      });
    })
    .catch(() => undefined);
  return hydration;
}

export function currentWorkspaceSelections() {
  return selections;
}

/**
 * The navigation container's `onReady` and `onStateChange`: remembers the page each tab is
 * showing. The initial state, such as a cold start's reopened chat, reaches only `onReady`.
 */
export function recordWorkspaceSelections(state: NavigationState | undefined) {
  if (!REMEMBERS || !state) return;
  const routes = state.routes.slice(0, state.index + 1);
  if (Platform.OS === "android") {
    const { workspace } = workspaceRoutesOf(routes);
    const active = workspace.at(-1);
    const thread =
      active?.name === "Thread" ? workspaceSelectionsIn([active], {}).threads : undefined;
    if (
      selections.threads?.environmentId !== thread?.environmentId ||
      selections.threads?.threadId !== thread?.threadId
    ) {
      selections = thread ? { threads: thread } : {};
      save();
    }
    return;
  }
  selections = workspaceSelectionsIn(routes, selections);
}

function environmentRemoved(environmentId: string) {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  return (
    catalog.isReady &&
    !appAtomRegistry
      .get(environmentPresentations.presentationsAtom)
      .has(environmentId as EnvironmentId)
  );
}

/**
 * A remembered chat is gone once its environment was removed, or once that environment's
 * snapshot has loaded without it. Before it loads there is nothing to contradict it.
 */
export const workspaceSelectionCheck: WorkspaceSelectionCheck = {
  thread: (selection) => {
    if (environmentRemoved(selection.environmentId)) return false;
    const environmentId = selection.environmentId as EnvironmentId;
    if (!appAtomRegistry.get(threadEnvironment.snapshotAtom(environmentId))) return true;
    return appAtomRegistry
      .get(environmentThreadShells.environmentThreadIndexAtom(environmentId))
      .has(selection.threadId as ThreadId);
  },
  pullRequest: (selection) => !environmentRemoved(selection.environmentId),
};

/** Whether the window lays the workspace out in columns, by the rule the layout itself uses. */
export function workspaceHasColumns() {
  const metrics = currentNativeLayoutMetrics();
  const { width, height } = metrics ?? Dimensions.get("window");
  return deriveLayout({
    width,
    height,
    nativeMetrics: metrics,
    nativeWorkspace: nativeWorkspaceColumnsSupportedFor(metrics),
  }).usesSplitView;
}

/** The Settings page a bare `settings` link opens beside the list when there are columns. */
export function settingsLinkPage() {
  return Platform.OS === "ios" && workspaceHasColumns()
    ? rememberedSettingsPage(selections)
    : undefined;
}

/**
 * Android 恢复退出时打开的会话。iOS 仅在分栏中恢复最近的会话。
 */
export async function launchWorkspaceURL(): Promise<string | null> {
  if (!REMEMBERS) return null;
  const metrics =
    Platform.OS === "ios" ? firstNativeLayoutMetrics(NATIVE_METRICS_TIMEOUT_MS) : null;
  await hydrateWorkspaceSelections();
  const thread = selections.threads;
  // Read the chat's cached copy while the layout metrics are still on their way.
  if (thread) {
    startOpeningEnvironmentThread(
      thread.environmentId as EnvironmentId,
      thread.threadId as ThreadId,
    );
  }
  await metrics;
  if (!thread || environmentRemoved(thread.environmentId)) return null;
  if (Platform.OS === "ios" && !workspaceHasColumns()) return null;
  return Linking.createURL(
    `threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.threadId)}`,
  );
}

/** Whether the workspace shows its first detail page, directly above its list. */
export function firstWorkspaceDetailOpen(navigation: RootStackNavigation) {
  const state = rootStackState(navigation);
  if (!state) return false;
  const { workspace, overlays } = workspaceRoutesOf(state.routes.slice(0, state.index + 1));
  const list = (name: string | undefined) => name === "Home" || name === "Settings";
  return overlays.length === 0 && !list(workspace.at(-1)?.name) && list(workspace.at(-2)?.name);
}
