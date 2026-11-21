import { useState } from "react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { composerFloatingLayerProps } from "./composerEventScope";

export interface EditableEffortDefault {
  readonly saved: string | null;
  readonly save: (value: string | null) => Promise<void>;
  readonly disabledReason?: string | undefined;
}

export function DefaultEffortMenu({
  setting,
  choices,
  valueLabel,
}: {
  setting: EditableEffortDefault;
  choices: ReadonlyArray<{ id: string; label: string }>;
  valueLabel: string;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const save = async (value: string) => {
    setSaving(true);
    setError("");
    try {
      await setting.save(value || null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Menu modal={false}>
        <MenuTrigger
          render={<button type="button" data-reasoning-default-edit data-effort-row />}
          aria-label={`默认思考强度：${valueLabel}`}
          disabled={saving || Boolean(setting.disabledReason)}
          title={setting.disabledReason ?? "修改此模型在当前环境的默认思考强度"}
        >
          {saving ? (
            "保存中…"
          ) : (
            <>
              默认：<span translate="no">{valueLabel}</span>
            </>
          )}
        </MenuTrigger>
        <MenuPopup
          align="center"
          sideOffset={4}
          data-model-picker-option-menu
          {...composerFloatingLayerProps}
        >
          <MenuRadioGroup
            aria-label="默认思考强度"
            value={choices.some((choice) => choice.id === setting.saved) ? setting.saved : ""}
            onValueChange={(value: string) => void save(value)}
          >
            {[{ id: "", label: "使用模型推荐值" }, ...choices].map((choice) => (
              <MenuRadioItem key={choice.id} value={choice.id} closeOnClick>
                <span className="flex items-center justify-between gap-3">
                  <span translate="no">{choice.label}</span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
      {error ? (
        <span role="alert" className="basis-full text-destructive">
          {error}
        </span>
      ) : null}
    </>
  );
}
