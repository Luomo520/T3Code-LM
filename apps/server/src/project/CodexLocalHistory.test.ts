// @effect-diagnostics nodeBuiltinImport:off - native SQLite WAL fixture and its scoped temporary files.
import { describe, expect, it } from "@effect/vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProviderInstanceId } from "@t3tools/contracts";
import { parseAgentSessionTranscript } from "./AgentSessionScanner.ts";
import {
  codexTitle,
  findAppendStart,
  parseHistoryItems,
  readLocalCodexMessages,
  readLocalCodexArchiveStates,
  readLocalCodexRollout,
  readLocalCodexVersion,
} from "./CodexLocalHistory.ts";

const msg = (role: "user" | "assistant", text: string) => ({ role, text });
describe("Codex local history", () => {
  it("reads exact archive states independently of catalog age, pages, and missing ids", async () => {
    const home = await mkdtemp(
      join(process.env.T3_LOCAL_SYNC_TEST_TMP ?? tmpdir(), "codex-archive-"),
    );
    const db = new DatabaseSync(join(home, "state_5.sqlite"));
    try {
      db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,archived_at INTEGER)");
      const insert = db.prepare("INSERT INTO threads VALUES (?,1,1)");
      const ids = Array.from({ length: 405 }, (_, index) => `old-thread-${index}`);
      for (const id of ids) insert.run(id);
      const rows = await readLocalCodexArchiveStates(home, [...ids, "missing"]);
      expect(rows).toHaveLength(ids.length);
      expect(rows.every((row) => row.archived === 1 && row.archived_at === 1)).toBe(true);
      db.exec("UPDATE threads SET archived=0,archived_at=NULL WHERE id='old-thread-404'");
      expect(await readLocalCodexArchiveStates(home, ["old-thread-404", "missing"])).toEqual([
        { id: "old-thread-404", archived: 0, archived_at: null },
      ]);
      expect(await readLocalCodexArchiveStates(home, [])).toEqual([]);
    } finally {
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("streams large tool payloads, preserves native ids, and rejects wrong or unfinished rollouts", async () => {
    const home = await mkdtemp(
      join(process.env.T3_LOCAL_SYNC_TEST_TMP ?? tmpdir(), "codex-rollout-"),
    );
    const file = join(home, "session.jsonl");
    const row = {
      id: "session",
      cwd: home,
      name: null,
      title: "Test",
      first_user_message: "Question",
      model: null,
      created_at: 1,
      updated_at: 2,
      history_mode: "paginated",
      rollout_path: file,
    };
    const records = [
      { type: "session_meta", payload: { id: row.id, cwd: home } },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "u1",
          role: "user",
          content: [{ type: "input_text", text: "Question" }],
        },
      },
      {
        type: "response_item",
        payload: { type: "function_call_output", output: "x".repeat(33 * 1024 * 1024) },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "a1",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      },
    ];
    const contents = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try {
      await writeFile(file, contents);
      expect((await readLocalCodexRollout(row)).map((m) => [m.nativeId, m.role, m.text])).toEqual([
        ["u1", "user", "Question"],
        ["a1", "assistant", "Answer"],
      ]);
      expect(await readLocalCodexRollout({ ...row, id: "other-session" })).toEqual([]);
      expect(await readLocalCodexRollout({ ...row, cwd: home + "-other" })).toEqual([]);
      await writeFile(
        file,
        contents + JSON.stringify({ type: "event_msg", payload: { type: "task_started" } }) + "\n",
      );
      expect(await readLocalCodexRollout(row)).toEqual([]);
      await writeFile(file, contents + '{"type":');
      expect(await readLocalCodexRollout(row)).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  it("preserves the middle of a legacy conversation beyond the recent-import window", () => {
    const contents = [
      JSON.stringify({ type: "session_meta", payload: { id: "legacy" } }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "user_message", message: "First prompt" },
      }),
      ...Array.from({ length: 250 }, (_, index) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `Answer ${index}` }],
          },
        }),
      ),
    ].join("\n");
    const input = {
      source: "codex" as const,
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "legacy",
      lastActiveAtMs: 1000,
      contents,
    };
    expect(parseAgentSessionTranscript(input)?.messages).toHaveLength(200);
    const all = parseAgentSessionTranscript({ ...input, maxMessages: 10001 })?.messages;
    expect(all).toHaveLength(251);
    expect(all?.[1]?.text).toBe("Answer 0");
    expect(all?.[250]?.text).toBe("Answer 249");
  });
  it("defers an active Codex turn and reads its final text after completion", async () => {
    const home = await mkdtemp(
      join(process.env.T3_LOCAL_SYNC_TEST_TMP ?? tmpdir(), "codex-history-"),
    );
    const db = new DatabaseSync(join(home, "thread_history_1.sqlite"));
    try {
      db.exec(`PRAGMA journal_mode=WAL;
        CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT);
        CREATE TABLE thread_items(thread_id TEXT,item_type TEXT,item_json TEXT,created_at_ms INTEGER,rollout_ordinal INTEGER);
        INSERT INTO thread_turns VALUES ('thread','turn',1,'inProgress');`);
      const insert = db.prepare("INSERT INTO thread_items VALUES ('thread',?,?,?,?)");
      insert.run(
        "userMessage",
        JSON.stringify({ id: "u1", content: [{ type: "text", text: "Question" }] }),
        1000,
        1,
      );
      insert.run("agentMessage", JSON.stringify({ id: "a1", text: "Partial" }), 2000, 2);
      const version = await readLocalCodexVersion(home);
      expect(() => readLocalCodexMessages(home, "thread")).toThrow("still active");
      db.exec("UPDATE thread_turns SET status='completed'");
      db.prepare("UPDATE thread_items SET item_json=? WHERE item_type='agentMessage'").run(
        JSON.stringify({ id: "a1", text: "Complete answer" }),
      );
      expect(await readLocalCodexVersion(home)).not.toBe(version);
      expect(readLocalCodexMessages(home, "thread").map((m) => m.text)).toEqual([
        "Question",
        "Complete answer",
      ]);
    } finally {
      db.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("keeps the current Codex name ahead of rollout or attachment titles", () => {
    expect(codexTitle("JK BMS display", "继续", "# Files mentioned by the user:")).toBe(
      "JK BMS display",
    );
    expect(codexTitle(null, "# Files mentioned by the user:", "Build a battery display")).toBe(
      "Build a battery display",
    );
  });
  it("does not use an attachment template, a continuation, or a credential as the title", () => {
    expect(codexTitle(null, "继续", "[Image: a.jpg]")).toBe("Codex conversation");
    expect(codexTitle("key sk-123456789012345678901234567890", "", "")).not.toContain("sk-");
  });
  it("retains user text after image and attachment context without promoting metadata", () => {
    expect(
      codexTitle(null, "[Image: shot.jpg; ref=image_1]\n看一下是因为什么 以及这里怎么填", ""),
    ).toBe("看一下是因为什么 以及这里怎么填");
    expect(
      codexTitle(
        null,
        "[File: build.txt; ref=file_1]\n<t3_context>\n<context>name: build.txt\nattachmentId: private-id</context>\n</t3_context>\n修复安卓启动错误",
        "",
      ),
    ).toBe("修复安卓启动错误");
    expect(
      codexTitle(null, "<t3_context>name: private-file</t3_context>", "构建出的app显示如上"),
    ).toBe("构建出的app显示如上");
    expect(codexTitle(null, "<t3_context>name: private-file", "")).toBe("Codex conversation");
    expect(codexTitle(null, "[Image: unfinished.jpg; ref=partial", "Valid user request")).toBe(
      "Valid user request",
    );
    expect(codexTitle(null, "[Image: x.jpg]\npassword=example-secret", "Safe request")).toBe(
      "Safe request",
    );
    expect(
      codexTitle(
        null,
        "# Files mentioned by the user:\n- private.txt\n\nExplain the build failure",
        "",
      ),
    ).toBe("Explain the build failure");
  });
  it("reads paginated history with native ids and preserves repeated messages", () => {
    const rows = [
      {
        item_type: "userMessage",
        item_json: JSON.stringify({ id: "u1", content: [{ type: "text", text: "Continue" }] }),
        created_at_ms: 1000,
      },
      {
        item_type: "agentMessage",
        item_json: JSON.stringify({ id: "a1", text: "Done" }),
        created_at_ms: 2000,
      },
      {
        item_type: "userMessage",
        item_json: JSON.stringify({ id: "u2", content: [{ type: "text", text: "Continue" }] }),
        created_at_ms: 3000,
      },
    ];
    expect(parseHistoryItems(rows).map((m) => [m.nativeId, m.role, m.text])).toEqual([
      ["u1", "user", "Continue"],
      ["a1", "assistant", "Done"],
      ["u2", "user", "Continue"],
    ]);
  });
  it("appends only the new suffix and is idempotent", () => {
    const all = [msg("user", "A"), msg("assistant", "B"), msg("user", "C"), msg("assistant", "D")];
    expect(findAppendStart(all.slice(0, 2), all)).toBe(2);
    expect(findAppendStart(all, all)).toBe(4);
    expect(findAppendStart([], all)).toBe(0);
  });
  it("matches the tail of truncated imported history", () => {
    const all = [msg("user", "A"), msg("assistant", "B"), msg("user", "C"), msg("assistant", "D")];
    expect(findAppendStart(all.slice(1, 3), all)).toBe(3);
  });
  it("defers divergent histories and ambiguous repeated tails", () => {
    expect(findAppendStart([msg("user", "Unpersisted")], [msg("user", "Other")])).toBeNull();
    expect(
      findAppendStart(
        [msg("assistant", "Done")],
        [msg("assistant", "Done"), msg("user", "Again"), msg("assistant", "Done")],
      ),
    ).toBeNull();
  });
});
