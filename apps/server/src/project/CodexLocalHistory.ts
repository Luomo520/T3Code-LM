// @effect-diagnostics nodeBuiltinImport:off - bounded read-only Codex SQLite adapter uses native file discovery.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as DateTime from "effect/DateTime";
import { ProviderInstanceId } from "@t3tools/contracts";
import { readAgentSessionTranscriptFile } from "./AgentSessionScanner.ts";

export interface LocalMessage {
  readonly nativeId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}
export interface HistoryRow {
  item_type: string;
  item_json: string;
  created_at_ms: number;
}

/** Restrict automatic repair to unmistakable scaffolding and placeholder titles. */
export function isRepairableCodexTitle(title: string): boolean {
  const value = title.trim();
  return (
    !value ||
    /^(?:继续|continue|Codex conversation|New (?:thread|conversation|chat)|Untitled|新会话|新对话)[.!。！\s]*$/i.test(
      value,
    ) ||
    /^(?:# Files mentioned\b|# AGENTS\b|\[(?:Image|File|Attachment):|<(?:t3_context|context|environment(?:_context)?|user_instructions|image)\b)/i.test(
      value,
    )
  );
}

export function codexTitle(name: string | null, title: string, first: string): string {
  for (const text of [name, title, first]) {
    // Context payloads contain file names, URLs, and arbitrary terminal output.
    // Discard the whole envelope, including an unfinished trailing envelope.
    const value = text
      ?.replace(/<(t3_context|context|image)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, " ")
      .replace(/\[(?:Image|File|Attachment):[^\]\r\n]*(?:\]|$)/gim, " ")
      .replace(/^# Files mentioned[^\r\n]*\r?\n[\s\S]*?(?:\r?\n\s*\r?\n|$)/gim, " ")
      .trim();
    if (!value || isRepairableCodexTitle(value)) continue;
    if (
      /\b(?:sk|sess)-[\w-]{16,}|(?:api[_ -]?key|(?:access[_ -]?)?token|password|authorization)["']?\s*[:=]\s*\S+|\bBearer\s+\S+|-----BEGIN [\w ]*PRIVATE KEY-----|https?:\/\/[^\s/]+:[^\s/]+@/i.test(
        value,
      )
    )
      continue;
    return value.replace(/\s+/g, " ").slice(0, 200);
  }
  return "Codex conversation";
}

export function parseHistoryItems(rows: ReadonlyArray<HistoryRow>): LocalMessage[] {
  return rows.flatMap((row) => {
    const item = JSON.parse(row.item_json);
    const role = row.item_type === "userMessage" ? ("user" as const) : ("assistant" as const);
    const text: string =
      role === "assistant"
        ? (item.text ?? "")
        : (item.content ?? [])
            .map((block: { type?: string; text?: string }) =>
              block.type === "text" || block.type === "inputText" ? (block.text ?? "") : "",
            )
            .filter(Boolean)
            .join("\n");
    if (!text.trim() || !item.id) return [];
    return [
      {
        nativeId: item.id,
        role,
        text,
        createdAt: DateTime.formatIso(DateTime.makeUnsafe(row.created_at_ms)),
      },
    ];
  });
}

// Match a suffix rather than message timestamps: older imports had rounded times
// and only a recent window. An ambiguous or diverging tail must wait for review.
export function findAppendStart(
  existing: ReadonlyArray<{ role: string; text: string }>,
  incoming: ReadonlyArray<{ role: string; text: string }>,
): number | null {
  if (existing.length === 0) return 0;
  const tail = existing.slice(-8);
  const matches: number[] = [];
  for (let end = tail.length; end <= incoming.length; end++) {
    if (
      tail.every((message, offset) => {
        const other = incoming[end - tail.length + offset]!;
        return message.role === other.role && message.text.trim() === other.text.trim();
      })
    )
      matches.push(end);
  }
  return matches.length === 1 ? matches[0]! : null;
}

export async function readLocalCodexRollout(row: LocalCodexThread) {
  if (!row.rollout_path) return [];
  return (
    (
      await readAgentSessionTranscriptFile({
        source: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        fallbackSessionId: row.id,
        lastActiveAtMs: row.updated_at * 1000,
        maxMessages: 10001,
        filePath: row.rollout_path,
        expectedCwd: row.cwd,
      })
    )?.messages ?? []
  );
}

export interface LocalCodexThread {
  id: string;
  cwd: string;
  name: string | null;
  title: string;
  first_user_message: string;
  model: string | null;
  created_at: number;
  updated_at: number;
  history_mode: string;
  rollout_path?: string;
}

export interface LocalCodexArchiveState {
  readonly id: string;
  readonly archived: number;
  readonly archived_at: number | null;
}

export async function readLocalCodexArchiveStates(
  home: string,
  threadIds: ReadonlyArray<string>,
): Promise<LocalCodexArchiveState[]> {
  if (!threadIds.length) return [];
  const files = await readdir(home);
  const file = files
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (!file) return [];
  const db = new DatabaseSync(join(home, file), { readOnly: true });
  try {
    const states: LocalCodexArchiveState[] = [];
    for (let start = 0; start < threadIds.length; start += 400) {
      const ids = threadIds.slice(start, start + 400);
      states.push(
        ...(db
          .prepare(
            `SELECT id,archived,archived_at FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`,
          )
          .all(...ids) as unknown as LocalCodexArchiveState[]),
      );
    }
    return states;
  } finally {
    db.close();
  }
}

/** SQLite WAL commits can follow state.updated_at, which only has second precision. */
export async function readLocalCodexVersion(
  home: string,
  rolloutPath?: string,
  rolloutOnly = false,
): Promise<string> {
  const files = rolloutOnly
    ? []
    : [join(home, "thread_history_1.sqlite"), join(home, "thread_history_1.sqlite-wal")];
  if (rolloutPath) files.push(rolloutPath);
  return (
    await Promise.all(
      files.map(async (file) => {
        try {
          const value = await stat(file, { bigint: true });
          return `${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
          throw error;
        }
      }),
    )
  ).join("|");
}

export async function readLocalCodexCatalog(
  home: string,
  nowMs: number,
): Promise<LocalCodexThread[]> {
  const files = await readdir(home);
  const file = files
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (!file) return [];
  const db = new DatabaseSync(join(home, file), { readOnly: true });
  try {
    return db
      .prepare(`SELECT id,cwd,name,title,first_user_message,model,created_at,updated_at,history_mode,rollout_path
      FROM threads WHERE archived=0 AND agent_role IS NULL AND (agent_path IS NULL OR agent_path='')
      AND updated_at >= ? ORDER BY updated_at DESC LIMIT 2000`)
      .all(Math.floor(nowMs / 1000) - 30 * 86400) as unknown as LocalCodexThread[];
  } finally {
    db.close();
  }
}

export function readLocalCodexMessages(home: string, id: string): LocalMessage[] {
  if (!existsSync(join(home, "thread_history_1.sqlite"))) return [];
  const db = new DatabaseSync(join(home, "thread_history_1.sqlite"), { readOnly: true });
  try {
    // Read the turn state and items from one snapshot. Never freeze a partial
    // assistant response into an append-only T3 history.
    db.exec("BEGIN");
    const latest = db
      .prepare(`SELECT status FROM thread_turns WHERE thread_id=?
      ORDER BY rollout_ordinal DESC LIMIT 1`)
      .get(id) as { status: string } | undefined;
    if (latest && !["completed", "failed", "interrupted"].includes(latest.status)) {
      throw new Error("Codex turn is still active");
    }
    const rows = db
      .prepare(`SELECT item_type,item_json,created_at_ms FROM thread_items
      WHERE thread_id=? AND item_type IN ('userMessage','agentMessage')
      ORDER BY rollout_ordinal,created_at_ms LIMIT 10001`)
      .all(id) as unknown as HistoryRow[];
    if (rows.length > 10000 || rows.reduce((n, r) => n + r.item_json.length, 0) > 32 * 1024 * 1024)
      throw new Error("Codex history exceeds sync budget");
    return parseHistoryItems(rows);
  } finally {
    db.close();
  }
}
