import { useState } from "react";
import { View } from "react-native";
import { MAX_ATTACHMENT_FILE_SIZE_MIB, parseAttachmentMaxFileSizeMiB } from "@t3tools/contracts";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SettingsSection } from "./SettingsSection";

export function AttachmentLimitSetting(props: {
  value: number | null;
  disabled: boolean;
  supported: boolean;
  onSave: (size: number) => void;
}) {
  const [draft, setDraft] = useState(props.value === null ? "" : String(props.value));
  const [error, setError] = useState(false);
  const save = () => {
    if (props.disabled || (props.value === null && draft.trim() === "")) return;
    const size = parseAttachmentMaxFileSizeMiB(draft);
    setError(size === null);
    if (size !== null && size !== props.value) props.onSave(size);
  };
  return (
    <SettingsSection title="附件上传">
      <View className="gap-2 px-4 py-3">
        <Text className="text-sm text-foreground">单个附件大小上限（MiB）</Text>
        <Text className="text-sm text-foreground-muted">
          {props.supported
            ? "普通文件每个 1–10240 MiB，默认 50 MiB。结束输入后保存并同步；图片上限单独计算。"
            : "请连接支持此设置的新版后台。"}
        </Text>
        <AppTextInput
          accessibilityLabel="单个附件大小上限（MiB）"
          defaultValue={draft}
          placeholder={props.value === null ? "混合" : undefined}
          editable={!props.disabled}
          keyboardType="number-pad"
          returnKeyType="done"
          onChangeText={(text) => {
            setDraft(text);
            setError(false);
          }}
          onEndEditing={save}
          className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        />
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground">
            请输入 1–{MAX_ATTACHMENT_FILE_SIZE_MIB} 之间的整数
          </Text>
        ) : null}
      </View>
    </SettingsSection>
  );
}
