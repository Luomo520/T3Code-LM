import "./model-picker.css";
import {
  buildTraitsTriggerDisplay,
  getDescriptorStringValue,
  isReasoningControl,
  selectableProviderOptionChoices,
} from "@t3tools/client-runtime/model-traits";
import type { ProviderOptionDescriptor, RuntimeMode } from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  WorkflowIcon,
  RotateCcwIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, use, useRef, useState } from "react";

import { DefaultEffortMenu, type EditableEffortDefault } from "./ComposerDefaultEffort";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerControlSize } from "./ComposerControl";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { composerFloatingLayerProps, focusCheckedPermission } from "./composerEventScope";
import { EffortGlyph, FastBolt, resolveEffortGlyph } from "./EffortGlyph";
import { DockedPickerContext } from "./ProviderModelPicker";
import {
  getTraitsSectionVisibility,
  type TraitsSelectionInput,
  useTraitsSelection,
} from "./TraitsPicker";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;
type BooleanDescriptor = Extract<ProviderOptionDescriptor, { type: "boolean" }>;

/** Service tiers, Claude's Fast mode, and Ultracode sit in the footer, not the column. */
function splitSpeed(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const speedSelect = selects.find((descriptor) => descriptor.id === "serviceTier") ?? null;
  const fastToggle = toggles.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const ultracodeToggle = toggles.find((descriptor) => descriptor.id === "ultracode") ?? null;
  return {
    speedSelect,
    fastToggle,
    ultracodeToggle,
    columnSelects: selects.filter((descriptor) => descriptor !== speedSelect),
    columnToggles: toggles.filter(
      (descriptor) => descriptor !== fastToggle && descriptor !== ultracodeToggle,
    ),
  };
}

type ColumnControl =
  | { kind: "select"; descriptor: SelectDescriptor }
  | { kind: "boolean"; descriptor: BooleanDescriptor };

/**
 * The column lists the model's reasoning levels under the header that names it. Other options,
 * such as an agent's session mode, sit below as one row each.
 */
function columnControls(
  selects: ReadonlyArray<SelectDescriptor>,
  toggles: ReadonlyArray<BooleanDescriptor>,
) {
  const { columnSelects, columnToggles } = splitSpeed(selects, toggles);
  const controls: ReadonlyArray<ColumnControl> = [
    ...columnSelects.map((descriptor) => ({ kind: "select" as const, descriptor })),
    ...columnToggles.map((descriptor) => ({ kind: "boolean" as const, descriptor })),
  ];
  const effort = controls.find((control) => isReasoningControl(control.descriptor)) ?? null;
  return { effort, others: controls.filter((control) => control !== effort) };
}

/**
 * What the model trigger shows after the model name: the effort word (or bars, per the
 * Appearance setting), a bolt for Fast, a workflow icon for Ultracode, and other traits such as a
 * context window.
 */
export function describeComposerEffort(
  traits: TraitsSelectionInput | null,
  effortDisplay: EffortDisplay,
  size: ComposerControlSize,
): { suffix: ReactNode; detail: string | null } {
  if (!traits) return { suffix: null, detail: null };
  const visibility = getTraitsSectionVisibility(traits);
  if (!visibility.hasAnyControls) return { suffix: null, detail: null };
  const modelSelection =
    traits.instanceId && traits.model
      ? {
          instanceId: traits.instanceId,
          model: traits.model,
          options: visibility.modelOptionsForDisplay ?? [],
        }
      : null;
  const primary = visibility.primarySelectDescriptor;
  const display = buildTraitsTriggerDisplay({
    descriptors: visibility.descriptors,
    primarySelectDescriptorId: primary?.id ?? null,
    ultrathinkPromptControlled: visibility.ultrathinkPromptControlled,
    modelSelection,
    reportedModelSelection: traits.reportedModelSelection,
  });
  // The same reasoning control the column lists, wherever the agent put it among its options.
  const reasoning =
    columnControls(visibility.selectDescriptors, visibility.booleanDescriptors).effort
      ?.descriptor ?? null;
  const ultrathink = visibility.ultrathinkPromptControlled && reasoning === primary;
  const reasoningValue =
    reasoning?.type === "select"
      ? ultrathink
        ? "ultrathink"
        : getDescriptorStringValue(reasoning, modelSelection, traits.reportedModelSelection)
      : null;
  const glyph = reasoning?.type === "select" ? resolveEffortGlyph(reasoning, reasoningValue) : null;
  // Workflow levels such as Ultracode always show their name; the setting names every level.
  const word = glyph
    ? (glyph.special ?? (effortDisplay === "label" ? glyph.label : null))
    : !reasoning
      ? null
      : reasoning.type === "boolean"
        ? `${reasoning.label} ${reasoning.currentValue === true ? "开启" : "关闭"}`
        : ultrathink
          ? "Ultrathink"
          : (getProviderOptionCurrentLabel(
              reasoning,
              modelSelection,
              traits.reportedModelSelection,
            ) ?? (reasoning.id === "thinking" ? reasoning.label : null));
  const fast = display.speedLabel === "Fast" || display.speedLabel === "Ultrafast";
  // Agent options such as modes live in the picker; the trigger adds only the context window.
  const contextWindow =
    visibility.contextWindowDescriptor &&
    getProviderOptionCurrentLabel(
      visibility.contextWindowDescriptor,
      modelSelection,
      traits.reportedModelSelection,
    );
  if (!word && !glyph && !fast && !display.ultracode && !contextWindow)
    return { suffix: null, detail: display.label };
  return {
    detail: display.label,
    suffix: (
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 text-muted-foreground group-hover/model-trigger:text-foreground group-data-pressed/model-trigger:text-foreground group-data-popup-open/model-trigger:text-foreground",
          // A word space after the model name: the regular trigger's gap is wider than one.
          size === "sm" && "-ms-0.5",
        )}
      >
        {word ? (
          <span data-composer-control-label translate="no" className="max-w-24 truncate">
            {reasoningValue ? reasoningLevelLabel(reasoningValue, word) : word}
          </span>
        ) : glyph ? (
          <EffortGlyph count={glyph.count} filled={glyph.filled} size={size} />
        ) : null}
        {fast ? <FastBolt ultra={display.speedLabel === "Ultrafast"} /> : null}
        {display.ultracode ? (
          <WorkflowIcon aria-hidden="true" data-composer-control-icon className="size-3" />
        ) : null}
        {contextWindow ? (
          <span
            // A label, so icon-only footers drop it; compacted rows drop it before the model.
            data-composer-control-label
            data-composer-secondary-trait
            className="max-w-24 truncate text-xs"
          >
            {contextWindow}
          </span>
        ) : null}
      </span>
    ),
  };
}

const COLUMN_ROW =
  "flex h-8 w-full shrink-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-left text-sm text-foreground outline-none hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09] disabled:cursor-not-allowed disabled:opacity-64";
const COLUMN_LABEL = "px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs";

function ColumnRow(props: {
  label: string;
  /** Shown on hover; the column is too narrow to print it under the label. */
  description?: string | undefined;
  selected: boolean;
  /** The column's one tab stop: the selected level, else the first when none shows as selected. */
  tabStop: boolean;
  isDefault?: boolean | undefined;
  disabled?: boolean;
  onPick: () => void;
}) {
  const rowProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.selected,
    disabled: props.disabled,
    "data-effort-row": true,
    // Focus lands on a level after a model pick.
    "data-effort-level": true,
    // Up and Down move between rows.
    tabIndex: props.tabStop ? 0 : -1,
    className: COLUMN_ROW,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      {props.selected ? (
        <>
          {props.isDefault ? <span className="sr-only">默认</span> : null}
          <CheckIcon aria-hidden="true" className="size-3.5" />
        </>
      ) : props.isDefault ? (
        <span className="text-muted-foreground/70 text-xs">默认</span>
      ) : null}
    </>
  );
  if (!props.description) return <button {...rowProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...rowProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="right" className="max-w-56">
        {props.description}
      </TooltipPopup>
    </Tooltip>
  );
}

function EffortLevels(props: {
  traits: TraitsSelectionInput;
  defaultEffort?: EditableEffortDefault | undefined;
}) {
  const traits = useTraitsSelection(props.traits);
  const { effort, others } = columnControls(traits.selectDescriptors, traits.booleanDescriptors);
  if (traits.modelIsUnavailable) {
    return (
      <>
        {traits.descriptors.map((descriptor) => {
          const value = traits.currentLabel(descriptor);
          return value ? (
            <div key={descriptor.id}>
              <div className={COLUMN_LABEL}>{descriptor.label}</div>
              <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
            </div>
          ) : null;
        })}
      </>
    );
  }
  if (!effort && others.length === 0) return <NoEffortRow />;
  // Ultrathink in the prompt locks the levels; the first option then holds the tab stop.
  const locked =
    effort?.descriptor.id === traits.primarySelectDescriptor?.id && traits.ultrathinkInBodyText;
  return (
    <>
      {effort ? (
        <EffortRows
          key={JSON.stringify([props.traits.instanceId, props.traits.model, effort.descriptor.id])}
          control={effort}
          traits={traits}
          locked={locked}
          defaultEffort={props.defaultEffort}
        />
      ) : null}
      {others.length > 0 ? (
        <div
          className={cn("flex flex-col gap-0.5", effort && "mt-1 border-t border-border/70 pt-1")}
        >
          {others.map((control, index) =>
            control.kind === "boolean" ? (
              <OptionSwitchRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ) : (
              <OptionMenuRow
                key={control.descriptor.id}
                descriptor={control.descriptor}
                traits={traits}
                tabStop={(!effort || locked) && index === 0}
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}

type TraitsSelection = ReturnType<typeof useTraitsSelection>;

// t3zh-skip: model reasoning levels use their English names in every locale.
const REASONING_LEVEL_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultra: "Ultra",
  ultrathink: "Ultrathink",
  ultracode: "Ultracode",
};
export function reasoningLevelLabel(id: string, fallback: string): string {
  return Object.hasOwn(REASONING_LEVEL_LABELS, id) ? REASONING_LEVEL_LABELS[id]! : fallback;
}

const REASONING_THUMB_SIZE = 42;
const REASONING_RAIL_LEAD = 8;

function EffortRows(props: {
  control: ColumnControl;
  traits: TraitsSelection;
  locked: boolean;
  defaultEffort?: EditableEffortDefault | undefined;
}) {
  const { control, traits } = props;
  const { descriptor } = control;
  const picker = use(DockedPickerContext);
  if (control.kind === "boolean") {
    return (
      <div role="radiogroup" aria-label={descriptor.label} className="flex flex-col gap-0.5">
        {([true, false] as const).map((value) => (
          <ColumnRow
            key={String(value)}
            label={value ? "开启" : "关闭"}
            selected={(control.descriptor.currentValue === true) === value}
            tabStop={(control.descriptor.currentValue === true) === value}
            onPick={() => traits.changeBoolean(descriptor.id, value)}
          />
        ))}
      </div>
    );
  }
  const { locked } = props;
  const value = traits.selectValue(control.descriptor);
  const choices = selectableProviderOptionChoices(control.descriptor);
  const index = choices.findIndex((option) => option.id === value);
  const defaultChoice =
    choices.find((option) => option.id === props.defaultEffort?.saved) ??
    choices.find((option) => option.isDefault);
  const defaultLabel = defaultChoice
    ? reasoningLevelLabel(defaultChoice.id, defaultChoice.label)
    : "自动";
  const selected = index >= 0 ? choices[index] : undefined;
  const label = reasoningLevelLabel(value, selected?.label ?? (value || "未设置"));
  const disabled = locked || traits.modelIsUnavailable || choices.length < 2;
  const animateSweep = !disabled && index >= 0;
  return (
    <div data-reasoning-slider-part="control">
      <div data-reasoning-slider-part="heading">
        <div data-reasoning-slider-part="value" aria-live="polite" translate="no">
          {label}
        </div>
        <div data-reasoning-slider-part="model">{picker.modelLabel}</div>
        {defaultChoice ? (
          <button
            type="button"
            data-reasoning-slider-part="reset"
            aria-label={`恢复默认：${defaultLabel}`}
            disabled={locked || traits.modelIsUnavailable}
            onClick={() => traits.changeSelect(control.descriptor, defaultChoice.id)}
          >
            <RotateCcwIcon aria-hidden="true" className="size-5" />
          </button>
        ) : null}
      </div>
      {choices.length ? (
        <div
          data-reasoning-slider-part="track"
          data-current-known={index >= 0}
          data-reasoning-sweep={animateSweep || undefined}
          style={
            {
              "--reasoning-thumb-size": `${REASONING_THUMB_SIZE}px`,
              "--reasoning-rail-lead": `${REASONING_RAIL_LEAD}px`,
              "--reasoning-fraction":
                choices.length > 1 && index >= 0 ? index / (choices.length - 1) : 0,
            } as CSSProperties
          }
        >
          <div data-reasoning-slider-part="rail" aria-hidden="true">
            <div
              data-reasoning-slider-part="fill"
              ref={animateSweep ? observeVisibleAnimation : undefined}
            />
          </div>
          <div data-reasoning-slider-part="stops" aria-hidden="true">
            {choices.map((option, stop) => (
              <i key={option.id} data-passed={index >= 0 && stop <= index} />
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(0, choices.length - 1)}
            step={1}
            value={Math.max(0, index)}
            disabled={disabled}
            data-effort-row
            data-effort-level
            aria-label="思考强度"
            aria-valuetext={label}
            translate="no"
            onKeyDown={(event) => {
              if (index < 0 && !disabled && (event.key === "Home" || event.key === "ArrowLeft")) {
                event.preventDefault();
                const first = choices[0];
                if (first) traits.changeSelect(control.descriptor, first.id);
              }
            }}
            onPointerUp={(event) => {
              if (index >= 0 || disabled) return;
              const rect = event.currentTarget.getBoundingClientRect();
              const firstCenter = REASONING_RAIL_LEAD + REASONING_THUMB_SIZE / 2;
              const travel = rect.width - REASONING_RAIL_LEAD - REASONING_THUMB_SIZE;
              const fraction = Math.max(
                0,
                Math.min(1, (event.clientX - rect.left - firstCenter) / Math.max(1, travel)),
              );
              const next = choices[Math.round(fraction * (choices.length - 1))];
              if (next) traits.changeSelect(control.descriptor, next.id);
            }}
            onChange={(event) => {
              const next = choices[Number(event.currentTarget.value)];
              if (next && !disabled) traits.changeSelect(control.descriptor, next.id);
            }}
          />
        </div>
      ) : (
        <p className="px-2 py-2 text-xs text-muted-foreground">此模型没有可调等级</p>
      )}
      {defaultChoice || (props.defaultEffort && choices.length > 1) ? (
        <div data-reasoning-slider-part="default">
          {props.defaultEffort && choices.length > 1 ? (
            <DefaultEffortMenu
              setting={props.defaultEffort}
              valueLabel={defaultLabel}
              choices={choices.map((choice) => ({
                id: choice.id,
                label: reasoningLevelLabel(choice.id, choice.label),
              }))}
            />
          ) : (
            <span>
              默认：<span translate="no">{defaultLabel}</span>
            </span>
          )}
        </div>
      ) : null}
      {locked ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {"思考强度由提示词中的 ultrathink 控制，请先移除该提示词再调整。"}
        </p>
      ) : null}
    </div>
  );
}

const OPTION_ROW = cn(COLUMN_ROW, "h-auto py-1");

/** An option's name over its current value. */
function OptionRowText(props: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-muted-foreground text-xs">{props.label}</span>
      <span className="truncate">{props.value}</span>
    </span>
  );
}

/**
 * One select besides reasoning, such as an agent's session mode. It names the current choice and
 * opens the rest beside the column, so any number of options leaves the levels in place.
 */
function OptionMenuRow(props: {
  descriptor: SelectDescriptor;
  traits: TraitsSelection;
  /** Holds the column's tab stop when the model has no levels. */
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const [open, setOpen] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);
  const choices = selectableProviderOptionChoices(descriptor);
  const value = traits.selectValue(descriptor);
  const current = choices.find((choice) => choice.id === value)?.label ?? "";
  return (
    <Menu
      open={open}
      // A modal menu would cover the picker, so the next click there would only close it.
      modal={false}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => {
        if (!isOpen) return;
        const checked = popupRef.current?.querySelector<HTMLElement>(
          '[role="menuitemradio"][aria-checked="true"]',
        );
        checked?.focus({ preventScroll: true });
        checked?.scrollIntoView({ block: "nearest" });
      }}
    >
      {/* No hover opening: an opened menu takes focus, which would steal typing from search. */}
      <MenuTrigger
        render={
          <button
            type="button"
            data-effort-row
            tabIndex={props.tabStop ? 0 : -1}
            aria-label={`${descriptor.label}: ${current}`}
            className={cn(OPTION_ROW, "data-popup-open:bg-foreground/[0.09]")}
            onKeyDown={(event) => {
              if (event.key !== "ArrowRight") return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          />
        }
      >
        <OptionRowText label={descriptor.label} value={current} />
        <ChevronRightIcon
          aria-hidden="true"
          className="-me-1 size-3.5 shrink-0 text-muted-foreground"
        />
      </MenuTrigger>
      <MenuPopup
        ref={popupRef}
        side="right"
        align="start"
        sideOffset={6}
        // A full-width column on phones leaves no room beside it, so fall below or above.
        collisionAvoidance={{ fallbackAxisSide: "end" }}
        className="max-w-72"
        data-model-picker-option-menu
        {...composerFloatingLayerProps}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft") return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <MenuRadioGroup
          aria-label={descriptor.label}
          value={value}
          onValueChange={(next: string) => {
            if (next !== value) traits.changeSelect(descriptor, next);
          }}
        >
          {choices.map((choice) => (
            <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
              <span className="flex items-center gap-3">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{choice.label}</span>
                  {choice.description ? (
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  ) : null}
                </span>
                {choice.isDefault ? (
                  <span className="text-muted-foreground/70 text-xs">默认</span>
                ) : null}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** A two-state option toggles in place; a menu would add a click for nothing. */
function OptionSwitchRow(props: {
  descriptor: BooleanDescriptor;
  traits: TraitsSelection;
  tabStop: boolean;
}) {
  const { descriptor, traits } = props;
  const checked = descriptor.currentValue === true;
  return (
    <label className={cn(OPTION_ROW, "has-focus-visible:bg-foreground/[0.09]")}>
      <OptionRowText label={descriptor.label} value={checked ? "开启" : "关闭"} />
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={(next) => traits.changeBoolean(descriptor.id, next)}
        aria-label={descriptor.label}
        data-effort-row
        tabIndex={props.tabStop ? 0 : -1}
      />
    </label>
  );
}

function NoEffortRow() {
  return (
    <div className="flex h-8 items-center px-2 text-muted-foreground text-sm">没有可调思考强度</div>
  );
}

/** The model picker's effort column: the selected model's levels and its other options. */
export function ComposerEffortColumn(props: {
  traits: TraitsSelectionInput | null;
  defaultEffort?: EditableEffortDefault | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-3 pb-2">
      {props.traits ? (
        <EffortLevels traits={props.traits} defaultEffort={props.defaultEffort} />
      ) : (
        <NoEffortRow />
      )}
    </div>
  );
}

const FOOTER_SEGMENT =
  "flex min-h-9 cursor-pointer items-center justify-center gap-1 px-2 text-muted-foreground text-xs outline-none first:rounded-l-md last:rounded-r-md hover:text-foreground data-checked:bg-input/72 data-checked:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function SpeedSegment(props: {
  checked: boolean;
  label: string;
  description?: string | undefined;
  onPick: () => void;
}) {
  const buttonProps = {
    type: "button",
    role: "radio",
    "aria-checked": props.checked,
    "data-checked": props.checked || undefined,
    className: FOOTER_SEGMENT,
    onClick: props.onPick,
  } as const;
  const content = (
    <>
      {props.label === "Fast" || props.label === "Ultrafast" ? (
        <FastBolt ultra={props.label === "Ultrafast"} />
      ) : null}
      {(
        {
          Standard: "标准",
          Normal: "标准",
          Default: "默认",
          Fast: "快速",
          Ultrafast: "极速",
          Priority: "优先",
        } as Record<string, string>
      )[props.label] ?? props.label}
    </>
  );
  if (!props.description) return <button {...buttonProps}>{content}</button>;
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{content}</TooltipTrigger>
      <TooltipPopup side="top">{props.description}</TooltipPopup>
    </Tooltip>
  );
}

function SpeedControl({
  traits,
  speedSelect,
  fastToggle,
}: {
  traits: TraitsSelection;
  speedSelect: SelectDescriptor | null;
  fastToggle: BooleanDescriptor | null;
}) {
  return (
    <div className="flex w-full min-w-0 items-center justify-between gap-2">
      <span className="text-xs">响应模式</span>
      <div
        role="radiogroup"
        aria-label="响应模式"
        data-model-picker-speed-segment
        className="ms-auto flex rounded-lg bg-input/40 p-0.5"
      >
        {speedSelect
          ? selectableProviderOptionChoices(speedSelect).map((option) => (
              <SpeedSegment
                key={option.id}
                checked={option.id === traits.selectValue(speedSelect)}
                label={option.label}
                description={option.description}
                onPick={() => traits.changeSelect(speedSelect, option.id)}
              />
            ))
          : fastToggle
            ? ([false, true] as const).map((value) => (
                <SpeedSegment
                  key={String(value)}
                  checked={(fastToggle.currentValue === true) === value}
                  label={value ? "Fast" : "Standard"}
                  onPick={() => traits.changeBoolean(fastToggle.id, value)}
                />
              ))
            : null}
      </div>
    </div>
  );
}

function UltracodeControl({
  traits,
  descriptor,
}: {
  traits: TraitsSelection;
  descriptor: BooleanDescriptor;
}) {
  const on = descriptor.currentValue === true;
  return (
    <div data-model-picker-speed-segment className="flex rounded-lg bg-input/40 p-0.5">
      <button
        type="button"
        aria-pressed={on}
        data-checked={on || undefined}
        className={FOOTER_SEGMENT}
        onClick={() => traits.changeBoolean(descriptor.id, !on)}
      >
        <WorkflowIcon aria-hidden="true" className="size-3" />
        {descriptor.label}
      </button>
    </div>
  );
}

export function ComposerPickerPermissionsMenu(props: {
  runtimeMode: RuntimeMode;
  options: ReadonlyArray<RuntimeModeOption>;
  onChange: (mode: RuntimeMode) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = props.options.find((option) => option.mode === props.runtimeMode);
  if (!current) return null;
  const CurrentIcon = current.icon;
  return (
    <Menu
      onOpenChangeComplete={(open) => {
        if (open) focusCheckedPermission(triggerRef.current);
      }}
    >
      <MenuTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            data-composer-permissions-trigger
            aria-label={`Permissions: ${current.label}`}
            className="flex h-8 min-w-0 max-w-1/2 cursor-pointer items-center gap-1.5 rounded-md bg-foreground/[0.05] px-2 text-muted-foreground text-xs outline-none hover:bg-foreground/[0.09] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-foreground/[0.09] data-popup-open:text-foreground pointer-coarse:h-10"
          />
        }
      >
        <CurrentIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate">{current.label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0" />
      </MenuTrigger>
      <MenuPopup
        side="bottom"
        align="end"
        data-model-picker-option-menu
        {...composerFloatingLayerProps}
      >
        <ComposerPermissionsSection
          runtimeMode={props.runtimeMode}
          runtimeModeOptions={props.options}
          onRuntimeModeChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
}

function PickerSpeedControls({ input }: { input: TraitsSelectionInput }) {
  const traits = useTraitsSelection(input);
  const { speedSelect, fastToggle, ultracodeToggle } = splitSpeed(
    traits.selectDescriptors,
    traits.booleanDescriptors,
  );
  const selectableTier =
    speedSelect && selectableProviderOptionChoices(speedSelect).length > 0 ? speedSelect : null;
  if (traits.modelIsUnavailable || (!selectableTier && !fastToggle && !ultracodeToggle)) {
    return null;
  }
  return (
    <div
      data-model-picker-footer
      className="flex flex-wrap items-center gap-2 border-t border-border/70 px-3 py-2"
    >
      {selectableTier || fastToggle ? (
        <SpeedControl traits={traits} speedSelect={selectableTier} fastToggle={fastToggle} />
      ) : null}
      {ultracodeToggle ? <UltracodeControl traits={traits} descriptor={ultracodeToggle} /> : null}
    </div>
  );
}

export function ComposerPickerFooter({ traits }: { traits: TraitsSelectionInput | null }) {
  return traits ? <PickerSpeedControls input={traits} /> : null;
}
