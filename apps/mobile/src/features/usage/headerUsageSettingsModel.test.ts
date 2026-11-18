import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import {
  buildUsageSettingsInstance,
  DEFAULT_BILLING_URL,
  normalizeBillingUrl,
  usageSettingsBillingSource,
} from "./headerUsageSettingsModel";

const driver = ProviderDriverKind.make("codex");
const draft = { driver, url: "123.com", key: "test-only", seconds: "30" as const, clear: false };

describe("CC Switch billing settings", () => {
  const manual = {
    driver,
    displayName: "Synthetic Codex",
    enabled: false,
    environment: [],
    config: {
      binaryPath: "custom-codex",
      apiKey: "synthetic-model-key",
      billingUrl: "https://manual.example.test/v1/usage",
      billingKey: "synthetic-manual-key",
      billingRefreshSeconds: "60",
    },
  };
  it("enables follow mode without validating or replacing saved manual credentials", () => {
    const enabled = buildUsageSettingsInstance({
      ...draft,
      instance: manual,
      billingSource: "ccSwitch",
      url: "invalid url",
      key: "\n",
    });
    expect(enabled).toEqual({
      ...manual,
      config: { ...manual.config, billingSource: "ccSwitch", billingRefreshSeconds: "30" },
    });
    expect(usageSettingsBillingSource(driver, enabled.config)).toBe("ccSwitch");
    expect(manual.config).not.toHaveProperty("billingSource");
  });
  it("enables with no manual URL or Key and reopens the saved source", () => {
    const enabled = buildUsageSettingsInstance({
      ...draft,
      instance: undefined,
      billingSource: "ccSwitch",
      url: "invalid url",
      key: "",
    });
    expect(enabled).toEqual({
      driver,
      config: { billingSource: "ccSwitch", billingRefreshSeconds: "30" },
    });
    expect(usageSettingsBillingSource(driver, enabled.config)).toBe("ccSwitch");
    const disabled = buildUsageSettingsInstance({
      ...draft,
      instance: enabled,
      billingSource: "environment",
      url: DEFAULT_BILLING_URL,
      key: "",
    });
    expect(disabled.config).toEqual({ billingSource: "environment", billingRefreshSeconds: "30" });
    expect(usageSettingsBillingSource(driver, disabled.config)).toBe("environment");
  });
  it("turns off follow mode with the original manual URL, Key and envelope intact", () => {
    const enabled = buildUsageSettingsInstance({
      ...draft,
      instance: manual,
      billingSource: "ccSwitch",
    });
    const disabled = buildUsageSettingsInstance({
      ...draft,
      instance: enabled,
      billingSource: "environment",
      url: manual.config.billingUrl,
      key: "",
    });
    expect(disabled).toEqual({
      ...manual,
      config: { ...manual.config, billingSource: "environment", billingRefreshSeconds: "30" },
    });
    expect(usageSettingsBillingSource(driver, disabled.config)).toBe("environment");
  });
  it("can restore even an unchanged legacy malformed manual URL without blocking the switch", () => {
    const instance = {
      ...manual,
      config: { ...manual.config, billingUrl: "legacy invalid url", billingSource: "ccSwitch" },
    };
    expect(
      buildUsageSettingsInstance({
        ...draft,
        instance,
        billingSource: "environment",
        url: "legacy invalid url",
        key: "",
      }).config,
    ).toMatchObject({
      billingSource: "environment",
      billingUrl: "legacy invalid url",
      billingKey: "synthetic-manual-key",
    });
  });
  it("keeps validating newly edited manual settings after follow mode is disabled", () => {
    const instance = { ...manual, config: { ...manual.config, billingSource: "ccSwitch" } };
    expect(() =>
      buildUsageSettingsInstance({
        ...draft,
        instance,
        billingSource: "environment",
        url: "new invalid url",
        key: "",
      }),
    ).toThrow("网址");
  });
  it("keeps legacy source defaults and unchanged Key behavior", () => {
    expect(usageSettingsBillingSource(driver, manual.config)).toBe("environment");
    expect(usageSettingsBillingSource(driver, { billingSource: "future-source" })).toBe(
      "environment",
    );
    expect(
      buildUsageSettingsInstance({ ...draft, instance: manual, key: "" }).config,
    ).toMatchObject({
      billingKey: "synthetic-manual-key",
      billingUrl: "https://123.com/v1/usage",
    });
    expect(
      buildUsageSettingsInstance({ ...draft, instance: manual, key: "" }).config,
    ).not.toHaveProperty("billingSource");
  });
  it("reset removes only usage fields, disables following and ignores invalid drafts", () => {
    const instance = { ...manual, config: { ...manual.config, billingSource: "ccSwitch" } };
    const reset = buildUsageSettingsInstance({
      ...draft,
      instance,
      billingSource: "ccSwitch",
      clear: true,
      url: "invalid url",
      key: "\n",
    });
    expect(reset).toEqual({
      ...manual,
      config: { binaryPath: "custom-codex", apiKey: "synthetic-model-key" },
    });
    expect(usageSettingsBillingSource(driver, reset.config)).toBe("environment");
  });
  it("does not enable following or change legacy validation for a non-Codex instance", () => {
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const instance = { ...manual, driver: claudeDriver };
    expect(usageSettingsBillingSource(claudeDriver, { billingSource: "ccSwitch" })).toBe(
      "environment",
    );
    expect(
      buildUsageSettingsInstance({
        ...draft,
        driver: claudeDriver,
        instance,
        billingSource: "ccSwitch",
        key: "",
      }),
    ).toEqual(buildUsageSettingsInstance({ ...draft, driver: claudeDriver, instance, key: "" }));
    expect(() =>
      buildUsageSettingsInstance({
        ...draft,
        instance,
        billingSource: "ccSwitch",
        url: "invalid url",
        key: "",
      }),
    ).toThrow("网址");
  });
});

describe("manual billing settings", () => {
  it("completes domain, v1 and complete endpoint without duplicate suffixes", () => {
    for (const input of [
      "123.com",
      "123.com/",
      "123.com/v1",
      "123.com/v1/",
      "123.com/v1/usage",
      "123.com/v1/usage/",
      " https://123.com/v1 ",
    ]) {
      expect(normalizeBillingUrl(input)).toBe("https://123.com/v1/usage");
    }
    expect(normalizeBillingUrl("")).toBe("https://telangpuai.com/v1/usage");
    expect(normalizeBillingUrl("123.com/proxy/v1")).toBe("https://123.com/proxy/v1/usage");
    expect(normalizeBillingUrl("123.com/custom/usage/?scope=key")).toBe(
      "https://123.com/custom/usage?scope=key",
    );
    expect(normalizeBillingUrl("http://127.0.0.1:8888/v1")).toBe("http://127.0.0.1:8888/v1/usage");
    expect(normalizeBillingUrl("localhost:8888/v1")).toBe("https://localhost:8888/v1/usage");
  });
  it("rejects unsupported schemes, credentials, fragments and malformed addresses", () => {
    for (const input of [
      "http://123.com",
      "ftp://123.com",
      "file:///tmp",
      "https://u:p@123.com",
      "123.com/#",
      "123.com/#key",
      "not a domain",
      "https://",
      "123.com/\nusage",
      "javascript:alert(1)",
    ]) {
      expect(() => normalizeBillingUrl(input), input).toThrow();
    }
  });
  it("materializes the implicit default instance on first save", () => {
    expect(buildUsageSettingsInstance({ ...draft, instance: undefined })).toEqual({
      driver,
      config: {
        billingUrl: "https://123.com/v1/usage",
        billingKey: "test-only",
        billingRefreshSeconds: "30",
      },
    });
    expect(() => buildUsageSettingsInstance({ ...draft, instance: undefined, key: "" })).toThrow(
      "查询 Key",
    );
  });
  it("preserves model credentials and envelope, including an unchanged saved Key", () => {
    const instance: ProviderInstanceConfig = {
      driver,
      displayName: "My Codex",
      enabled: false,
      environment: [],
      config: {
        apiKey: "model-test-only",
        binaryPath: "codex",
        billingKey: "saved-query-test-only",
        billingUrl: "https://old.test/v1/usage",
      },
    };
    const result = buildUsageSettingsInstance({ ...draft, instance, key: "" });
    expect(result).toMatchObject({
      driver,
      displayName: "My Codex",
      enabled: false,
      environment: [],
      config: {
        apiKey: "model-test-only",
        binaryPath: "codex",
        billingKey: "saved-query-test-only",
        billingUrl: "https://123.com/v1/usage",
      },
    });
    expect(instance.config).toMatchObject({ billingUrl: "https://old.test/v1/usage" });
  });
  it("clear removes only manual billing fields and accepts no URL or Key", () => {
    const instance = {
      driver,
      config: {
        binaryPath: "codex",
        billingUrl: "old",
        billingKey: "test-only",
        billingRefreshSeconds: "30",
      },
    };
    expect(
      buildUsageSettingsInstance({ ...draft, instance, url: "invalid", key: "\n", clear: true }),
    ).toEqual({ driver, config: { binaryPath: "codex" } });
  });
  it("does not send malformed Keys", () => {
    for (const key of [" ", "test\nkey", "test\0key"]) {
      expect(() => buildUsageSettingsInstance({ ...draft, instance: undefined, key })).toThrow(
        "Key 无效",
      );
    }
  });
});
