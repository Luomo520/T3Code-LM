import { useAtom, useAtomValue } from "@effect/atom-react";
import { serverUpdateDownloadPercent } from "@t3tools/client-runtime/state/server";
import { Progress } from "../../components/ui/Progress";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Linking, View } from "react-native";

import { ENVIRONMENT_RELEASES_PAGE_URL } from "./environment-maintenance";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import {
  describeOutdatedServer,
  serverEnvironment,
  updateOutdatedServer,
} from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  environmentReleaseCheckAtom,
  releaseCheckError,
  releaseCheckValue,
} from "./environmentUpdateCheck";

export function OutdatedServerUpdateSection({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const describe = useAtomCommand(describeOutdatedServer, { reportFailure: false });
  const update = useAtomCommand(updateOutdatedServer, { reportFailure: false });
  const state = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const [checkResult, startCheck] = useAtom(environmentReleaseCheckAtom(environmentId));
  const release = releaseCheckValue(checkResult);
  const checking = checkResult.waiting;
  // Starting an update replaces a failed check's message with the update's own state.
  const [checkErrorDismissed, setCheckErrorDismissed] = useState(false);
  const error = checkErrorDismissed ? null : releaseCheckError(checkResult);
  const busy = checking || state.status === "running";
  const percent = state.status === "running" ? serverUpdateDownloadPercent(state) : undefined;

  function check() {
    if (busy) return;
    setCheckErrorDismissed(false);
    startCheck({
      readServerVersion: async () => {
        const description = await describe(environmentId);
        if (AsyncResult.isFailure(description)) throw squashAtomCommandFailure(description);
        return description.value.serverVersion;
      },
    });
  }

  function requestUpdate() {
    const targetVersion = release?.targetVersion;
    if (busy || !release || !targetVersion) return;
    Dialog.alert(
      `Update ${label}?`,
      `Install T3 Code ${targetVersion}. T3 Code restarts on that machine and reconnects. Running threads may be interrupted.`,
      [
        { text: "取消", style: "cancel" },
        {
          text: "更新",
          onPress: () => {
            setCheckErrorDismissed(true);
            void update({
              environmentId,
              input: { targetVersion },
              fromVersion: release.fromVersion,
            });
          },
        },
      ],
    );
  }

  return (
    <SettingsSection title="T3 Code">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">
          {release ? `版本 ${release.fromVersion}` : "服务端版本信息待检查"}
        </Text>
        <Text className="text-sm text-foreground-muted">
          {state.status === "running"
            ? state.stage === "resuming"
              ? "Restarting and reconnecting…"
              : state.stage === "installing"
                ? "Installing update…"
                : `正在下载服务端更新…${percent === undefined ? "" : ` ${Math.floor(percent)}%`}`
            : release
              ? release.targetVersion
                ? `Version ${release.targetVersion} is available.`
                : release.manualCheckRequired
                  ? "此环境无法确认适用更新，请查看发布页手动核对。"
                  : "未发现适用于此环境的更新。"
              : "此环境使用旧协议。可查看对应平台发布包，由你决定是否更新。"}
        </Text>
        {state.status === "running" && state.stage === "downloading" ? (
          <Progress
            label="服务端更新下载进度"
            {...(percent === undefined ? {} : { value: percent / 100 })}
          />
        ) : null}
        {error || state.status === "failed" ? (
          <Text selectable accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error ?? (state.status === "failed" ? state.message : null)}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="arrow.clockwise"
        label="检查更新"
        disabled={busy}
        loading={checking}
        onPress={check}
      />
      {release?.manualCheckRequired ? (
        <SettingsActionRow
          icon="arrow.up.right"
          label="查看 GitHub 发布页"
          onPress={() =>
            void Linking.openURL(ENVIRONMENT_RELEASES_PAGE_URL).catch(() =>
              Dialog.alert("无法打开发布页", "请检查网络后重试。"),
            )
          }
        />
      ) : null}
      {release?.targetVersion ? (
        <SettingsActionRow
          icon="arrow.up.circle"
          label={state.status === "failed" ? "Retry update" : `Update to ${release.targetVersion}`}
          disabled={busy}
          loading={state.status === "running"}
          onPress={requestUpdate}
        />
      ) : null}
    </SettingsSection>
  );
}
