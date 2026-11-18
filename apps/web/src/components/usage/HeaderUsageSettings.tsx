import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useContext, useId, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope, readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  buildUsageSettingsInstance,
  DEFAULT_BILLING_URL,
  normalizeBillingUrl,
  usageSettingsFields,
  usageSettingsBillingSource,
  type BillingSource,
} from "./headerUsageSettingsModel";

function prepareSettings(input: Parameters<typeof buildUsageSettingsInstance>[0]) {
  try {
    return { instance: buildUsageSettingsInstance(input), error: null };
  } catch (error) {
    return {
      instance: null,
      error: error instanceof Error ? error.message : "配置无效，请检查后重试。",
    };
  }
}

function billingUrlPreview(url: string) {
  try {
    return `查询地址：${normalizeBillingUrl(url)}`;
  } catch {
    return "请输入有效的域名或 HTTPS 查询网址。";
  }
}

export function HeaderUsageSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly onSaved: () => void;
}) {
  const registry = useContext(RegistryContext);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canUpdate = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(props.environmentId),
  );
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const [confirmed, setConfirmed] = useState<{
    source: typeof config;
    fields: Record<string, unknown>;
  } | null>(null);
  const saved =
    confirmed?.source === config
      ? confirmed.fields
      : usageSettingsFields(config?.settings.providerInstances[props.instanceId]?.config);
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
  const id = useId();
  const disabled = !canUpdate || !canManage || saving;
  const update = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });

  async function save(clear: boolean) {
    if (
      busy.current ||
      disabled ||
      !readEnvironmentScope(props.environmentId, AuthProvidersManageScope)
    )
      return;
    // Saving only these fields on the latest instance preserves model credentials and overrides.
    const latest = registry.get(serverEnvironment.configValueAtom(props.environmentId));
    if (!latest) {
      setFeedback({ text: "尚未连接环境，无法保存。请连接后重试。", error: true });
      return;
    }
    const prepared = prepareSettings({
      instance: latest.settings.providerInstances[props.instanceId],
      driver: props.driver,
      url,
      key,
      seconds,
      clear,
      ...(props.driver === "codex" ? { billingSource } : {}),
    });
    if (!prepared.instance) {
      setFeedback({ text: prepared.error, error: true });
      return;
    }
    busy.current = true;
    setSaving(true);
    setFeedback(null);
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "upsert",
          instanceId: props.instanceId,
          instance: prepared.instance,
        },
      },
    });
    busy.current = false;
    setSaving(false);
    if (result._tag !== "Success") {
      setFeedback({ text: "保存失败或已中断，请检查连接和供应商管理权限后重试。", error: true });
      return;
    }
    setKey("");
    const fields = usageSettingsFields(result.value.providerInstances[props.instanceId]?.config);
    setConfirmed({
      source: registry.get(serverEnvironment.configValueAtom(props.environmentId)),
      fields,
    });
    setBillingSource(usageSettingsBillingSource(props.driver, fields));
    setUrl(
      typeof fields.billingUrl === "string" && fields.billingUrl
        ? fields.billingUrl
        : DEFAULT_BILLING_URL,
    );
    setSeconds(fields.billingRefreshSeconds === "30" ? "30" : "60");
    setFeedback({
      text: clear
        ? "已重置查询设置，清除手填配置并恢复环境自动查询。"
        : usageSettingsBillingSource(props.driver, fields) === "ccSwitch"
          ? "已保存：跟随 CC Switch 当前 Codex 默认供应商。"
          : "查询设置已保存。",
      error: false,
    });
    props.onSaved();
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save(false);
      }}
    >
      {props.driver === "codex" ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <label className="text-sm font-medium" htmlFor={`${id}-cc-switch`}>
              跟随 CC Switch
            </label>
            <Switch
              id={`${id}-cc-switch`}
              size="sm"
              checked={followsCcSwitch}
              onCheckedChange={(value) => {
                setBillingSource(value ? "ccSwitch" : "environment");
                setFeedback(null);
              }}
              disabled={disabled}
              aria-describedby={`${id}-cc-description`}
            />
          </div>
          <p id={`${id}-cc-description`} className="text-sm text-muted-foreground">
            余额与账单跟随当前 Codex 默认供应商。缓存与速度取自 T3。
          </p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {followsCcSwitch
          ? "跟随期间不使用手填配置，关闭后恢复。"
          : "填域名即可。网址留空使用 telangpuai.com；Key 留空保留原值，不影响模型 Key。"}
      </p>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${id}-url`}>
          余额查询网址
        </label>
        <Input
          id={`${id}-url`}
          size="compact"
          value={url}
          onValueChange={(value) => {
            setUrl(value);
            setFeedback(null);
          }}
          placeholder="https://telangpuai.com/v1/usage"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled || followsCcSwitch}
        />
        {!followsCcSwitch ? (
          <p className="break-all text-sm text-muted-foreground">{billingUrlPreview(url)}</p>
        ) : null}
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${id}-key`}>
          余额查询 Key
        </label>
        <Input
          id={`${id}-key`}
          type="password"
          size="compact"
          value={key}
          onValueChange={(value) => {
            setKey(value);
            setFeedback(null);
          }}
          placeholder={saved.billingKey ? "已保存，留空保留" : "查询 Key"}
          autoComplete="new-password"
          spellCheck={false}
          disabled={disabled || followsCcSwitch}
        />
      </div>
      <div className="space-y-1.5">
        <label className="text-sm font-medium" htmlFor={`${id}-seconds`}>
          查询间隔
        </label>
        <Select
          value={seconds}
          onValueChange={(value) => {
            if (value === "30" || value === "60") setSeconds(value);
          }}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-seconds`} size="compact">
            <SelectValue>{seconds} 秒</SelectValue>
          </SelectTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            <SelectItem value="60">60 秒</SelectItem>
            <SelectItem value="30">30 秒</SelectItem>
          </SelectPopup>
        </Select>
      </div>
      {!canUpdate || !canManage ? (
        <p className="text-sm text-muted-foreground">当前环境没有修改供应商配置的权限。</p>
      ) : null}
      {feedback ? (
        <p
          role="status"
          className={
            feedback.error ? "text-sm text-destructive-foreground" : "text-sm text-muted-foreground"
          }
        >
          {feedback.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="compact" disabled={disabled}>
          {saving ? "保存中…" : "保存查询设置"}
        </Button>
        <Button
          type="button"
          size="compact"
          variant="outline"
          disabled={disabled}
          onClick={() => void save(true)}
        >
          {props.driver === "codex" ? "重置查询设置" : "清除手填配置"}
        </Button>
      </div>
      {props.driver === "codex" ? (
        <p className="text-sm text-muted-foreground">
          重置会关闭跟随、清除手填配置，恢复环境自动查询。
        </p>
      ) : null}
    </form>
  );
}
