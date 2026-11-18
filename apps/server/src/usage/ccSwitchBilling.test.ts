// @effect-diagnostics nodeBuiltinImport:off - disposable synthetic SQLite/filesystem fixtures, never real CC Switch state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import { ClaudeSettings, CodexSettings, HeaderUsageSummary } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { CcSwitchBillingSource } from "./ccSwitchBilling.ts";
import { BillingCache, emptyAccount, querySub2Api } from "./sub2api.ts";

const isBillingAccount = Schema.is(HeaderUsageSummary.fields.account);

function fixture() {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cc-switch-synthetic-"));
  const device = NodePath.join(home, ".cc-switch");
  NodeFS.mkdirSync(device);
  const database = NodePath.join(device, "cc-switch.db");
  const db = new NodeSqlite.DatabaseSync(database);
  db.exec(`CREATE TABLE providers (app_type TEXT, id TEXT, name TEXT, settings_config TEXT, meta TEXT, is_current INTEGER);
    CREATE TABLE proxy_config (app_type TEXT, enabled INTEGER, auto_failover_enabled INTEGER, live_takeover_active INTEGER);`);
  let now = 0;
  const environment = { APPDATA: NodePath.join(home, "appdata") };
  const options = { home, platform: "win32" as const, environment, now: () => now };
  const reader = new CcSwitchBillingSource(options);
  const json = (name: string, value: unknown) =>
    NodeFS.writeFileSync(NodePath.join(device, name), JSON.stringify(value));
  const add = (
    id: string,
    current: number,
    config: unknown = {
      auth: { OPENAI_API_KEY: `synthetic-${id}-key` },
      config: `model_provider = "active"\n[model_providers.active]\nbase_url = "https://${id}.example.test/v1"`,
    },
    app = "codex",
    meta: unknown = {},
  ) =>
    db
      .prepare("INSERT INTO providers VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        app,
        id,
        `Supplier ${id}`,
        typeof config === "string" ? config : JSON.stringify(config),
        JSON.stringify(meta),
        current,
      );
  return {
    home,
    device,
    database,
    db,
    reader,
    options,
    environment,
    json,
    add,
    advance: (ms = 2001) => {
      now += ms;
    },
    [Symbol.dispose]: () => {
      db.close();
      NodeFS.rmSync(home, { recursive: true, force: true });
    },
  };
}

it("reads both billing contracts and round-trips the shared source fields", () => {
  for (const schema of [CodexSettings, ClaudeSettings]) {
    const decode = Schema.decodeUnknownSync(schema);
    expect(decode({}).billingSource).toBeUndefined();
    for (const billingSource of ["environment", "ccSwitch"] as const) {
      const input = {
        billingSource,
        billingUrl: "https://example.test",
        billingKey: "synthetic",
        billingRefreshSeconds: "30",
      };
      expect(Schema.encodeSync(schema)(decode(input))).toMatchObject(input);
    }
    expect(() => decode({ billingSource: "other" })).toThrow();
  }
});

it("coalesces concurrent reads, caches for two seconds and follows A/B changes without restart", async () => {
  using f = fixture();
  f.add("a", 1);
  f.add("b", 0);
  f.add("claude", 1, {}, "claude");
  using open = vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare");
  const [a, concurrent] = await Promise.all([f.reader.read(), f.reader.read()]);
  expect(a).toMatchObject({
    sourceLabel: "CC Switch · Supplier a",
    url: "https://a.example.test/v1/usage",
    key: "synthetic-a-key",
  });
  expect(concurrent).toEqual(a);
  const reads = open.mock.calls.length;
  f.db.exec("UPDATE providers SET is_current = (id = 'b') WHERE app_type = 'codex'");
  for (let i = 0; i < 20; i++) expect(await f.reader.read()).toEqual(a);
  expect(open.mock.calls).toHaveLength(reads);
  f.advance();
  const b = await f.reader.read();
  expect(b.key).toBe("synthetic-b-key");
  expect(b.url).toBe("https://b.example.test/v1/usage");
  expect(b.sourceId).not.toBe(a.sourceId);
  expect(b.sourceId).toMatch(/^[a-f0-9]{64}$/);
  expect(open.mock.calls.length).toBeGreaterThan(reads);
});

it("reads a NAS CC Switch directory independently of the Codex process home", async () => {
  using processHome = fixture();
  using ccHome = fixture();
  processHome.add("wrong-account", 1);
  ccHome.add("a", 1);
  ccHome.add("b", 0);
  ccHome.json("settings.json", { currentProviderCodex: "b" });
  const reader = new CcSwitchBillingSource({
    ...processHome.options,
    platform: "linux",
    environment: { T3CODE_CC_SWITCH_HOME: ccHome.device },
  });
  expect(await reader.read()).toMatchObject({
    sourceLabel: "CC Switch · Supplier b",
    key: "synthetic-b-key",
    url: "https://b.example.test/v1/usage",
  });
});

it("refuses a relative NAS CC Switch directory instead of falling back to another account", async () => {
  using f = fixture();
  f.add("wrong-account", 1);
  const reader = new CcSwitchBillingSource({
    ...f.options,
    platform: "linux",
    environment: { T3CODE_CC_SWITCH_HOME: "relative/cc-switch" },
  });
  const result = await reader.read();
  expect(result.key).toBeUndefined();
  expect(result.message).toContain("绝对路径");
});

it("does not create or replace a missing explicit CC Switch directory", async () => {
  using f = fixture();
  f.add("wrong-account", 1);
  const directory = NodePath.join(f.home, "absent-cc-home");
  const reader = new CcSwitchBillingSource({
    ...f.options,
    platform: "linux",
    environment: { T3CODE_CC_SWITCH_HOME: directory },
  });
  const result = await reader.read();
  expect(result.key).toBeUndefined();
  expect(NodeFS.existsSync(directory)).toBe(false);
});

it("prefers settings currentProviderCodex over stale is_current and refuses a deleted local pointer", async () => {
  using f = fixture();
  f.add("a", 1);
  f.add("b", 0);
  f.json("settings.json", { currentProviderCodex: "b" });
  expect((await f.reader.read()).key).toBe("synthetic-b-key");
  f.json("settings.json", { currentProviderCodex: "deleted" });
  f.advance();
  const missing = await f.reader.read();
  expect(missing.message).toContain("不存在");
  expect(missing.key).toBeUndefined();
});

it("returns explicit missing/ambiguous selections and caches errors without returning another app", async () => {
  using f = fixture();
  f.add("claude", 1, {}, "claude");
  const none = await f.reader.read();
  expect(none.message).toContain("未选择");
  f.add("a", 1);
  f.add("b", 1);
  expect(await f.reader.read()).toEqual(none);
  f.advance();
  const ambiguous = await f.reader.read();
  expect(ambiguous.message).toContain("多个");
  expect(ambiguous.url).toBeUndefined();
  expect(ambiguous.sourceId).not.toBe(none.sourceId);
});

it("reads a relocated database from Tauri app_paths while keeping device settings at home", async () => {
  using f = fixture();
  f.add("a", 1);
  f.add("b", 0);
  const custom = NodePath.join(f.home, "custom-db");
  NodeFS.mkdirSync(custom);
  const customDb = NodePath.join(custom, "cc-switch.db");
  f.db.exec(`VACUUM INTO '${customDb.replaceAll("'", "''")}'`);
  const store = NodePath.join(f.environment.APPDATA, "com.ccswitch.desktop");
  NodeFS.mkdirSync(store, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(store, "app_paths.json"),
    JSON.stringify({ app_config_dir_override: custom }),
  );
  f.json("settings.json", { currentProviderCodex: "b" });
  const result = await f.reader.read();
  expect(result.key).toBe("synthetic-b-key");
  f.db.exec("DELETE FROM providers");
  f.advance();
  expect((await f.reader.read()).sourceId).toBe(result.sourceId);
  NodeFS.writeFileSync(
    NodePath.join(store, "app_paths.json"),
    JSON.stringify({ app_config_dir_override: NodePath.join(f.home, "missing") }),
  );
  f.advance();
  const missing = await f.reader.read();
  expect(missing.message).toBeTruthy();
  expect(missing.key).toBeUndefined();
});

it("uses the Windows legacy HOME database only when the canonical database is absent", async () => {
  using f = fixture();
  f.add("a", 1);
  const home = NodePath.join(f.home, "canonical");
  NodeFS.mkdirSync(home);
  const reader = new CcSwitchBillingSource({
    ...f.options,
    home,
    environment: { ...f.environment, HOME: f.home },
  });
  expect((await reader.read()).key).toBe("synthetic-a-key");
});

it("follows a unique proxy route from original DB credentials and rejects missing/failover/Stack routes", async () => {
  using f = fixture();
  f.add("a", 1);
  f.add("b", 0);
  f.json("settings.json", { currentProviderCodex: "a" });
  f.json("live-state.json", {
    version: 1,
    apps: { codex: { mode: "proxy", proxy_route: "b", attached: true } },
  });
  const routed = await f.reader.read();
  expect(routed.key).toBe("synthetic-b-key");
  f.db.exec("INSERT INTO proxy_config VALUES ('codex', 1, 1, 1)");
  f.advance();
  expect((await f.reader.read()).message).toContain("故障转移");
  f.db.exec("DELETE FROM proxy_config");
  for (const mode of [
    { mode: "proxy" },
    { mode: "proxy", proxy_route: "deleted" },
    { mode: "proxy", proxy_route: "b", stack: { enabled: true } },
  ]) {
    f.json("live-state.json", { version: 1, apps: { codex: mode } });
    f.advance();
    const result = await f.reader.read();
    expect(result.message).toBeTruthy();
    expect(result.key).toBeUndefined();
  }
});

it("supports legacy single-provider takeover and refuses auto failover", async () => {
  using f = fixture();
  f.add("a", 1);
  f.db.exec("INSERT INTO proxy_config VALUES ('codex', 1, 0, 1)");
  expect((await f.reader.read()).key).toBe("synthetic-a-key");
  f.db.exec("UPDATE proxy_config SET auto_failover_enabled = 1");
  f.advance();
  expect((await f.reader.read()).message).toContain("故障转移");
});

it("parses quoted TOML tables, active-provider URLs and auth JSON without consulting inactive sections or scripts", async () => {
  using f = fixture();
  f.add(
    "a",
    1,
    {
      auth: JSON.stringify({ OPENAI_API_KEY: "synthetic-quoted-key" }),
      config:
        "model_provider = 'my.provider'\nbase_url = 'https://root.example.test'\n[model_providers.other]\nbase_url = 'https://other.example.test'\n[model_providers.\"my.provider\"]\nbase_url = \"https://quoted.example.test/v1\" # comment\n",
    },
    "codex",
    { usage_script: { enabled: true, script: "throw new Error('must never execute')" } },
  );
  expect(await f.reader.read()).toMatchObject({
    key: "synthetic-quoted-key",
    url: "https://quoted.example.test/v1/usage",
  });
});

it("supports literal experimental_bearer_token only from the active provider", async () => {
  using f = fixture();
  f.add("a", 1, {
    auth: {},
    config:
      'model_provider="a"\n[model_providers.a]\nbase_url="https://a.example.test"\nexperimental_bearer_token="synthetic-token"',
  });
  expect((await f.reader.read()).key).toBe("synthetic-token");
});

it("gives each incomplete account a safe identity and never combines credentials across rows", async () => {
  using f = fixture();
  f.add("a", 1, { auth: {}, config: 'base_url="https://a.example.test"' });
  f.add("b", 0, { auth: { OPENAI_API_KEY: "synthetic-b-key" }, config: "" });
  const a = await f.reader.read();
  expect(a.message).toContain("缺少");
  expect(a.key).toBeUndefined();
  f.db.exec("UPDATE providers SET is_current = (id = 'b')");
  f.advance();
  const b = await f.reader.read();
  expect(b.message).toContain("缺少");
  expect(b.url).toBeUndefined();
  expect(b.sourceId).not.toBe(a.sourceId);
});

it.each([
  {
    auth: { auth_mode: "chatgpt", OPENAI_API_KEY: "synthetic-key" },
    config: 'base_url="https://a.example.test"',
  },
  { auth: { OPENAI_API_KEY: "PROXY_MANAGED" }, config: 'base_url="https://a.example.test"' },
  { auth: { OPENAI_API_KEY: "$SECRET" }, config: 'base_url="https://a.example.test"' },
  { auth: { OPENAI_API_KEY: "synthetic-key" }, config: 'base_url="http://127.0.0.1:15721/v1"' },
  { auth: { OPENAI_API_KEY: "synthetic-key" }, config: 'base_url="http://unsafe.example.test"' },
  {
    auth: { OPENAI_API_KEY: "synthetic-key" },
    config: 'base_url="https://a.example.test"\nbase_url="https://b.example.test"',
  },
  {
    auth: { OPENAI_API_KEY: "synthetic-key" },
    config: '[model_providers.inactive]\nbase_url="https://inactive.example.test"',
  },
  "{bad-json-synthetic-key",
])(
  "refuses unsupported/invalid Codex billing configurations without exposing configuration %#",
  async (config) => {
    using f = fixture();
    f.add("a", 1, config);
    const result = await f.reader.read();
    expect(result.message).toBeTruthy();
    expect(result.url).toBeUndefined();
    expect(result.key).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-key|unsafe\.example|a\.example|b\.example|inactive\.example|127\.0\.0/,
    );
  },
);

it("isolates billing cache by selected account, keeps 30/60-second gates, and redacts HTTP failures", async () => {
  using f = fixture();
  f.add("a", 1);
  f.add("b", 0);
  const billing = new BillingCache(f.options.now);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      Response.json({ balance: String(url).includes("a.example") ? 10 : 20 }),
    );
  const query = async (seconds: number, refresh = false) => {
    const source = await f.reader.read();
    let account = source.message
      ? emptyAccount(source.message, seconds)
      : billing.read(
          source.sourceId,
          () => querySub2Api(source.url!, source.key!, seconds, fetcher),
          seconds,
          undefined,
          refresh,
        );
    account = { ...account, sourceId: source.sourceId, sourceLabel: source.sourceLabel };
    return account;
  };
  const coldA = await query(60);
  await billing.awaitIdle();
  const a = await query(60);
  expect(coldA.balance).toBeNull();
  expect(a.balance).toBe(10);
  f.db.exec("UPDATE providers SET is_current = (id = 'b')");
  f.advance();
  const coldB = await query(30, true);
  expect(coldB.balance).toBeNull();
  expect(coldB.sourceId).not.toBe(a.sourceId);
  await billing.awaitIdle();
  const b = await query(30, true);
  expect(b.balance).toBe(20);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 10; i++) await query(30, true);
  expect(fetcher).toHaveBeenCalledTimes(2);
  f.advance(30_001);
  await query(30);
  await billing.awaitIdle();
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockRejectedValue(new Error("synthetic-b-key https://b.example.test upstream body"));
  f.advance(30_001);
  await query(30);
  await billing.awaitIdle();
  const failed = await query(30, true);
  expect(failed.balance).toBe(20);
  expect(failed.stale).toBe(true);
  expect(JSON.stringify(failed)).not.toMatch(/synthetic-b-key|https:|upstream body/);
  f.advance(30_001);
  await query(30, true);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(isBillingAccount(failed)).toBe(true);
});

it("does not create a missing database or modify source data", async () => {
  using f = fixture();
  f.add("a", 1);
  const before = NodeFS.readFileSync(f.database);
  await f.reader.read();
  expect(NodeFS.readFileSync(f.database)).toEqual(before);
  const home = NodePath.join(f.home, "missing-home");
  NodeFS.mkdirSync(home);
  const reader = new CcSwitchBillingSource({ ...f.options, home });
  expect((await reader.read()).message).toBeTruthy();
  expect(NodeFS.existsSync(NodePath.join(home, ".cc-switch", "cc-switch.db"))).toBe(false);
});
