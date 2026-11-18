import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { RadioIndicator } from "../../components/ui/RadioIndicator";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ListActionRow as SettingsActionRow } from "../../components/ui/ListActionRow";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import {
  buildUsageSettingsInstance,
  DEFAULT_BILLING_URL,
  normalizeBillingUrl,
  usageSettingsFields,
  usageSettingsBillingSource,
  type BillingSource,
} from "./headerUsageSettingsModel";

export function HeaderUsageSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly disabled: boolean;
  readonly initiallyOpen?: boolean;
  readonly onSaved?: () => void;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const [confirmed, setConfirmed] = useState<{
    source: typeof config;
    fields: Record<string, unknown>;
  } | null>(null);
  const saved =
    confirmed?.source === config
      ? confirmed.fields
      : usageSettingsFields(config?.settings.providerInstances[props.instanceId]?.config);
  const [open, setOpen] = useState(props.initiallyOpen ?? false);
  const [url, setUrl] = useState(() =>
    typeof saved.billingUrl === "string" && saved.billingUrl
      ? saved.billingUrl
      : DEFAULT_BILLING_URL,
  );
  const [key, setKey] = useState("");
  const [billingSource, setBillingSource] = useState<BillingSource>(() =>
    usageSettingsBillingSource(props.driver, saved),
  );
  const followsCcSwitch = props.driver === "codex" && billingSource === "ccSwitch";
  const [seconds, setSeconds] = useState<"30" | "60">(() =>
    saved.billingRefreshSeconds === "30" ? "30" : "60",
  );
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const busy = useRef(false);
  const update = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  function edit() {
    setUrl(
      typeof saved.billingUrl === "string" && saved.billingUrl
        ? saved.billingUrl
        : DEFAULT_BILLING_URL,
    );
    setKey("");
    setBillingSource(usageSettingsBillingSource(props.driver, saved));
    setSeconds(saved.billingRefreshSeconds === "30" ? "30" : "60");
    setOpen(true);
    setFeedback(null);
  }
  async function save(clear = false) {
    if (busy.current || props.disabled) return;
    // Read the latest instance so this form preserves model credentials and other provider fields.
    const latest = appAtomRegistry.get(serverEnvironment.configValueAtom(props.environmentId));
    if (!latest) {
      setFeedback({ text: "尚未连接环境，无法保存。请连接后重试。", error: true });
      return;
    }
    busy.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const instance = buildUsageSettingsInstance({
        instance: latest.settings.providerInstances[props.instanceId],
        driver: props.driver,
        url,
        key,
        seconds,
        clear,
        ...(props.driver === "codex" ? { billingSource } : {}),
      });
      const result = await update({
        environmentId: props.environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "upsert",
            instanceId: props.instanceId,
            instance,
          },
        },
      });
      if (result._tag === "Success") {
        const fields = usageSettingsFields(
          result.value.providerInstances[props.instanceId]?.config,
        );
        setConfirmed({
          source: appAtomRegistry.get(serverEnvironment.configValueAtom(props.environmentId)),
          fields,
        });
        setKey("");
        setBillingSource(usageSettingsBillingSource(props.driver, fields));
        setUrl(typeof fields.billingUrl === "string" ? fields.billingUrl : DEFAULT_BILLING_URL);
        setSeconds(fields.billingRefreshSeconds === "30" ? "30" : "60");
        setFeedback({
          text: clear
            ? "已重置查询设置，清除手填配置并恢复环境自动查询。"
            : usageSettingsBillingSource(props.driver, fields) === "ccSwitch"
              ? "已保存：跟随 CC Switch 当前 Codex 默认供应商。"
              : "配置已保存；余额查询结果请查看顶部统计。",
          error: false,
        });
        props.onSaved?.();
      } else {
        setFeedback({
          text: isAtomCommandInterrupted(result)
            ? "保存已中断，请重新保存。"
            : "保存失败，请检查连接和供应商管理权限后重试。",
          error: true,
        });
      }
    } catch (error) {
      setFeedback({
        text: error instanceof Error ? error.message : "保存失败，请重试。",
        error: true,
      });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  let preview: string;
  try {
    preview = followsCcSwitch
      ? "跟随期间不使用手填网址与 Key。"
      : `查询地址：${normalizeBillingUrl(url)}`;
  } catch {
    preview = "请输入有效的域名或 HTTPS 查询网址。";
  }
  const summary =
    usageSettingsBillingSource(props.driver, saved) === "ccSwitch"
      ? `已保存 · 跟随 CC Switch · ${saved.billingRefreshSeconds === "30" ? "30" : "60"} 秒`
      : saved.billingUrl
        ? `已保存 · Key ${saved.billingKey ? "已设置" : "未设置"} · ${saved.billingRefreshSeconds === "30" ? "30" : "60"} 秒`
        : "未保存手填配置 · 使用环境自动查询";
  return (
    <View>
      <SettingsActionRow
        icon="gearshape"
        label="余额查询设置"
        description={summary}
        disabled={props.disabled || saving}
        onPress={() => (open ? setOpen(false) : edit())}
      />
      {open ? (
        <View className="gap-3 px-4 pb-4">
          {props.driver === "codex" ? (
            <SettingsSwitchRow
              label="跟随 CC Switch"
              subtitle="连接电脑上的 CC Switch，余额、总用量、今日消费跟随当前 Codex 默认供应商；缓存与速度仍使用当前会话的 T3 数据。"
              value={followsCcSwitch}
              disabled={props.disabled || saving}
              onValueChange={(value) => {
                setBillingSource(value ? "ccSwitch" : "environment");
                setFeedback(null);
              }}
            />
          ) : null}
          <AppText className="text-sm text-foreground-muted">
            {followsCcSwitch
              ? "已保存的手填网址与 Key 会保留，关闭跟随后可继续使用。"
              : "域名自动补全查询地址；网址留空使用 telangpuai.com。Key 留空保留已保存值。"}
          </AppText>
          <TextInput
            accessibilityLabel="余额查询网址"
            placeholder="https://telangpuai.com/v1/usage"
            placeholderTextColorClassName="accent-foreground-muted"
            className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            value={url}
            onChangeText={(value) => {
              setUrl(value);
              setFeedback(null);
            }}
            editable={!props.disabled && !saving && !followsCcSwitch}
          />
          <AppText className="text-sm text-foreground-muted" selectable>
            {preview}
          </AppText>
          <TextInput
            accessibilityLabel="余额查询 Key"
            placeholder={saved.billingKey ? "已保存，留空保留" : "查询 Key"}
            placeholderTextColorClassName="accent-foreground-muted"
            className="rounded-lg border border-border-subtle px-3 py-2 text-foreground"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={key}
            onChangeText={(value) => {
              setKey(value);
              setFeedback(null);
            }}
            editable={!props.disabled && !saving && !followsCcSwitch}
          />
          <View className="flex-row gap-3">
            {(["60", "30"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ checked: seconds === value }}
                disabled={props.disabled || saving}
                onPress={() => {
                  setSeconds(value);
                  setFeedback(null);
                }}
                className="flex-row items-center gap-2 rounded-lg border border-border-subtle px-3 py-2"
              >
                <RadioIndicator selected={seconds === value} />
                <AppText className="text-foreground">{value} 秒</AppText>
              </Pressable>
            ))}
          </View>
          {feedback ? (
            <AppText
              accessibilityLiveRegion="polite"
              className={
                feedback.error ? "text-sm text-danger-foreground" : "text-sm text-foreground-muted"
              }
            >
              {feedback.text}
            </AppText>
          ) : null}
          <SettingsActionRow
            icon="checkmark"
            label="保存查询设置"
            loading={saving}
            disabled={props.disabled}
            onPress={() => void save()}
          />
          <SettingsActionRow
            icon="arrow.clockwise"
            label={props.driver === "codex" ? "重置查询设置" : "清除手填配置"}
            description={
              props.driver === "codex"
                ? "关闭 CC Switch 跟随，删除手填网址、查询 Key 和查询间隔，恢复环境自动查询"
                : "删除查询 Key，恢复自动查询"
            }
            disabled={props.disabled || saving}
            onPress={() => void save(true)}
          />
        </View>
      ) : null}
    </View>
  );
}
