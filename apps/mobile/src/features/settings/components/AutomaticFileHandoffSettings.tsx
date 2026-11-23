import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";

import * as Dialog from "../../../components/ui/Dialog";
import { supportsAutomaticFileHandoff } from "../../../lib/systemFileDownload";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import {
  automaticFileHandoffEnabled,
  automaticFileHandoffPreferencePatch,
} from "../../files/automatic-file-handoff-preferences";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

export function AutomaticFileHandoffSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const stored = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  if (!supportsAutomaticFileHandoff()) return null;

  const value = AsyncResult.isSuccess(stored)
    ? automaticFileHandoffEnabled(stored.value, environmentId)
    : true;
  return (
    <SettingsSection title="会话文件">
      <SettingsSwitchRow
        label="自动接收会话文件"
        subtitle="自动保存在此环境的会话中发给这台设备的文件。关闭后可在原会话手动保存。"
        value={value}
        disabled={!AsyncResult.isSuccess(stored)}
        onValueChange={(enabled) => {
          void save({
            transform: (current) =>
              automaticFileHandoffPreferencePatch(current, environmentId, enabled),
          }).then((result) => {
            if (Exit.isFailure(result)) Dialog.alert("无法保存自动接收设置，请重试。");
          });
        }}
      />
    </SettingsSection>
  );
}
