import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Dialog from "../../../components/ui/Dialog";
import { readAndroidCapturePolicy, type CaptureAction } from "../../files/androidCapturePolicy";
import { localScreenCapture, type CapturePolicy } from "../../files/localScreenCapture";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";

const labels: Record<CapturePolicy, string> = {
  ask: "每次询问",
  system: "直接打开系统授权",
  deny: "禁止",
};

export function AndroidCapturePermissionsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const [, refresh] = useState(0);
  const [saving, setSaving] = useState(false);
  const native = localScreenCapture;
  if (!native?.setEnvironmentPolicy) return null;
  function choose(action: CaptureAction, title: string) {
    Dialog.alert(
      title,
      "此设置保存在本机，仅对当前后端生效。",
      (["deny", "ask", "system"] as const).map((policy) => ({
        text: labels[policy],
        onPress: () => {
          setSaving(true);
          void native!.setEnvironmentPolicy!(
            environmentId,
            action === "screenshot" ? "screenshot" : "recording",
            policy,
          )
            .then(() => refresh((version) => version + 1))
            .catch(() => Dialog.alert("设置未保存", "请重试。"))
            .finally(() => setSaving(false));
        },
      })),
      { cancelable: true },
    );
  }
  return (
    <SettingsSection
      title="会话屏幕请求"
      footer="设置会保留在这台手机上。选「直接打开系统授权」后，每次开始新的系统共享时，只需在 Android 确认共享范围。"
    >
      {(
        [
          ["screenshot", "远程截图"],
          ["record-screen", "远程录屏"],
        ] as const
      ).map(([action, title]) => (
        <SettingsRow
          key={action}
          icon="desktopcomputer"
          label={title}
          value={labels[readAndroidCapturePolicy(environmentId, action)]}
          disabled={saving}
          onPress={() => choose(action, title)}
        />
      ))}
    </SettingsSection>
  );
}
