import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
// @effect-diagnostics nodeBuiltinImport:off - bounded, read-only local CC Switch snapshot; no scripts or upstream I/O.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as Toml from "effect/encoding/Toml";
import { object, usageUrl } from "./sub2api.ts";

export interface HeaderBillingSource {
  readonly sourceId: string;
  readonly sourceLabel: string;
  readonly url?: string;
  readonly key?: string;
  readonly message?: string;
}

interface CcSwitchOptions {
  readonly home: string;
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly now: () => number;
}

/** Domain-separated opaque identity, including incomplete/error states. Never publish its inputs. */
export function billingSourceId(...parts: ReadonlyArray<unknown>): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

class SourceProblem extends Schema.TaggedError<SourceProblem>()("SourceProblem", { message: Schema.String }) { static problem(message: string) { return new SourceProblem({ message }); } }

const MAX_CONFIG_BYTES = 1024 * 1024;

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    if ((await NodeFSP.stat(path)).size > MAX_CONFIG_BYTES)
      throw SourceProblem.problem("CC Switch 配置超过读取限制。");
    const value: unknown = JSON.parse(
      (await NodeFSP.readFile(path, "utf8")).replace(/^\uFEFF/, ""),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw SourceProblem.problem("CC Switch 配置格式无效。");
    return object(value);
  } catch (error) {
    if (object(error).code === "ENOENT") return {};
    if (Schema.is(SourceProblem)(error)) throw error;
    throw SourceProblem.problem("无法读取或解析 CC Switch 本地配置。");
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw SourceProblem.problem("CC Switch 当前供应商配置格式无效。");
  return object(parsed);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function enabled(value: unknown): boolean {
  return value === 1 || value === true;
}

export class CcSwitchBillingSource {
  private cached?: { due: number; value: Promise<HeaderBillingSource> };
  private readonly options: CcSwitchOptions;

  constructor(options: CcSwitchOptions) {
    this.options = options;
  }

  /** Coalesce all clients, including explicit refreshes; re-open on expiry to observe DB replacement. */
  read(): Promise<HeaderBillingSource> {
    const now = this.options.now();
    if (this.cached && now < this.cached.due) return this.cached.value;
    const entry = { due: Number.POSITIVE_INFINITY, value: this.load() };
    this.cached = entry;
    void entry.value.finally(() => {
      entry.due = this.options.now() + 2000;
    });
    return entry.value;
  }

  private async load(): Promise<HeaderBillingSource> {
    const { home, platform, environment } = this.options;
    // Headless hosts can run CC Switch Web under a different HOME from Codex.
    const configuredDirectory = text(environment.T3CODE_CC_SWITCH_HOME);
    const device = configuredDirectory || NodePath.join(home, ".cc-switch");
    let database = NodePath.join(device, "cc-switch.db");
    let identity: unknown = [database, "unresolved"];
    let sourceLabel = "CC Switch · Codex";
    try {
      if (configuredDirectory && !NodePath.isAbsolute(configuredDirectory))
        throw SourceProblem.problem("CC Switch 配置目录须为绝对路径。");
      // Tauri app_paths.json is device-local. settings/live-state stay in ~/.cc-switch
      // even when the database has moved. See official app_store.rs and live/engine.rs.
      const dataRoot =
        platform === "win32"
          ? environment.APPDATA || NodePath.join(home, "AppData", "Roaming")
          : platform === "darwin"
            ? NodePath.join(home, "Library", "Application Support")
            : environment.XDG_DATA_HOME || NodePath.join(home, ".local", "share");
      const paths = configuredDirectory
        ? {}
        : await readJson(NodePath.join(dataRoot, "com.ccswitch.desktop", "app_paths.json"));
      const override = paths.app_config_dir_override;
      if (override !== undefined && override !== null && typeof override !== "string")
        throw SourceProblem.problem("CC Switch 自定义数据库目录格式无效。");
      if (text(override)) {
        const directory = text(override).replace(/^~(?=[/\\])/, home);
        identity = ["custom-directory", directory];
        if (!NodePath.isAbsolute(directory))
          throw SourceProblem.problem("CC Switch 自定义数据库目录须为绝对路径。");
        database = NodePath.join(directory, "cc-switch.db");
      } else if (!configuredDirectory && platform === "win32" && environment.HOME) {
        // Official Windows compatibility path, only when the canonical DB is absent.
        try {
          await NodeFSP.access(database);
        } catch (error) {
          if (object(error).code !== "ENOENT") throw error;
          const legacy = NodePath.join(environment.HOME, ".cc-switch", "cc-switch.db");
          try {
            await NodeFSP.access(legacy);
            database = legacy;
          } catch (legacyError) {
            if (object(legacyError).code !== "ENOENT") throw legacyError;
          }
        }
      }
      const settings = await readJson(NodePath.join(device, "settings.json"));
      const live = await readJson(NodePath.join(device, "live-state.json"));
      identity = [database, settings.currentProviderCodex, live];
      if (live.version !== undefined && live.version !== 1)
        throw SourceProblem.problem("CC Switch 代理状态版本暂不支持。");
      const mode = object(object(live.apps).codex);
      if (mode.pending) throw SourceProblem.problem("CC Switch 正在切换供应商，请稍后重试。");
      if (
        mode.mode !== undefined &&
        mode.mode !== null &&
        mode.mode !== "direct" &&
        mode.mode !== "proxy"
      )
        throw SourceProblem.problem("CC Switch 当前路由模式暂不支持。");
      if (enabled(object(mode.stack).enabled))
        throw SourceProblem.problem("CC Switch Stack 多供应商模式不支持单账户余额查询。");
      const localCurrent = settings.currentProviderCodex;
      if (localCurrent !== undefined && localCurrent !== null && typeof localCurrent !== "string")
        throw SourceProblem.problem("CC Switch 当前供应商选择格式无效。");
      const proxy = mode.mode === "proxy";
      const pointer = proxy ? text(mode.proxy_route) : text(localCurrent);
      if (proxy && !pointer) throw SourceProblem.problem("CC Switch 代理未指定唯一供应商路由。");

      const db = new NodeSqlite.DatabaseSync(database, { readOnly: true, allowExtension: false });
      let row: Record<string, unknown>;
      try {
        db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 50; BEGIN");
        const hasProxy = db
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proxy_config'")
          .get();
        if (hasProxy) {
          const columns = db
            .prepare("PRAGMA table_info(proxy_config)")
            .all()
            .map((column) => column.name);
          if (!columns.includes("app_type"))
            throw SourceProblem.problem("CC Switch 旧版代理配置暂不支持，无法确认单一账户。");
          const proxyRows = db
            .prepare("SELECT * FROM proxy_config WHERE app_type = 'codex' LIMIT 2")
            .all();
          if (proxyRows.length > 1) throw SourceProblem.problem("CC Switch Codex 代理配置不唯一。");
          const proxyConfig = proxyRows[0] ?? {};
          if (
            (proxy || enabled(proxyConfig.enabled) || enabled(proxyConfig.live_takeover_active)) &&
            enabled(proxyConfig.auto_failover_enabled)
          )
            throw SourceProblem.problem(
              "CC Switch 自动故障转移可能使用多个账户，暂不支持单账户余额查询。",
            );
        }
        const rows = pointer
          ? db
              .prepare(
                "SELECT id, name, settings_config, meta FROM providers WHERE app_type = 'codex' AND id = ? LIMIT 2",
              )
              .all(pointer)
          : db
              .prepare(
                "SELECT id, name, settings_config, meta FROM providers WHERE app_type = 'codex' AND is_current = 1 LIMIT 2",
              )
              .all();
        identity = [database, pointer, rows];
        if (!rows.length)
          throw SourceProblem.problem(
            pointer
              ? "CC Switch 当前选择的 Codex 供应商不存在，请在 CC Switch 中重新选择。"
              : "CC Switch 未选择 Codex 默认供应商。",
          );
        if (rows.length !== 1)
          throw SourceProblem.problem("CC Switch 有多个 Codex 默认供应商，无法确认账单账户。");
        row = rows[0]!;
      } finally {
        db.close();
      }
      // Keep this row intact: never source URL/key from different rows or live proxy auth files.
      const raw = row.settings_config;
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_CONFIG_BYTES)
        throw SourceProblem.problem("CC Switch 当前供应商配置无效或超过读取限制。");
      const settingsConfig = parseObject(raw);
      const auth = parseObject(settingsConfig.auth ?? {});
      const config = settingsConfig.config;
      if (typeof config !== "string")
        throw SourceProblem.problem("CC Switch 当前 Codex 供应商缺少 TOML 配置。");
      const parsed = Result.getOrThrow(Toml.parse(config));
      if (parsed.profile) throw SourceProblem.problem("CC Switch Codex profile 覆盖暂不支持余额查询。");
      const selected = text(parsed.model_provider);
      const provider = object(object(parsed.model_providers)[selected]);
      const address = text(provider.base_url) || text(parsed.base_url);
      const key = text(auth.OPENAI_API_KEY) || text(provider.experimental_bearer_token);
      // Provider names are the only display metadata allowed out of this resolver.
      const label = text(row.name)
        .replace(/[\r\n\0]/g, " ")
        .replace(/https?:\/\/\S+/gi, "[地址]");
      sourceLabel =
        "CC Switch · " +
        (label && ![key, address].some((value) => value && label.includes(value))
          ? label.slice(0, 100)
          : "Codex");
      identity = [database, row.id, address, key, auth.auth_mode ?? "apiKey"];
      if (auth.auth_mode && auth.auth_mode !== "apikey")
        throw SourceProblem.problem(
          "CC Switch 当前 Codex 使用 OAuth 或不支持的认证方式，暂不支持 Sub2API 余额查询。",
        );
      if (!address || !key)
        throw SourceProblem.problem(
          "CC Switch 当前 Codex 供应商缺少 base URL 或 API Key；不会使用其他供应商凭据。",
        );
      if (
        /^(PROXY_MANAGED|sk-cc-switch|cc-switch)/i.test(key) ||
        /[\r\n\0]/.test(key) ||
        /^[!$]/.test(key)
      )
        throw SourceProblem.problem("CC Switch 当前凭据是代理占位或动态引用，暂不支持余额查询。");
      const url = usageUrl(address);
      if (["localhost", "127.0.0.1", "[::1]", "0.0.0.0"].includes(new URL(url).hostname))
        throw SourceProblem.problem("CC Switch 当前配置指向本地代理，无法确认实际账单上游。");
      return { sourceId: billingSourceId("ccSwitch", identity), sourceLabel, url, key };
    } catch (error) {
      const message =
        Schema.is(SourceProblem)(error)
          ? error.message
          : "无法读取 CC Switch 当前账单配置，请检查数据库、TOML、认证和访问权限。";
      return { sourceId: billingSourceId("ccSwitch", identity, message), sourceLabel, message };
    }
  }
}
