import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  type DeviceUsbBindingInput,
  type DeviceUsbBindingReply,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Keyboard, View } from "react-native";

import { AppText, AppTextInput } from "../../../components/ui/AppText";
import * as Dialog from "../../../components/ui/Dialog";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { useAppActive } from "../../../lib/appState";
import { deviceEnvironment, setAndroidUsbBindingHint } from "../../../state/device";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "./SettingsSection";

type AppAction = Extract<DeviceUsbBindingInput, { _tag: "appStatus" | "offer" | "unbindApp" }>;

export function AndroidUsbBindingSettings({
  environmentId,
  connected,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const supportsBinding = useAtomValue(
    serverEnvironment.configValueAtom(environmentId),
    (config) => config?.environment.capabilities?.androidUsbBinding === true,
  );
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const command = useAtomCommand(deviceEnvironment.usbBinding, { reportFailure: false });
  const focused = useIsFocused();
  const active = useAppActive();
  const [code, setCode] = useState("");
  const [proof, setProof] = useState<string | null>(null);
  const [bound, setBound] = useState<Extract<DeviceUsbBindingReply, { _tag: "status" }> | null>(
    null,
  );
  const [busy, setBusy] = useState<AppAction["_tag"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const canBind = supportsBinding && connected && canOperate && focused && active;

  async function request(input: AppAction, quiet = false) {
    if (!canBind || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        if (!quiet) setError(String(Cause.squash(result.cause)));
      } else if (result.value._tag === "proof") {
        Keyboard.dismiss();
        setAndroidUsbBindingHint(environmentId, true);
        setProof(result.value.proof);
      } else if (result.value._tag === "status") {
        setBound(result.value);
        if (result.value.bound || input._tag === "unbindApp") setProof(null);
        if (result.value.bound || !proof) {
          setAndroidUsbBindingHint(environmentId, result.value.bound);
        }
      }
    } finally {
      inFlight.current = false;
    }
  }

  async function change(input: AppAction) {
    if (!canBind || inFlight.current) return;
    setBusy(input._tag);
    setError(null);
    try {
      await request(input);
    } finally {
      setBusy(null);
    }
  }

  const refresh = useEffectEvent(() => void request({ _tag: "appStatus" }, true));
  const showingProof = canBind && proof !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 仅在设置页可见时读取 USB 绑定状态
  useEffect(() => {
    if (canBind) refresh();
  }, [canBind]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 核验期间短暂刷新，确认或超时后停止
  useEffect(() => {
    if (proof === null) return;
    const expire = setTimeout(() => setProof(null), 120_000);
    return () => clearTimeout(expire);
  }, [proof]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- 仅在设置页可见时查询确认进度或解除状态
  useEffect(() => {
    if (!canBind || (!showingProof && !bound?.bound)) return;
    const poll = setInterval(refresh, showingProof ? 2_000 : 15_000);
    return () => clearInterval(poll);
  }, [bound?.bound, canBind, showingProof]);
  if (!supportsBinding || !connected || !canOperate) return null;

  return (
    <SettingsSection title="Android USB 绑定">
      {bound?.bound ? (
        <>
          <ListRowLayout label="已绑定本机 T3 App" description={bound.deviceName} />
          <ListRowLayout label="USB 主机连接" description="在电脑的真机设备面板查看。" />
          <ListActionRow
            label="解除绑定"
            loading={busy === "unbindApp"}
            tone="danger"
            onPress={() =>
              Dialog.confirm({
                title: "解除 USB 绑定？",
                message: "下次需要重新绑定，手机直接操作才会暂停远程输入。",
                confirmText: "解除绑定",
                destructive: true,
                onConfirm: () => void change({ _tag: "unbindApp" }),
              })
            }
          />
        </>
      ) : showingProof ? (
        <AppText
          accessible
          accessibilityLabel={proof}
          accessibilityLiveRegion="polite"
          importantForAccessibility="yes"
          testID="t3-usb-binding-proof"
          className="px-4 py-3 text-foreground"
        >
          手机已就绪。保持此页打开，在电脑上确认绑定。
        </AppText>
      ) : (
        <>
          <ListRowLayout
            label="绑定本机 T3 App"
            description="用 USB 连接手机，在电脑打开这台真机的设备面板并生成绑定码。"
          />
          <View className="px-4 py-2">
            <AppTextInput
              accessibilityLabel="12 位绑定码"
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-12 rounded-lg border border-border px-3 text-foreground"
              maxLength={12}
              onChangeText={(text) => setCode(text.replace(/[^0-9a-f]/giu, "").toLowerCase())}
              placeholder="12 位绑定码"
              value={code}
            />
          </View>
          <ListActionRow
            label="在这台手机确认"
            disabled={code.length !== 12}
            loading={busy === "offer"}
            onPress={() => void change({ _tag: "offer", code })}
          />
        </>
      )}
      {error ? <ListRowLayout label={error} tone="danger" /> : null}
    </SettingsSection>
  );
}
