import type {
  ModelCapabilities,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ServerProviderModel,
  ServerSettings,
} from "@t3tools/contracts";
import { replaceDescriptorCurrentValue } from "@t3tools/client-runtime/model-traits";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  isReasoningOptionId,
  withImplicitFastModeDefault,
} from "@t3tools/shared/model";
import {
  resolveModelReasoningOptionDefault,
  type LegacyProjectSettingsFields,
} from "@t3tools/shared/projectSettings";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: withImplicitFastModeDefault(input.capabilities, input.selections),
  });
}

/** Add inherited reasoning to the picker display without recording an explicit choice. */
export function providerOptionsForDisplay(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly selection: ModelSelection | null;
  readonly settings: ServerSettings | null | undefined;
  readonly projectId: ProjectId | null;
  readonly project: LegacyProjectSettingsFields | null;
}) {
  const { descriptors, selection, settings, projectId, project } = input;
  const inherited =
    settings && selection
      ? resolveModelReasoningOptionDefault({ settings, projectId, selection, descriptors, project })
      : undefined;
  return inherited && selection
    ? {
        descriptors: replaceDescriptorCurrentValue(descriptors, inherited.id, inherited.value),
        selection: { ...selection, options: [...(selection.options ?? []), inherited] },
      }
    : { descriptors, selection };
}

/** Changing another control must leave an inherited reasoning level unset. */
export function preserveInheritedReasoningEffort(
  next: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  previous: ReadonlyArray<ProviderOptionSelection> | undefined,
  changedId: string,
): ReadonlyArray<ProviderOptionSelection> {
  return next.filter(
    ({ id }) =>
      id === changedId ||
      !isReasoningOptionId(id, descriptors) ||
      previous?.some((option) => option.id === id),
  );
}

/** Spells out the Fast off the picker shows, or a provider such as Cursor applies its own default. */
export function withImplicitFastModeSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "capabilities">>;
  }>,
): ModelSelection {
  const capabilities = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)?.capabilities;
  const options = capabilities
    ? withImplicitFastModeDefault(capabilities, selection.options)
    : selection.options;
  return options === selection.options ? selection : { ...selection, options };
}

export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
