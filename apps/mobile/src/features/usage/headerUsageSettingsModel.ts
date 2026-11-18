import type { ProviderDriverKind, ProviderInstanceConfig } from "@t3tools/contracts";

export const DEFAULT_BILLING_URL = "https://telangpuai.com/";

export type BillingSource = "environment" | "ccSwitch";

export function usageSettingsBillingSource(
  driver: ProviderDriverKind,
  value: unknown,
): BillingSource {
  return driver === "codex" && usageSettingsFields(value).billingSource === "ccSwitch"
    ? "ccSwitch"
    : "environment";
}

export function usageSettingsFields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Complete the known Sub2API endpoint locally, without probing or sending a Key. */
export function normalizeBillingUrl(input: string): string {
  const text = input.trim() || DEFAULT_BILLING_URL;
  if (/[\s\0]/.test(text) || text.includes("#")) {
    throw new Error("网址不能包含空格、换行或 # 片段。");
  }
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `https://${text}`);
  } catch {
    throw new Error("请输入有效的域名或 HTTPS 查询网址。");
  }
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("查询网址须使用 HTTPS，且不能包含账号或密码。");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/usage") ? path : path.replace(/\/v1$/, "") + "/v1/usage";
  return url.toString();
}

export function buildUsageSettingsInstance(input: {
  readonly instance: ProviderInstanceConfig | undefined;
  readonly driver: ProviderDriverKind;
  readonly url: string;
  readonly key: string;
  readonly seconds: "30" | "60";
  readonly clear: boolean;
  readonly billingSource?: BillingSource;
}): ProviderInstanceConfig {
  const config = { ...usageSettingsFields(input.instance?.config) };
  const driver = input.instance?.driver ?? input.driver;
  const previousSource = usageSettingsBillingSource(driver, config);
  const source = input.billingSource ?? previousSource;
  if (input.clear) {
    delete config.billingUrl;
    delete config.billingKey;
    delete config.billingRefreshSeconds;
    if (driver === "codex") delete config.billingSource;
  } else if (driver === "codex" && source === "ccSwitch") {
    // These remain the manual credentials; the server resolves CC Switch separately.
    // Ignore inactive drafts, including malformed URLs/Keys, rather than retargeting them.
    config.billingSource = "ccSwitch";
    config.billingRefreshSeconds = input.seconds;
  } else {
    const savedUrl =
      typeof config.billingUrl === "string" && config.billingUrl
        ? config.billingUrl
        : DEFAULT_BILLING_URL;
    const restoringManual = previousSource === "ccSwitch" && !input.key && input.url === savedUrl;
    if (driver === "codex" && input.billingSource !== undefined) {
      config.billingSource = "environment";
    }
    // Switching back restores the exact legacy configuration, including environment-only
    // accounts. Only an edited manual draft needs URL/Key validation.
    if (!restoringManual) {
      config.billingUrl = normalizeBillingUrl(input.url);
      if (/[\r\n\0]/.test(input.key) || (input.key && !input.key.trim())) {
        throw new Error("Key 无效，请检查是否包含换行或仅有空格。");
      }
      if (!input.key && !config.billingKey) {
        throw new Error("请填写查询 Key；已保存 Key 时可留空保留。");
      }
    }
    config.billingRefreshSeconds = input.seconds;
    if (input.key) config.billingKey = input.key;
  }
  // Default providers may be implicit: materialize only this instance on first save.
  return { ...(input.instance ?? { driver: input.driver }), config };
}
