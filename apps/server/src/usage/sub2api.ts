import * as Schema from "effect/Schema";
// @effect-diagnostics globalDate:off - this Promise-based HTTP/cache helper accepts a clock for tests.
import type { HeaderUsageSummary } from "@t3tools/contracts";

export const BILLING_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
export type BillingAccount = HeaderUsageSummary["account"];

export function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function number(value: unknown, negative = false): number | null {
  return typeof value === "number" && Number.isFinite(value) && (negative || value >= 0)
    ? value
    : null;
}

export function usageUrl(address: string): string {
  const url = new URL(address.trim());
  if (
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("查询网址须使用 HTTPS，且不能包含账号、密码或片段。");
  if (!url.pathname.endsWith("/usage")) {
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1/usage";
  }
  return url.toString();
}

export function emptyAccount(
  message = "请在供应商设置填写余额查询网址与 Key。",
  seconds = 60,
): BillingAccount {
  return {
    balance: null,
    balanceKind: "unknown",
    currency: null,
    totalTokens: null,
    todayCost: null,
    readAt: null,
    stale: false,
    message,
    refreshSeconds: seconds,
  };
}

export function decodeSub2Api(value: unknown, readAt: string, seconds = 60): BillingAccount {
  const root = object(value);
  const recognized = (data: Record<string, unknown>) =>
    ["balance", "quota", "subscription", "usage", "remaining"].some((field) => field in data) ||
    (data.isValid === true && ["quota_limited", "unrestricted"].includes(String(data.mode)));
  const data = recognized(root) ? root : object(root.data);
  if (!recognized(data) || data.isValid === false) throw new Error("中转站返回了无效用量响应。");
  const usage = object(data.usage);
  const quota = object(data.quota);
  const subscription = object(data.subscription);
  const wallet =
    number(data.balance, true) ?? (data.mode === "wallet" ? number(data.remaining, true) : null);
  const quotaRemaining = number(quota.remaining);
  const subscriptionMode =
    Object.keys(subscription).length > 0 ||
    (data.mode === "unrestricted" && data.planName !== "钱包余额" && wallet === null);
  const balanceKind =
    wallet !== null
      ? "balance"
      : quotaRemaining !== null || data.mode === "quota_limited"
        ? "quota"
        : subscriptionMode
          ? "subscription"
          : "unknown";
  const balance = wallet ?? quotaRemaining ?? (subscriptionMode ? number(data.remaining) : null);
  return {
    balance,
    balanceKind,
    currency:
      typeof data.unit === "string"
        ? data.unit
        : typeof quota.unit === "string"
          ? quota.unit
          : null,
    totalTokens: number(object(usage.total).total_tokens),
    todayCost: number(object(usage.today).actual_cost),
    readAt,
    stale: false,
    refreshSeconds: seconds,
    message:
      "Total / Today 为当前 Key 的站点统计；Today 按站点当天边界，使用实际计费金额。" +
      (balanceKind === "quota"
        ? " Quota 是 Key 额度。"
        : balanceKind === "subscription"
          ? " Plan 是套餐额度。"
          : "") +
      (Object.keys(usage).length ? "" : " 站点未返回用量统计。"),
  };
}

export class BillingHttpError extends Schema.TaggedError<BillingHttpError>()("BillingHttpError", { message: Schema.String, status: Schema.Number, retryAfterMs: Schema.Number }) {
  static fromStatus(status: number, retryAfterMs: number) { return new BillingHttpError({ message: `余额查询返回 HTTP ${status}`, status, retryAfterMs }); }
}

export async function querySub2Api(
  url: string,
  key: string,
  seconds = 60,
  fetcher = fetch,
): Promise<BillingAccount> {
  if (!key || /[\r\n\0]/.test(key)) throw new Error("查询 Key 无效。");
  const response = await fetcher(usageUrl(url), {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
    redirect: "error",
    signal: AbortSignal.timeout(BILLING_TIMEOUT_MS),
  });
  if (!response.ok) {
    const retry = response.headers.get("retry-after");
    const numeric = retry === null ? NaN : Number(retry);
    const delay = Number.isFinite(numeric)
      ? numeric * 1000
      : retry
        ? Date.parse(retry) - Date.now()
        : 0;
    throw BillingHttpError.fromStatus(response.status, Math.max(0, delay || 0));
  }
  if (!response.body) throw new Error("余额查询响应为空。");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error("余额响应超过大小限制。");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return decodeSub2Api(
    JSON.parse(Buffer.concat(chunks).toString("utf8")),
    new Date().toISOString(),
    seconds,
  );
}

/** One in-flight request per account; changing a credential starts a new cache identity. */
export class BillingCache {
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  private readonly entries = new Map<
    string,
    {
      account: BillingAccount;
      due: number;
      failures: number;
      refreshAfter: number;
      pending?: Promise<void> | undefined;
    }
  >();

  read(
    identity: string,
    load: () => Promise<BillingAccount>,
    seconds: number,
    now = this.now(),
    refresh = false,
  ): BillingAccount {
    let entry = this.entries.get(identity);
    if (!entry) {
      entry = { account: emptyAccount("正在查询…", seconds), due: 0, failures: 0, refreshAfter: 0 };
      this.entries.set(identity, entry);
      if (this.entries.size > 32) this.entries.delete(this.entries.keys().next().value!);
    }
    if (
      (now >= entry.due || (refresh && entry.failures === 0 && now >= entry.refreshAfter)) &&
      !entry.pending
    ) {
      const target = entry;
      target.pending = Promise.resolve()
        .then(load)
        .then(
          (account) => {
            target.account = account;
            target.failures = 0;
            target.due = this.now() + seconds * 1000;
            // All pages and clients share this account gate; events cannot bypass it.
            target.refreshAfter = this.now() + 30_000;
          },
          (error: unknown) => {
            target.failures += 1;
            const backoff = Math.min(300_000, 60_000 * 2 ** Math.min(target.failures - 1, 3));
            target.due =
              this.now() +
              Math.max(backoff, Schema.is(BillingHttpError)(error) ? error.retryAfterMs : 0);
            target.account = {
              ...target.account,
              stale: true,
              message:
                Schema.is(BillingHttpError)(error)
                  ? error.message + "，稍后重试。"
                  : "余额查询失败，保留上次数据，稍后重试。",
            };
          },
        )
        .finally(() => {
          target.pending = undefined;
        });
    }
    return {
      ...entry.account,
      stale: entry.account.stale || (entry.account.readAt !== null && now >= entry.due),
    };
  }

  async settle(identity: string): Promise<void> {
    await this.entries.get(identity)?.pending;
  }
  async awaitIdle(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.pending));
  }
}
