import type { ModelSelection } from "@t3tools/contracts";
import { findReasoningOptionDescriptor, pickModelSelection } from "@t3tools/shared/model";
import { useState } from "react";
import { ScrollView, TextInput } from "react-native";

import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { Sheet } from "../../components/ui/Sheet";
import { buildModelOptions } from "../../lib/modelOptions";
import { useEnvironmentServerConfig } from "../../state/entities";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import type { ScopedMobileSettingsTarget } from "./settings-scoped-server";

type ModelSetting = "defaultModelSelection" | "defaultSubagentModelSelection";

function configuredModel(target: ScopedMobileSettingsTarget, setting: ModelSetting) {
  const override =
    target.projectId === null
      ? undefined
      : target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId]?.[
          setting
        ];
  return override === undefined ? target.settings[setting] : override;
}

export function SettingsProjectModelDefault(props: {
  readonly target: ScopedMobileSettingsTarget;
  readonly setting: ModelSetting;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const { target, setting, disabled, onChange } = props;
  const title = setting === "defaultModelSelection" ? "主模型" : "子代理模型";
  const config = useEnvironmentServerConfig(target.environment.environmentId);
  const selection = configuredModel(target, setting);
  const options = buildModelOptions(config, null, undefined, target.projectId).filter(
    (option) => !option.isUnavailable && !option.isLegacy,
  );
  const chosen = options.find(
    (option) =>
      option.selection.instanceId === selection?.instanceId &&
      option.selection.model === selection.model,
  );
  const effort = findReasoningOptionDescriptor(chosen?.capabilities?.optionDescriptors);
  const selectedEffort = selection?.options?.find((option) => option.id === effort?.id)?.value;
  const reason = selection && !chosen ? `${selection.model} 在当前后端不可用。` : undefined;
  const detail = chosen
    ? [chosen.label, effort?.options.find((option) => option.id === selectedEffort)?.label]
        .filter(Boolean)
        .join(" · ")
    : (selection?.model ?? "自动");

  return (
    <>
      <SettingsRow
        icon="brain"
        label={title}
        value={reason ?? detail}
        disabled={disabled || config === null}
        onPress={() => setOpen(true)}
      />
      {open && (
        <ProjectModelSheet
          title={title}
          options={options}
          selection={selection}
          disabled={disabled}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ProjectModelSheet(props: {
  readonly title: string;
  readonly options: ReturnType<typeof buildModelOptions>;
  readonly selection: ModelSelection | null;
  readonly disabled: boolean;
  readonly onChange: (selection: ModelSelection | null) => void;
  readonly onClose: () => void;
}) {
  const { options, disabled, onChange, onClose } = props;
  const [selection, setSelection] = useState(props.selection);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const chosen = options.find(
    (option) =>
      option.selection.instanceId === selection?.instanceId &&
      option.selection.model === selection.model,
  );
  const effort = findReasoningOptionDescriptor(chosen?.capabilities?.optionDescriptors);
  const selectedEffort = selection?.options?.find((option) => option.id === effort?.id)?.value;
  const availableEfforts = effort?.options.filter(
    ({ id }) => !effort.promptInjectedValues?.includes(id),
  );
  const visibleOptions = options.filter((option) =>
    `${option.label} ${option.providerLabel} ${option.selection.model}`
      .toLowerCase()
      .includes(needle),
  );

  return (
    <Sheet title={props.title} onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 px-5 pb-8" keyboardShouldPersistTaps="handled">
        {selection && effort && availableEfforts?.length ? (
          <SettingsSection title="思考强度">
            <ListChoiceRow
              label="自动"
              selected={selectedEffort === undefined}
              onPress={() =>
                setSelection({
                  ...selection,
                  options: selection.options?.filter((option) => option.id !== effort.id) ?? [],
                })
              }
            />
            {availableEfforts.map((choice) => (
              <ListChoiceRow
                key={choice.id}
                label={choice.label}
                selected={selectedEffort === choice.id}
                separated
                onPress={() =>
                  setSelection({
                    ...selection,
                    options: [
                      ...(selection.options?.filter((option) => option.id !== effort.id) ?? []),
                      { id: effort.id, value: choice.id },
                    ],
                  })
                }
              />
            ))}
          </SettingsSection>
        ) : null}
        <TextInput
          accessibilityLabel="搜索模型"
          placeholder="搜索模型"
          autoCapitalize="none"
          autoCorrect={false}
          value={search}
          onChangeText={setSearch}
          className="rounded-lg bg-background px-4 py-3 text-foreground"
        />
        <SettingsSection title={props.title}>
          <ListChoiceRow
            label="自动"
            selected={selection === null}
            onPress={() => setSelection(null)}
          />
          {visibleOptions.map((option) => (
            <ListChoiceRow
              key={option.key}
              label={option.label}
              description={option.providerLabel}
              selected={option.key === chosen?.key}
              separated
              onPress={() =>
                setSelection(
                  pickModelSelection(
                    selection,
                    option.selection.instanceId,
                    option.selection.model,
                  ),
                )
              }
            />
          ))}
        </SettingsSection>
        <SettingsSection>
          <ListActionRow
            label="保存"
            disabled={disabled || (selection !== null && !chosen)}
            onPress={() => {
              onChange(selection);
              onClose();
            }}
          />
        </SettingsSection>
      </ScrollView>
    </Sheet>
  );
}
