import { useState } from "react";
import { MAX_ATTACHMENT_FILE_SIZE_MIB, parseAttachmentMaxFileSizeMiB } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function LimitInput(props: {
  value: number | null;
  disabled: boolean;
  onSave: (value: number) => void;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const [error, setError] = useState(false);
  const save = () => {
    if (props.disabled || (props.value === null && draft.trim() === "")) return;
    const value = parseAttachmentMaxFileSizeMiB(draft);
    setError(value === null);
    if (value !== null && value !== props.value) props.onSave(value);
  };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Input
          size="sm"
          type="text"
          inputMode="numeric"
          className="w-28"
          aria-label="单个附件大小上限（MiB）"
          aria-invalid={error}
          aria-describedby={error ? "attachment-limit-error" : undefined}
          placeholder={props.value === null ? "混合" : undefined}
          value={draft}
          disabled={props.disabled}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(false);
          }}
          onBlur={save}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <span className="text-sm text-muted-foreground">MiB</span>
      </div>
      {error ? (
        <p id="attachment-limit-error" role="alert" className="text-xs text-destructive">
          请输入 1–{MAX_ATTACHMENT_FILE_SIZE_MIB} 之间的整数
        </p>
      ) : null}
    </div>
  );
}

export function AttachmentLimitSettingsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["attachmentMaxFileSizeMiB"]);
  const { connectedEnvironments } = useSettingsScope();
  const supported =
    connectedEnvironments.length > 0 &&
    connectedEnvironments.every(
      (entry) => entry.serverConfig?.environment.capabilities.configurableAttachmentLimit === true,
    );
  const value = mixed ? null : settings.attachmentMaxFileSizeMiB;
  return (
    <SettingsSection id="attachments" title="附件上传">
      <SettingsRow
        {...searchableSetting("attachment-file-limit")}
        serverScoped
        settingKeys={["attachmentMaxFileSizeMiB"]}
        description={
          supported
            ? "普通文件每个 1–10240 MiB，默认 50 MiB。离开输入框或按 Enter 保存，立即同步到连接的客户端；图片上限单独计算。"
            : "请先连接支持此设置的新版后台。"
        }
      >
        <LimitInput
          key={
            String(value) +
            ":" +
            connectedEnvironments.map((entry) => entry.environmentId).join(",")
          }
          value={value}
          disabled={!supported}
          onSave={(size) => updateSettings({ attachmentMaxFileSizeMiB: size })}
        />
      </SettingsRow>
    </SettingsSection>
  );
}
