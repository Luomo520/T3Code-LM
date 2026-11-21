import {
  getPromptControlledTraits,
  getTraitSelectChange,
  isReasoningControl,
} from "@t3tools/client-runtime/model-traits";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useModelPopupColors, ReasoningSlider } from "./ReasoningSlider";
import { reasoningLevelLabel } from "./reasoning-slider-state";
import { PopupChoice, PopupChoicesDialog, type PopupFrame } from "./ThreadSettingsPopupChoices";
import * as Dialog from "../../components/ui/Dialog";
import { DockGlassBackdrop } from "../../components/ui/DockGlass";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { useSheetStackOptions } from "../layout/nested-stacks";
import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  findReasoningOptionDescriptor,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import {
  useIsFocused,
  useNavigation,
  useRoute,
  type RouteProp,
  type StaticScreenProps,
} from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
  type TextInputInstance,
  type ViewInstance,
} from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { SearchField } from "../../components/ui/SearchField";
import { READABLE_WIDTH_STYLE, ROW_MIN_HEIGHT } from "../../components/ui/listMetrics";
import { RefreshControl } from "../../components/ui/RefreshControl";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { AppBar } from "../../components/ui/AppBar";
import { ProviderIcon } from "../../components/ProviderIcon";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useAppActive, useReduceMotionEnabled } from "../../lib/appState";
import {
  buildModelOptions,
  groupByProvider,
  serverConfigForCwd,
  type ModelOption,
  type ProviderGroup,
} from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  preserveInheritedReasoningEffort,
  providerOptionsForDisplay,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentQuery } from "../../state/query";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useProject, useThreadReportedModelSelection } from "../../state/entities";
import {
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
  useComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { useQuietThreadStructure } from "../../state/use-thread-detail";
import { activeComposerDraftKey, useQueuedRunEdit } from "../../state/queued-run-edit";
import { selectThreadModel } from "../../state/thread-model-selection";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { providerWorkspaceSnapshotRefresh } from "../../state/provider-workspace-snapshot-refresh";
import { threadAllowsProviderSwitch } from "../../state/thread-provider-switching";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { ScreenContent } from "../../components/ui/ScreenContent";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import { useSearchToolbarInset } from "../../components/ui/useBarInset";
import type { AppBarSearch } from "../../components/ui/AppBar";
import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
  withManagedRuntimeModeLimits,
  type RuntimeModeChoice,
  selectableChoices,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  favoritesFirst,
  modelFavoriteKey,
  modelMatchesCatalogQuery,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";

const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);
/** Keep measured size changes stable; let catalog mutations return underflowing filtered lists to the top. */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
const FAVORITES_PROVIDER_FILTER = "@favorites";
// Servers that predate `migrateModelPreferences` drop it and keep reporting null favorites.
const attemptedMigrationGenerations = new Map<EnvironmentId, number>();
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={15} />
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60"
        style={{ minHeight: ROW_MIN_HEIGHT.control }}
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      style={{ minHeight: ROW_MIN_HEIGHT.item }}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" };

type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly restoreSelection?: (selection: ModelSelection) => ModelSelection;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
};

/** The composer draft the sheet edits: the thread's own, or a queued message being edited. */
export type ExistingThreadSettingsRouteParams = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftKey: string;
};

type ThreadSettingsSessionValue = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (option: ModelOption) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeChoices: ReadonlyArray<RuntimeModeChoice>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly promptTraits: ReturnType<typeof getPromptControlledTraits>;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly pressModel: (option: ModelOption, applyImmediately?: boolean) => void;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
  /** The provider whose catalog for this folder the picker keeps fresh. */
  readonly workspaceScan: { readonly instanceId: ProviderInstanceId; readonly cwd: string } | null;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const project = useProject(
    props.environmentId && props.projectId
      ? scopeProjectRef(props.environmentId, props.projectId)
      : null,
  );
  const connection = useEnvironmentQuery(
    props.environmentId ? environmentCatalog.stateAtom(props.environmentId) : null,
  ).data;
  const connectionGeneration = connection?.phase === "connected" ? connection.generation : null;
  const [manageHidden, setManageHidden] = useState(false);
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const providerGroups =
    manageHidden && config
      ? groupByProvider(
          buildModelOptions(
            serverConfigForCwd(config, props.cwd),
            props.selectedModel,
            props.lockedProviderInstanceId,
            props.projectId,
            true,
          ),
        )
      : props.providerGroups;
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, {
    favorites: legacyFavorites,
  }).favorites;
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- writes the one-time legacy model favorites migration to server settings once per connection
  useEffect(() => {
    if (
      !props.environmentId ||
      !settings ||
      !AsyncResult.isSuccess(preferences) ||
      connectionGeneration === null ||
      attemptedMigrationGenerations.get(props.environmentId) === connectionGeneration
    )
      return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (!patch) return;
    attemptedMigrationGenerations.set(props.environmentId, connectionGeneration);
    void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [
    connectionGeneration,
    legacyFavorites,
    preferences,
    props.environmentId,
    saveSettings,
    settings,
  ]);
  const favoriteKeys = new Set(
    modelFavorites.map((favorite) => modelFavoriteKey(favorite.provider, favorite.model)),
  );
  const toggleFavorite = async (option: ModelOption) => {
    const environmentId = props.environmentId;
    if (!favoritesLoaded || !environmentId) return;
    const currentSettings = registry.get(environmentServerConfigsAtom).get(environmentId)?.settings;
    if (!currentSettings) return;
    const favorites = resolveModelPreferences(currentSettings, {
      favorites: legacyFavorites,
    }).favorites;
    const key = JSON.stringify([
      environmentId,
      option.selection.instanceId,
      option.selection.model,
    ]);
    const previous = pendingFavorites.current.get(key);
    const previousFavorite =
      previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
        ? previous.favorite
        : favorites.some(
            (favorite) =>
              favorite.provider === option.selection.instanceId &&
              favorite.model === option.selection.model,
          );
    const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
    pendingFavorites.current.set(key, pending);
    void Haptics.selectionAsync();
    const result = await saveSettings({
      environmentId: environmentId,
      input: {
        patch: {
          setModelFavorites: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              favorite: pending.favorite,
            },
          ],
          ...(currentSettings.favorites === null ? { migrateModelPreferences: { favorites } } : {}),
        },
      },
    });
    if (
      AsyncResult.isSuccess(result) &&
      registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
        currentSettings.favorites
    ) {
      pending.pending = false;
    }
    if (pending.pending && pendingFavorites.current.get(key) === pending) {
      if (
        previous &&
        !previous.pending &&
        registry.get(environmentServerConfigsAtom).get(environmentId)?.settings.favorites ===
          previous.settings.favorites
      ) {
        pendingFavorites.current.set(key, previous);
      } else {
        pendingFavorites.current.delete(key);
      }
    }
  };
  const toggleHidden = (option: ModelOption) => {
    if (
      !settings ||
      !props.environmentId ||
      !option.canHide ||
      pendingHidden.current.has(option.key)
    )
      return;
    pendingHidden.current.add(option.key);
    setPendingHiddenKeys(new Set(pendingHidden.current));
    void Haptics.selectionAsync();
    void saveSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          setModelsHidden: [
            {
              provider: option.selection.instanceId,
              model: option.selection.model,
              hidden: !option.isHidden,
            },
          ],
        },
      },
    }).then(() => {
      pendingHidden.current.delete(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
    });
  };
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string | null>(() =>
    Platform.OS === "android" ? FAVORITES_PROVIDER_FILTER : null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<string | null>(null);
  const displayedPrompt = pendingModel ? (pendingPrompt ?? props.prompt) : props.prompt;

  const isApplied = (option: ModelOption) =>
    option.selection.instanceId === props.selectedModel?.instanceId &&
    option.selection.model === props.selectedModel.model;
  const isDisplayed = (option: ModelOption) =>
    pendingModel ? option.key === pendingModel.key : isApplied(option);

  const displayedDescriptors = pendingModel
    ? resolveProviderOptionDescriptors({
        capabilities: pendingModel.capabilities,
        selections: pendingModel.selection.options,
      })
    : props.optionDescriptors;
  const displayedModelSelection = pendingModel?.selection ?? props.selectedModel;
  const providerOptionsDisplay = providerOptionsForDisplay({
    descriptors: displayedDescriptors,
    selection: displayedModelSelection,
    settings,
    projectId: props.projectId,
    project,
  });
  const promptTraits = getPromptControlledTraits(displayedDescriptors, displayedPrompt);
  const displayedModel =
    pendingModel ??
    props.providerGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
    null;
  const runtimeModeChoices = withManagedRuntimeModeLimits(
    runtimeModeChoicesForSupportedModes(displayedModel?.supportedRuntimeModes),
    [config?.managedPolicy],
  );
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    props.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = props.providerGroups.some((group) =>
    group.models.some((model) => model.isLegacy),
  );
  const commitModel = (model: ModelOption) => {
    if (!canCommitPendingModel(model, props.providerGroups)) {
      Dialog.alert(
        "Model unavailable",
        "Set up this provider on web or desktop, or select another model.",
      );
      return false;
    }
    void Haptics.selectionAsync();
    props.onSelectModel(model);
    return true;
  };

  const commitPendingModel = () => {
    if (!pendingModel) return true;
    if (!commitModel(pendingModel)) return false;
    if (pendingPrompt !== null && pendingPrompt !== props.prompt) {
      props.onPromptChange(pendingPrompt);
    }
    return true;
  };

  const applyOptionChange = (id: string, value: string | boolean) => {
    const descriptor = displayedDescriptors.find((entry) => entry.id === id);
    const change =
      descriptor?.type === "select" && typeof value === "string"
        ? getTraitSelectChange(
            { ...promptTraits, descriptors: displayedDescriptors },
            descriptor,
            displayedPrompt,
            value,
          )
        : null;
    if (descriptor?.type === "select") {
      if (!change) return;
      if (change.prompt !== displayedPrompt) {
        if (pendingModel) {
          setPendingPrompt(change.prompt);
        } else {
          props.onPromptChange(change.prompt);
        }
      }
    }
    const nextOptions = change
      ? (change.modelOptions ?? [])
      : applyProviderOptionSelection(displayedDescriptors, { id, value });
    if (!nextOptions) {
      return;
    }
    const next = preserveInheritedReasoningEffort(
      nextOptions,
      displayedDescriptors,
      displayedModelSelection?.options,
      id,
    );
    if (pendingModel) {
      rememberModelOptions(pendingModel.selection.instanceId, pendingModel.selection.model, next);
      setPendingModel({
        ...pendingModel,
        selection: { ...pendingModel.selection, options: next },
      });
    } else {
      props.onUpdateOptionSelections(next);
    }
  };

  const toggleProvider = (providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  };

  const pressModel = (option: ModelOption, applyImmediately?: boolean) => {
    if (applyImmediately) {
      const next = pendingModelAfterPress({
        current: null,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      });
      if (next) commitModel(next);
      return;
    }
    void Haptics.selectionAsync();
    if (isApplied(option) || option.key !== pendingModel?.key) {
      setPendingPrompt(null);
    }
    setPendingModel((current) =>
      pendingModelAfterPress({
        current,
        pressed: option,
        pressedIsApplied: isApplied(option),
        restoreSelection: props.restoreSelection,
      }),
    );
  };

  const environmentId = props.environmentId;
  // Like the web picker's open tab: scanning every provider would spawn a probe per provider.
  const scannedInstanceId =
    providerFilter !== null && providerFilter !== FAVORITES_PROVIDER_FILTER
      ? ProviderInstanceId.make(providerFilter)
      : props.providerInstanceId;
  const workspaceScan =
    props.cwd && scannedInstanceId ? { instanceId: scannedInstanceId, cwd: props.cwd } : null;

  const value = {
    environmentId,
    providerInstanceId: props.providerInstanceId,
    providerGroups,
    manageHidden,
    setManageHidden,
    toggleHidden,
    pendingHiddenKeys,
    runtimeMode: compatibleRuntimeMode,
    runtimeModeChoices,
    onUpdateRuntimeMode: props.onUpdateRuntimeMode,
    displayedDescriptors: providerOptionsDisplay.descriptors,
    promptTraits,
    displayedModelSelection: providerOptionsDisplay.selection,
    reportedModelSelection: pendingModel ? null : (props.reportedModelSelection ?? null),
    favoriteKeys,
    favoritesLoaded,
    providerExpansionOverrides,
    hasLegacyModels,
    pendingModel,
    providerFilter,
    searchQuery,
    showLegacy: showLegacyToggle,
    applyOptionChange,
    commitPendingModel,
    isApplied,
    isDisplayed,
    pressModel,
    setProviderFilter,
    setSearchQuery,
    setShowLegacy: setShowLegacyToggle,
    toggleProvider,
    toggleFavorite,
    workspaceScan,
  } satisfies ThreadSettingsSessionValue;

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {environmentId && workspaceScan ? (
        <ProviderWorkspaceSnapshotScan
          key={workspaceScan.instanceId}
          environmentId={environmentId}
          instanceId={workspaceScan.instanceId}
          cwd={workspaceScan.cwd}
        />
      ) : null}
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

/** A project's own provider config can add models only its workspace scan lists. */
function ProviderWorkspaceSnapshotScan(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}) {
  useAtomMount(providerWorkspaceSnapshotRefresh(props));
  return null;
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    };

function ThreadSettingsModelListRow(props: {
  readonly compact?: boolean;
  readonly option: ModelOption;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const colors = useModelPopupColors();
  const session = useThreadSettingsSession();
  const onPress = () => session.pressModel(props.option, props.compact);
  if (props.compact) {
    const option = props.option;
    const selected = session.isDisplayed(option);
    const unavailable = option.isUnavailable === true || option.isHidden === true;
    const favorite = session.favoriteKeys.has(option.key);
    return (
      <View
        className="mx-2 min-h-12 flex-row items-center rounded-lg pl-2"
        style={{ backgroundColor: selected ? colors.selected : "transparent" }}
      >
        <Pressable
          accessibilityRole="radio"
          accessibilityLabel={[
            option.label,
            option.subtitle,
            option.isDefault ? "默认" : null,
            unavailable ? "不可用" : null,
          ]
            .filter(Boolean)
            .join("，")}
          accessibilityState={{ checked: selected, disabled: unavailable }}
          disabled={unavailable}
          onPress={onPress}
          className={cn(
            "min-h-12 min-w-0 flex-1 flex-row items-center gap-2 active:opacity-60",
            unavailable && "opacity-50",
          )}
        >
          <ProviderIcon
            appearance={colors.appearance}
            iconUrl={option.providerIconUrl}
            provider={option.providerDriver}
            size={18}
          />
          <Text className="min-w-0 flex-1 text-sm" style={{ color: colors.text }} numberOfLines={1}>
            {option.label}
          </Text>
          {option.isDefault ? (
            <Text style={{ fontSize: 11, color: colors.muted }}>默认</Text>
          ) : null}
          {option.isHidden ? (
            <Text style={{ fontSize: 11, color: colors.muted }}>已隐藏</Text>
          ) : option.isUnavailable ? (
            <Text style={{ fontSize: 11, color: colors.muted }}>不可用</Text>
          ) : null}
        </Pressable>
        {session.manageHidden && option.canHide ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${option.isHidden ? "显示" : "隐藏"}模型：${option.label}`}
            accessibilityState={{ disabled: session.pendingHiddenKeys.has(option.key) }}
            disabled={session.pendingHiddenKeys.has(option.key)}
            onPress={() => session.toggleHidden(option)}
            className="min-h-12 w-12 items-center justify-center active:opacity-60"
          >
            <SymbolView
              name={option.isHidden ? "eye.slash" : "eye"}
              size={16}
              tintColor={colors.muted}
            />
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${favorite ? "取消收藏" : "收藏"}：${option.label}`}
          accessibilityState={{ disabled: !session.favoritesLoaded, selected: favorite }}
          disabled={!session.favoritesLoaded}
          onPress={() => session.toggleFavorite(option)}
          className="min-h-12 w-12 items-center justify-center active:opacity-60"
        >
          <SymbolView
            name={favorite ? "star.fill" : "star"}
            size={16}
            tintColor={favorite ? colors.favorite : colors.muted}
          />
        </Pressable>
        <View pointerEvents="none" className="w-6 items-center">
          {selected ? <SymbolView name="checkmark" size={15} tintColor={colors.text} /> : null}
        </View>
      </View>
    );
  }

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      isFavorite={session.favoriteKeys.has(props.option.key)}
      favoritesLoaded={session.favoritesLoaded}
      onToggleFavorite={() => session.toggleFavorite(props.option)}
      onToggleHidden={
        session.manageHidden && props.option.canHide
          ? () => session.toggleHidden(props.option)
          : undefined
      }
      hiddenUpdatePending={session.pendingHiddenKeys.has(props.option.key)}
      option={props.option}
      selected={session.isDisplayed(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = () => session.toggleProvider(props.provider.key);

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      iconUrl={props.provider.iconUrl}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function buildThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  return session.providerGroups.flatMap((group) => {
    if (
      session.providerFilter !== null &&
      session.providerFilter !== FAVORITES_PROVIDER_FILTER &&
      group.providerKey !== session.providerFilter
    ) {
      return [];
    }
    const driver = group.models[0]?.providerDriver ?? group.providerKey;
    const catalogModels =
      session.manageHidden ||
      session.showLegacy ||
      session.providerFilter === FAVORITES_PROVIDER_FILTER
        ? group.models
        : group.models.filter(
            (model) =>
              !model.isLegacy || session.isDisplayed(model) || session.favoriteKeys.has(model.key),
          );
    const visibleModels = favoritesFirst(
      catalogModels.filter(
        (model) =>
          (session.providerFilter !== FAVORITES_PROVIDER_FILTER ||
            session.favoriteKeys.has(model.key)) &&
          modelMatchesCatalogQuery({
            model,
            providerLabel: group.providerLabel,
            query: session.searchQuery,
          }),
      ),
      session.favoriteKeys,
    );
    const updateRequiredNotice =
      group.updateRequired && session.providerFilter !== FAVORITES_PROVIDER_FILTER
        ? formatProviderUpdateRequiredNotice(group.updateRequired, session.searchQuery)
        : null;
    if (visibleModels.length === 0 && !updateRequiredNotice) {
      return [];
    }
    const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
    const containsAppliedSelection = group.models.some(session.isApplied);
    const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
    const collapsible = !isNarrowed;
    const collapsed = providerSectionIsCollapsed({
      defaultExpanded: isPrimary || containsAppliedSelection,
      hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
      isNarrowed,
    });
    const provider: ThreadSettingsProviderCatalog = {
      key: group.providerKey,
      driver,
      iconUrl: group.models[0]?.providerIconUrl,
      label: group.providerLabel,
      collapsible,
      collapsed,
      modelCount: visibleModels.length,
      models: collapsed ? [] : visibleModels,
    };
    return [
      {
        kind: "provider" as const,
        key: `provider:${group.providerKey}`,
        provider,
      },
      ...provider.models.map((option, index) => ({
        kind: "model" as const,
        key: `model:${option.key}`,
        option,
        isFirst: index === 0,
        isLast: index === provider.models.length - 1,
      })),
      ...(!collapsed && updateRequiredNotice
        ? [
            {
              kind: "notice" as const,
              key: `notice:${group.providerKey}`,
              text: updateRequiredNotice,
            },
          ]
        : []),
    ];
  });
}

function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly bottomInset: number;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;

  return (
    <View style={{ paddingBottom: insets.bottom + props.bottomInset + 12 }}>
      <ChatGptSharingStatus provider={selectedProvider} />
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">{"选项"}</Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={descriptor.label}
                  value={
                    session.promptTraits.ultrathinkPromptControlled &&
                    descriptor.id === session.promptTraits.primarySelectDescriptor?.id
                      ? "Ultrathink"
                      : getProviderOptionCurrentLabel(
                          descriptor,
                          session.displayedModelSelection,
                          session.reportedModelSelection,
                        )
                  }
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast
            label="运行时"
            value={
              session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)
                ?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
      </Animated.View>

      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        {"模型目录"}
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card">
        <SwitchRow
          label="管理隐藏的模型"
          value={session.manageHidden}
          onValueChange={session.setManageHidden}
          isLast
        />
      </View>
    </View>
  );
}

function ThreadSettingsMainContent(props: {
  readonly compact?: boolean;
  readonly bottomInset: number;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const colors = useModelPopupColors();
  const session = useThreadSettingsSession();
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = createProviderCatalogRefreshRunner(refreshProvidersCommand);
  const registry = use(RegistryContext);
  const refreshModelCatalog = useEffectEvent(() => {
    const environmentId = session.environmentId;
    if (!environmentId) return;
    // An older server drops the field and probes every provider.
    const config = registry.get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.modelCatalogRefresh !== true) return;
    void refreshProvidersCommand({ environmentId, input: { modelCatalogOnly: true } });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for newly released models when the model list opens
  useEffect(() => {
    refreshModelCatalog();
  }, []);
  const [isRefreshingProviders, setIsRefreshingProviders] = useState(false);
  const refreshProviders = () => {
    if (!session.environmentId || isRefreshingProviders) return;
    setIsRefreshingProviders(true);
    const environmentId = session.environmentId;
    const workspaceScan = session.workspaceScan;
    void refreshProviderCatalog(environmentId)
      .then(async (result) => {
        // A project's own models are read per folder, so the machine refresh alone keeps them stale.
        // A failed folder read keeps its previous models and retries, so only the machine result alerts.
        if (result._tag === "Success" && workspaceScan) {
          await refreshProvidersCommand({
            environmentId,
            input: { ...workspaceScan, fresh: true },
          });
        }
        return result;
      })
      .then((result) => {
        setIsRefreshingProviders(false);
        const error = providerCatalogRefreshError(result);
        if (error) Dialog.alert("Could not refresh models", error);
      });
  };
  const [listLoaded, setListLoaded] = useState(false);
  // Android can drop the first frame of a reduced-motion fade, leaving rows invisible.
  const reducedMotion = useReducedMotion();
  const reduceMotionEnabled = useReduceMotionEnabled();
  const animationsReady = listLoaded && !reducedMotion && !reduceMotionEnabled;
  const catalogItems = buildThreadSettingsCatalogItems(session).filter(
    (item) => !props.compact || item.kind !== "provider",
  );
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const listItems = [
    ...(catalogItems.length === 0 ? ([{ kind: "empty", key: "empty" }] as const) : catalogItems),
    ...(props.compact ? [] : [{ kind: "options", key: "options" } as const]),
  ] satisfies ReadonlyArray<ThreadSettingsCatalogItem>;
  const renderCatalogItem = (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
    const item = itemProps.item;
    let content: ReactNode;

    if (item.kind === "provider") {
      content = <ThreadSettingsProviderListHeader provider={item.provider} />;
    } else if (item.kind === "model") {
      content = (
        <ThreadSettingsModelListRow
          compact={props.compact}
          isFirst={item.isFirst}
          isLast={item.isLast}
          option={item.option}
        />
      );
    } else if (item.kind === "notice") {
      content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
    } else if (item.kind === "empty") {
      content = (
        <View className={props.compact ? "items-center px-4 py-4" : "items-center px-8 py-14"}>
          <Text
            className="text-center text-sm text-foreground-muted"
            style={props.compact ? { color: colors.muted } : undefined}
          >
            {session.providerFilter === FAVORITES_PROVIDER_FILTER &&
            session.searchQuery.trim().length === 0
              ? "暂无收藏模型，请切换到全部添加收藏"
              : hasActiveCatalogFilter
                ? "没有匹配的模型"
                : "暂无可用模型"}
          </Text>
        </View>
      );
    } else {
      content = (
        <ThreadSettingsOptionsItem
          animationsReady={animationsReady}
          bottomInset={props.bottomInset}
          onOpenSubmenu={props.onOpenSubmenu}
        />
      );
    }

    return (
      <Animated.View
        key={item.key}
        entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
        exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
      >
        {content}
      </Animated.View>
    );
  };

  return (
    // oxlint-disable-next-line t3code/require-registered-list-scroll -- Sheet content; sheets sit outside workspace columns and keep their own header handling.
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className={props.compact ? "flex-1" : "flex-1 bg-sheet"}
      style={[READABLE_WIDTH_STYLE, props.compact ? { backgroundColor: colors.panel } : undefined]}
      contentContainerStyle={{ paddingTop: 4, paddingBottom: props.compact ? 8 : 0 }}
      contentInsetAdjustmentBehavior={props.compact ? "never" : "automatic"}
      data={listItems}
      estimatedItemSize={props.compact ? 48 : ROW_MIN_HEIGHT.item}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl refreshing={isRefreshingProviders} onRefresh={refreshProviders} />
        ) : undefined
      }
      onLoad={() => setListLoaded(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.disabledReason ?? choice.description,
            disabled: choice.disabledReason !== undefined,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              disabled: false,
              selected:
                choice.id ===
                (session.promptTraits.ultrathinkPromptControlled &&
                activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                  ? "ultrathink"
                  : getProviderOptionCurrentValue(
                      activeDescriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )),
              onPress: () => {
                void Haptics.selectionAsync();
                if (
                  session.promptTraits.ultrathinkInBodyText &&
                  activeDescriptor.id === session.promptTraits.primarySelectDescriptor?.id
                ) {
                  Dialog.alert(
                    "Reasoning controlled by prompt",
                    'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
                  );
                  return;
                }
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={READABLE_WIDTH_STYLE}
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            disabled={row.disabled}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const commitAndClose = useEffectEvent(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  });
  const search: AppBarSearch = {
    value: session.searchQuery,
    onChangeText: session.setSearchQuery,
    placeholder: "查找模型",
    clearAccessibilityLabel: "Clear model search",
    mode: "inline",
    compactToolbar: true,
  };
  const searchToolbarInset = useSearchToolbarInset(search);
  const providerFilters = [
    { id: "all-providers", title: "所有服务提供方", value: null },
    { id: "favorites", title: "收藏", value: FAVORITES_PROVIDER_FILTER },
    ...session.providerGroups.map((group) => ({
      id: `provider:${group.providerKey}`,
      title: group.providerLabel,
      value: group.providerKey,
    })),
  ];

  return (
    <>
      <AppBar
        title="任务设置"
        onClose={presentation.onClose}
        closeAccessibilityLabel="Cancel thread settings"
        search={search}
        menus={[
          {
            title: "模型筛选",
            icon: hasCustomCatalogFilter
              ? "line.3.horizontal.decrease.circle.fill"
              : "line.3.horizontal.decrease",
            items: [
              {
                id: "provider",
                title: "服务提供方",
                items: providerFilters.map((filter) => ({
                  id: filter.id,
                  title: filter.title,
                  selected: session.providerFilter === filter.value,
                  onPress: () => session.setProviderFilter(filter.value),
                })),
              },
              ...(session.hasLegacyModels
                ? [
                    {
                      id: "show-legacy",
                      title: "显示旧模型",
                      selected: session.showLegacy,
                      onPress: () => session.setShowLegacy(!session.showLegacy),
                    },
                  ]
                : []),
            ],
          },
        ]}
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
          session.hasLegacyModels,
        ]}
        confirm={{
          label: session.pendingModel ? "保存" : "完成",
          onPress: commitAndClose,
        }}
        hideBottomBorder
      />
      <ScreenContent>
        <ThreadSettingsMainContent
          bottomInset={searchToolbarInset}
          onOpenSubmenu={(submenu) => {
            const title =
              submenu.kind === "runtime"
                ? "Runtime"
                : (session.displayedDescriptors.find(
                    (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                  )?.label ?? "Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </ScreenContent>
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <AppBar title={route.params.title} onBack={() => navigation.goBack()} hideBottomBorder />
      <ScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </ScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const screenOptions = useSheetStackOptions();
  const presentation = {
    onClose: props.onClose,
  };

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={screenOptions}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "任务设置" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

const POPUP_OPTION_LABELS: Readonly<Record<string, string>> = {
  Reasoning: "思考强度",
  "Reasoning effort": "思考强度",
  Effort: "思考强度",
  "Service tier": "响应模式",
  Speed: "响应模式",
  "Fast mode": "快速模式",
  "Fast Mode": "快速模式",
  Standard: "标准",
  Fast: "快速",
  Priority: "优先",
  Default: "默认",
  Auto: "自动",
  Enabled: "开启",
  Disabled: "关闭",
};
const popupLabel = (label: string) => POPUP_OPTION_LABELS[label] ?? label;

function PopupSpeedSegments(props: {
  readonly choices: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly current: string | null;
  readonly onChange: (value: string) => void;
}) {
  const colors = useModelPopupColors();
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 6,
        flexDirection: "row",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 8,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 12, flexGrow: 1 }}>响应模式</Text>
      <View
        accessibilityRole="radiogroup"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          backgroundColor: colors.rail,
          padding: 3,
          borderRadius: 10,
        }}
      >
        {props.choices.map((choice) => (
          <Pressable
            key={choice.id}
            accessibilityRole="radio"
            accessibilityLabel={choice.label}
            accessibilityState={{ checked: choice.id === props.current }}
            onPress={() => props.onChange(choice.id)}
            style={{
              minHeight: 44,
              paddingHorizontal: 12,
              borderRadius: 8,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              backgroundColor: choice.id === props.current ? colors.segment : "transparent",
            }}
          >
            {choice.label === "快速" ? (
              <SymbolView name="bolt.circle" size={13} tintColor={colors.muted} />
            ) : null}
            <Text
              style={{
                fontSize: 12,
                color: choice.id === props.current ? colors.text : colors.muted,
              }}
            >
              {choice.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function PopupReasoningControl(props: {
  readonly choices: ReturnType<typeof selectableChoices>;
  readonly current: string | null;
  readonly modelLabel: string;
  readonly disabled: boolean;
  readonly defaultValue: string | null;
  readonly onSetDefault?: (value: string | null) => Promise<string | null>;
  readonly defaultEditError?: string;
  readonly highlightEnabled: boolean;
  readonly onChange: (value: string) => void;
  readonly onDraggingChange: (dragging: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const setDefault = async (value: string | null) => {
    if (!props.onSetDefault || props.defaultEditError || pending.current) return;
    if (value === props.defaultValue) {
      setExpanded(false);
      return;
    }
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const saveError = await props.onSetDefault(value);
      if (saveError === null) {
        setExpanded(false);
        void Haptics.selectionAsync();
      } else {
        setError(saveError);
      }
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const editorExpanded = expanded && !props.defaultEditError;

  return (
    <>
      <ReasoningSlider
        choices={props.choices}
        value={props.current}
        modelLabel={props.modelLabel}
        disabled={props.disabled}
        defaultValue={props.defaultValue}
        defaultEditorExpanded={editorExpanded}
        defaultSaving={saving}
        highlightEnabled={props.highlightEnabled && !editorExpanded}
        defaultEditUnavailable={props.defaultEditError}
        {...(props.onSetDefault && props.choices.length > 0 && !props.defaultEditError
          ? {
              onEditDefault: () => {
                setError(null);
                setExpanded(true);
              },
            }
          : {})}
        onChange={props.onChange}
        onDraggingChange={props.onDraggingChange}
      />
      {editorExpanded ? (
        <PopupChoicesDialog title="默认思考强度" onClose={() => setExpanded(false)} error={error}>
          <PopupChoice
            label="使用供应商默认"
            selected={!props.choices.some((choice) => choice.id === props.defaultValue)}
            disabled={saving}
            onPress={() => void setDefault(null)}
          />
          {props.choices.map((choice) => (
            <PopupChoice
              key={choice.id}
              label={reasoningLevelLabel(choice)}
              description={choice.description}
              selected={choice.id === props.defaultValue}
              disabled={saving}
              onPress={() => void setDefault(choice.id)}
            />
          ))}
        </PopupChoicesDialog>
      ) : null}
    </>
  );
}

function ThreadSettingsPopupOptions(props: {
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly highlightEnabled: boolean;
}) {
  const colors = useModelPopupColors();
  const session = useThreadSettingsSession();
  const [showMore, setShowMore] = useState(false);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "reasoning effort default update",
    reportFailure: false,
  });
  const { environmentId, displayedModelSelection } = session;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const settings = environmentId ? configs.get(environmentId)?.settings : undefined;
  const reasoningDescriptor = findReasoningOptionDescriptor(session.displayedDescriptors);
  const savedDefault = displayedModelSelection
    ? (settings?.reasoningEffortDefaults?.[displayedModelSelection.instanceId]?.[
        displayedModelSelection.model
      ] ?? null)
    : null;
  const defaultEditError = !settings
    ? "请连接服务端后重试。"
    : settings.reasoningEffortDefaults === undefined
      ? "请将服务端更新到支持默认思考强度的版本。"
      : !canWriteSettings
        ? "当前连接需要服务端设置写入权限。"
        : undefined;
  const setDefault =
    environmentId && displayedModelSelection
      ? async (effort: string | null) => {
          const { instanceId, model } = displayedModelSelection;
          const result = await saveSettings({
            environmentId,
            input: { patch: { setReasoningEffortDefault: { instanceId, model, effort } } },
          });
          if (!AsyncResult.isSuccess(result)) {
            return "无法保存默认思考强度。请检查服务端连接和权限后重试。";
          }
          const savedDefaults = result.value.reasoningEffortDefaults;
          if (!savedDefaults || (savedDefaults[instanceId]?.[model] ?? null) !== effort) {
            return "服务端未确认此档位。请刷新设置后重试。";
          }
          return null;
        }
      : undefined;
  const modelLabel =
    session.providerGroups.flatMap((group) => group.models).find(session.isDisplayed)?.label ??
    session.displayedModelSelection?.model ??
    "";
  return (
    <View className="px-2 pb-2">
      {session.displayedDescriptors.map((descriptor) => {
        if (descriptor.type !== "select") {
          if (descriptor.id === "fastMode") {
            return (
              <PopupSpeedSegments
                key={descriptor.id}
                choices={[
                  { id: "standard", label: "标准" },
                  { id: "fast", label: "快速" },
                ]}
                current={descriptor.currentValue ? "fast" : "standard"}
                onChange={(value) => session.applyOptionChange(descriptor.id, value === "fast")}
              />
            );
          }
          return (
            <View
              key={descriptor.id}
              className="min-h-11 flex-row items-center justify-between px-3"
            >
              <Text style={{ color: colors.text, fontSize: 13 }}>
                {popupLabel(descriptor.label)}
              </Text>
              <ThemedSwitch
                accessibilityLabel={popupLabel(descriptor.label)}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </View>
          );
        }
        const primary = descriptor.id === session.promptTraits.primarySelectDescriptor?.id;
        const reasoning = isReasoningControl(descriptor);
        const current =
          primary && session.promptTraits.ultrathinkPromptControlled
            ? "ultrathink"
            : getProviderOptionCurrentValue(
                descriptor,
                session.displayedModelSelection,
                session.reportedModelSelection,
              );
        const applyChoice = (value: string) => {
          if (primary && session.promptTraits.ultrathinkInBodyText) {
            Dialog.alert("思考强度由提示词控制", '请先移除提示词中的 "ultrathink" 再调整。');
            return;
          }
          void Haptics.selectionAsync();
          session.applyOptionChange(descriptor.id, value);
        };
        if (reasoning) {
          const choices = selectableChoices(descriptor);
          const editableDefault = descriptor.id === reasoningDescriptor?.id;
          return (
            <PopupReasoningControl
              key={JSON.stringify([
                session.environmentId,
                session.displayedModelSelection?.instanceId,
                session.displayedModelSelection?.model,
                descriptor.id,
                choices.map((choice) => choice.id),
              ])}
              choices={choices}
              current={typeof current === "string" ? current : null}
              modelLabel={modelLabel}
              disabled={primary && session.promptTraits.ultrathinkInBodyText}
              defaultValue={editableDefault ? savedDefault : null}
              highlightEnabled={props.highlightEnabled}
              {...(setDefault && editableDefault ? { onSetDefault: setDefault } : {})}
              {...(editableDefault && defaultEditError ? { defaultEditError } : {})}
              onChange={applyChoice}
              onDraggingChange={props.onDraggingChange}
            />
          );
        }
        if (descriptor.id === "serviceTier") {
          return (
            <PopupSpeedSegments
              key={descriptor.id}
              choices={selectableChoices(descriptor).map((choice) => ({
                id: choice.id,
                label:
                  choice.id === "priority" || choice.id === "fast"
                    ? "快速"
                    : choice.id === "default" || choice.id === "standard"
                      ? "标准"
                      : popupLabel(choice.label),
              }))}
              current={typeof current === "string" ? current : null}
              onChange={applyChoice}
            />
          );
        }
        return (
          <View key={descriptor.id}>
            <Text
              accessibilityRole="header"
              className="px-3 pb-1 pt-3 text-xs font-t3-medium text-foreground-muted"
            >
              {popupLabel(descriptor.label)}
            </Text>
            {selectableChoices(descriptor).map((choice) => (
              <PopupChoice
                key={choice.id}
                label={popupLabel(choice.label)}
                isDefault={choice.isDefault}
                description={choice.description}
                selected={choice.id === current}
                onPress={() => {
                  if (primary && session.promptTraits.ultrathinkInBodyText) {
                    Dialog.alert(
                      "思考强度由提示词控制",
                      '请先移除提示词中的 "ultrathink" 再调整。',
                    );
                    return;
                  }
                  void Haptics.selectionAsync();
                  session.applyOptionChange(descriptor.id, choice.id);
                }}
              />
            ))}
          </View>
        );
      })}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showMore }}
        onPress={() => setShowMore(!showMore)}
        className="min-h-11 flex-row items-center justify-between px-3 active:opacity-60"
      >
        <Text style={{ fontSize: 12, color: colors.muted }}>更多设置</Text>
        <SymbolView
          name={showMore ? "chevron.up" : "chevron.down"}
          size={12}
          tintColor={colors.muted}
        />
      </Pressable>
      {showMore ? (
        <View>
          {session.hasLegacyModels ? (
            <View className="min-h-11 flex-row items-center justify-between px-3">
              <Text style={{ color: colors.text, fontSize: 13 }}>显示旧模型</Text>
              <ThemedSwitch
                accessibilityLabel="显示旧模型"
                value={session.showLegacy}
                onValueChange={session.setShowLegacy}
              />
            </View>
          ) : null}
          <View className="min-h-11 flex-row items-center justify-between px-3">
            <Text style={{ color: colors.text, fontSize: 13 }}>管理隐藏的模型</Text>
            <ThemedSwitch
              accessibilityLabel="管理隐藏的模型"
              value={session.manageHidden}
              onValueChange={session.setManageHidden}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function ThreadSettingsPopup(props: ThreadSettingsPickerPresentation) {
  const colors = useModelPopupColors();
  const session = useThreadSettingsSession();
  const { height, width, fontScale } = useWindowDimensions();
  const focused = useIsFocused();
  const active = useAppActive();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((keyboard) => keyboard.isVisible);
  const [availableHeight, setAvailableHeight] = useState(height - insets.top - insets.bottom - 24);
  const [headerContentHeight, setHeaderContentHeight] = useState(92);
  const [searchVisible, setSearchVisible] = useState(false);
  const [sliderDragging, setSliderDragging] = useState(false);
  const [runtimeMenuAnchor, setRuntimeMenuAnchor] = useState<PopupFrame | null>(null);
  const runtimeButton = useRef<ViewInstance>(null);
  const [windowFocused, setWindowFocused] = useState(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- stops the rail when Android loses window focus without going into the background
  useEffect(() => {
    const focus = AppState.addEventListener("focus", () => setWindowFocused(true));
    const blur = AppState.addEventListener("blur", () => setWindowFocused(false));
    return () => {
      focus.remove();
      blur.remove();
    };
  }, []);
  const inputRef = useRef<TextInputInstance>(null);
  const runtimeLabel = session.runtimeModeChoices.find(
    (choice) => choice.mode === session.runtimeMode,
  )?.label;
  const panelLimit = Math.min(560, availableHeight * (keyboardVisible ? 0.98 : 0.9));
  const headerLimit = panelLimit * (searchVisible ? 0.48 : 0.36);
  const catalogItems = buildThreadSettingsCatalogItems(session).filter(
    (item) => item.kind !== "provider",
  );
  const estimatedCatalogHeight = catalogItems.length
    ? catalogItems.reduce((sum) => sum + 48 * Math.max(1, fontScale), 8)
    : 64;
  const catalogHeight = Math.min(192, panelLimit * 0.31, estimatedCatalogHeight);
  const optionsLimit = Math.max(
    44,
    panelLimit - Math.min(headerContentHeight, headerLimit) - catalogHeight - 2,
  );
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId)
    : undefined;
  const filterButton = (key: string | null, label: string, icon: ReactNode) => (
    <Pressable
      key={key ?? "all"}
      accessibilityRole="button"
      accessibilityLabel={`筛选：${label}`}
      accessibilityState={{ selected: session.providerFilter === key }}
      onPress={() => session.setProviderFilter(key)}
      className={cn(
        "min-h-11 flex-row items-center justify-center gap-1.5 rounded-lg px-2 active:opacity-60",
      )}
      style={{ backgroundColor: session.providerFilter === key ? colors.selected : "transparent" }}
    >
      {icon}
      <Text style={{ fontSize: 11, color: colors.muted }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
  return (
    <View className="flex-1">
      <Pressable
        accessible={false}
        className="absolute inset-0 bg-backdrop"
        onPress={props.onClose}
      />
      <KeyboardAvoidingView
        behavior="height"
        className="flex-1"
        pointerEvents="box-none"
        style={{ paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }}
      >
        <View
          pointerEvents="box-none"
          className="flex-1 items-center justify-center"
          onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}
        >
          <View
            accessibilityViewIsModal
            className="overflow-hidden"
            style={{
              borderRadius: 22,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: colors.panel,
              width: Math.min(380, width - insets.left - insets.right - 32),
              maxHeight: panelLimit,
              marginTop: keyboardVisible ? 0 : Math.min(48, availableHeight * 0.06),
            }}
          >
            <DockGlassBackdrop scope="thread" material="popup" />
            <ScrollView
              style={{ flexGrow: 0, flexShrink: 1, maxHeight: headerLimit }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              onContentSizeChange={(_, contentHeight) => setHeaderContentHeight(contentHeight)}
            >
              <View className="flex-row items-center gap-1 px-2">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="关闭模型与参数"
                  onPress={props.onClose}
                  className="min-h-12 min-w-12 items-center justify-center active:opacity-60"
                >
                  <SymbolView name="xmark" size={17} tintColor={colors.text} />
                </Pressable>
                <Text
                  accessibilityRole="header"
                  className="min-w-0 flex-1 text-sm font-t3-semibold"
                  numberOfLines={2}
                  style={{ color: colors.text }}
                >
                  模型与参数
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="搜索模型"
                  accessibilityState={{ expanded: searchVisible }}
                  onPress={() => {
                    if (searchVisible) {
                      inputRef.current?.blur();
                      session.setSearchQuery("");
                    }
                    setSearchVisible(!searchVisible);
                  }}
                  className="min-h-12 min-w-12 items-center justify-center active:opacity-60"
                >
                  <SymbolView name="magnifyingglass" size={17} tintColor={colors.text} />
                </Pressable>
                <Pressable
                  ref={runtimeButton}
                  collapsable={false}
                  accessibilityLabel={runtimeLabel ? `权限，当前${runtimeLabel}` : "权限"}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: runtimeMenuAnchor !== null }}
                  onPress={() => {
                    runtimeButton.current?.measureInWindow((x, y, width, height) => {
                      if (width > 0 && height > 0) setRuntimeMenuAnchor({ x, y, width, height });
                    });
                  }}
                  className="max-w-[116px] justify-center active:opacity-60"
                  style={{ minHeight: 48, minWidth: 48 }}
                >
                  <View
                    className="min-h-7 flex-row items-center justify-center gap-1 rounded-full px-2.5 py-1"
                    style={{ backgroundColor: colors.rail }}
                  >
                    <Text
                      className="min-w-0 shrink text-center"
                      style={{ color: colors.text, fontSize: 12 }}
                    >
                      {runtimeLabel ?? "权限"}
                    </Text>
                    <SymbolView
                      name={runtimeMenuAnchor ? "chevron.up" : "chevron.down"}
                      size={12}
                      tintColor={colors.muted}
                    />
                  </View>
                </Pressable>
              </View>
              {searchVisible ? (
                <View className="mx-3 flex-row">
                  <SearchField
                    inputRef={inputRef}
                    autoFocus
                    accessibilityLabel="查找模型"
                    clearAccessibilityLabel="清空模型搜索"
                    placeholder="查找模型"
                    value={session.searchQuery}
                    onChangeText={session.setSearchQuery}
                  />
                </View>
              ) : null}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
              >
                <View className="flex-row gap-1">
                  {filterButton(
                    null,
                    "全部",
                    <SymbolView name="square.grid.2x2" size={18} tintColor={colors.text} />,
                  )}
                  {filterButton(
                    FAVORITES_PROVIDER_FILTER,
                    "收藏",
                    <SymbolView name="star" size={18} tintColor={colors.text} />,
                  )}
                  {session.providerGroups.map((group) =>
                    filterButton(
                      group.providerKey,
                      group.providerLabel,
                      <ProviderIcon
                        appearance={colors.appearance}
                        iconUrl={group.models[0]?.providerIconUrl}
                        provider={group.models[0]?.providerDriver}
                        size={18}
                      />,
                    ),
                  )}
                </View>
              </ScrollView>
              <ChatGptSharingStatus provider={selectedProvider ?? null} />
            </ScrollView>
            <View style={{ height: catalogHeight }}>
              <ThreadSettingsMainContent compact bottomInset={0} onOpenSubmenu={() => undefined} />
            </View>
            <ScrollView
              scrollEnabled={!sliderDragging}
              style={{
                flexGrow: 0,
                flexShrink: 1,
                maxHeight: optionsLimit,
                borderTopWidth: 1,
                borderTopColor: colors.border,
              }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              <ThreadSettingsPopupOptions
                highlightEnabled={focused && active && windowFocused && !runtimeMenuAnchor}
                onDraggingChange={setSliderDragging}
              />
            </ScrollView>
          </View>
        </View>
      </KeyboardAvoidingView>
      {runtimeMenuAnchor ? (
        <PopupChoicesDialog
          title="权限"
          anchor={runtimeMenuAnchor}
          onClose={() => setRuntimeMenuAnchor(null)}
        >
          {session.runtimeModeChoices.map((choice) => (
            <PopupChoice
              key={choice.mode}
              label={choice.label}
              description={choice.disabledReason ?? choice.description}
              showDescription
              selected={choice.mode === session.runtimeMode}
              disabled={choice.disabledReason !== undefined}
              onPress={() => {
                setRuntimeMenuAnchor(null);
                void Haptics.selectionAsync();
                session.onUpdateRuntimeMode(choice.mode);
              }}
            />
          ))}
        </PopupChoicesDialog>
      ) : null}
    </View>
  );
}

export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      {Platform.OS === "android" ? (
        <ThreadSettingsPopup onClose={props.onClose} />
      ) : (
        <ThreadSettingsPickerNavigator onClose={props.onClose} />
      )}
    </ThreadSettingsSessionProvider>
  );
}

export function ExistingThreadSettingsRouteScreen({
  route,
}: StaticScreenProps<ExistingThreadSettingsRouteParams>) {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  // Reads the same environmentId/threadId params as the Thread route beneath it.
  const { selectedThread, selectedThreadDetailRef, selectedEnvironmentRuntime } =
    useThreadSelection();
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  // Streamed text would otherwise re-render the whole model picker on every delta.
  const structure = useQuietThreadStructure(selectedThreadDetailRef);
  const reportedModelSelection = useThreadReportedModelSelection(selectedThreadDetailRef);
  const threadKey = scopedThreadKey(route.params.environmentId, route.params.threadId);
  const draftSettings = useComposerDraftSettings(threadKey);
  const queuedRunEdit = useQueuedRunEdit(threadKey);
  // A queued edit can end while the sheet is open; the prompt then belongs to the thread's draft.
  const draftKey = activeComposerDraftKey(threadKey, route.params.draftKey, queuedRunEdit);
  const prompt = useComposerDraft(draftKey).text;

  if (!selectedThread) {
    return <View className="flex-1 bg-sheet" />;
  }

  const serverConfig = serverConfigForCwd(
    selectedEnvironmentRuntime?.serverConfig ?? null,
    selectedThreadCwd,
  );
  const modelSelection = draftSettings.modelSelection ?? selectedThread.modelSelection;
  const lockedProviderInstanceId = threadAllowsProviderSwitch({
    thread: selectedThread,
    projection: structure?.projection,
  })
    ? undefined
    : modelSelection.instanceId;
  const modelOptions = buildModelOptions(
    serverConfig,
    modelSelection,
    lockedProviderInstanceId,
    selectedThread.projectId,
  );
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === modelSelection.instanceId &&
        option.selection.model === modelSelection.model,
    ) ?? null;
  const updateModelSelection = (selection: ModelSelection) =>
    selectThreadModel(route.params, selection);

  return (
    <ThreadSettingsPickerScreen
      environmentId={selectedThread.environmentId}
      projectId={selectedThread.projectId}
      cwd={selectedThreadCwd}
      providerInstanceId={modelSelection.instanceId}
      {...(lockedProviderInstanceId ? { lockedProviderInstanceId } : {})}
      providerGroups={groupByProvider(modelOptions)}
      selectedModel={modelSelection}
      prompt={prompt}
      onPromptChange={(text) => setComposerDraftText(draftKey, text)}
      reportedModelSelection={reportedModelSelection}
      onSelectModel={(option) => updateModelSelection(withRememberedModelOptions(option.selection))}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: modelSelection.options,
      })}
      onUpdateOptionSelections={(options) => {
        rememberModelOptions(modelSelection.instanceId, modelSelection.model, options ?? []);
        updateModelSelection({ ...modelSelection, options });
      }}
      runtimeMode={draftSettings.runtimeMode ?? selectedThread.runtimeMode}
      onUpdateRuntimeMode={(runtimeMode) => updateComposerDraftSettings(threadKey, { runtimeMode })}
      onClose={() => navigation.goBack()}
    />
  );
}

/** RNS owns nested sheet dismissal; Reasoning and Runtime remain ordinary pushes. */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = resolveProviderOptionDescriptors({
    capabilities: flow.selectedModelOption?.capabilities,
    selections: flow.selectedModel?.options,
  });

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      cwd={flow.workspaceCwd}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      restoreSelection={withRememberedModelOptions}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}
