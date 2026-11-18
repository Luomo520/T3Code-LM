// @effect-diagnostics nodeBuiltinImport:off - read-only local protocol log recovery.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import {
  HeaderUsageTiming,
  HEADER_USAGE_TIMING_VERSION,
  HEADER_USAGE_TIMING_BASIS,
  type HeaderStreamSample,
} from "./headerUsageTiming.ts";
import type { HeaderRequest, HeaderTurnRef } from "./headerUsageScan.ts";

import { HeaderUsageRequestTiming } from "./headerUsageRequestTiming.ts";

interface LogFile {
  path: string;
  size: number;
  mtime: number;
}
interface CachedThread {
  files: LogFile[];
  timing: HeaderUsageTiming;
  requestTiming: HeaderUsageRequestTiming;
  offset: number;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

// Only timing/counters survive parsing. Never retain or emit protocol text.
export class HeaderUsageTimingHistory {
  private readonly threads = new Map<string, CachedThread>();
  private readonly directory: string;
  private pending: Promise<void> = Promise.resolve();
  constructor(directory: string) {
    this.directory = directory;
  }

  scan(refs: readonly HeaderTurnRef[]): Promise<void> {
    this.pending = this.pending.catch(() => undefined).then(() => this.scanNow(refs));
    return this.pending;
  }

  private async scanNow(refs: readonly HeaderTurnRef[]): Promise<void> {
    const ids = new Set(refs.map((ref) => ref.threadId));
    for (const id of this.threads.keys()) if (!ids.has(id)) this.threads.delete(id);
    const names = await NodeFSP.readdir(this.directory).catch(() => [] as string[]);
    for (const id of ids) {
      // Match the logger's sanitized thread segment, never permit path traversal.
      const segment = toSafeThreadAttachmentSegment(id);
      if (!segment) continue;
      const base = `events.${segment}.log`;
      const matching = names.filter(
        (name) =>
          name === base ||
          (name.startsWith(base + ".") && /^\d+$/.test(name.slice(base.length + 1))),
      );
      matching.sort(
        (a, b) => Number(b.slice(base.length + 1) || 0) - Number(a.slice(base.length + 1) || 0),
      );
      const files: LogFile[] = [];
      for (const name of matching) {
        const path = NodePath.join(this.directory, name);
        const info = await NodeFSP.stat(path).catch(() => null);
        if (info?.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
      }
      let cached = this.threads.get(id);
      if (cached && JSON.stringify(files) === JSON.stringify(cached.files)) continue;
      const oldLast = cached?.files.at(-1);
      const last = files.at(-1);
      const append =
        cached &&
        oldLast &&
        last &&
        oldLast.path === last.path &&
        last.size > oldLast.size &&
        JSON.stringify(files.slice(0, -1)) === JSON.stringify(cached.files.slice(0, -1));
      if (!append)
        cached = {
          files: [],
          timing: new HeaderUsageTiming(),
          requestTiming: new HeaderUsageRequestTiming(),
          offset: 0,
        };
      try {
        for (const file of append ? files.slice(-1) : files) {
          cached!.offset = await this.read(
            file.path,
            cached!.timing,
            cached!.requestTiming,
            append ? cached!.offset : 0,
          );
        }
        cached!.files = files;
        this.threads.set(id, cached!);
      } catch {
        // Rotation/read races must not publish a partly replayed measurement.
        this.threads.delete(id);
      }
    }
  }

  lookup(
    request: Pick<HeaderRequest, "sessionId" | "headerTurnId" | "totals">,
  ): HeaderStreamSample | null {
    let match: HeaderStreamSample | null = null;
    for (const thread of this.threads.values()) {
      const sample = thread.timing.lookup(request);
      if (sample) {
        if (match) return null;
        match = sample;
      }
    }
    return match;
  }

  lookupRequest(
    request: Pick<HeaderRequest, "sessionId" | "headerTurnId" | "totals">,
  ): HeaderStreamSample | null {
    let match: HeaderStreamSample | null = null;
    for (const thread of this.threads.values()) {
      const sample = thread.requestTiming.lookup(request);
      if (sample) {
        if (match) return null;
        match = sample;
      }
    }
    return match;
  }

  private async read(
    path: string,
    timing: HeaderUsageTiming,
    requestTiming: HeaderUsageRequestTiming,
    start: number,
  ): Promise<number> {
    let offset = start;
    let consumed = start;
    let pending = Buffer.alloc(0);
    let dropping = false;
    for await (const chunk of NodeFS.createReadStream(path, { start }) as AsyncIterable<Buffer>) {
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(cursor, end);
        if (!dropping) {
          if (pending.length + part.length > 8 * 1024 * 1024) {
            const prefix = pending.length ? pending.subarray(0, 256) : part.subarray(0, 256);
            if (prefix.toString("utf8").includes("] NTIVE: ")) requestTiming.invalidatePending();
            pending = Buffer.alloc(0);
            dropping = true;
          } else pending = Buffer.concat([pending, part]);
        }
        consumed += end - cursor + (newline === -1 ? 0 : 1);
        if (newline !== -1) {
          if (!dropping) this.observe(pending.toString("utf8"), timing, requestTiming);
          pending = Buffer.alloc(0);
          dropping = false;
          offset = consumed;
        }
        cursor = end + 1;
      }
    }
    return offset;
  }

  private observe(
    line: string,
    timing: HeaderUsageTiming,
    requestTiming: HeaderUsageRequestTiming,
  ): void {
    const match = /^\[([^\]]+)\] NTIVE: (\{.*\})$/.exec(line.trimEnd());
    if (!match) {
      if (line.includes("] NTIVE: ")) requestTiming.invalidatePending();
      return;
    }
    const now = Date.parse(match[1]!);
    if (!Number.isFinite(now)) {
      requestTiming.invalidatePending();
      return;
    }
    try {
      const root = object(JSON.parse(match[2]!));
      if (
        root.provider !== "codex" ||
        root.protocol !== "codex.app-server" ||
        root.kind !== "protocol"
      )
        return;
      const event = object(root.event);
      // Boundary replay is explicitly an estimate; it never upgrades missing v2 text evidence.
      requestTiming.observe(
        { direction: String(event.direction), stage: String(event.stage), payload: event.payload },
        now,
      );
      const saved = object(root.headerUsageTiming);
      // V1 stored neither coverage nor delivery-quality evidence. Its speed
      // cannot be upgraded by inference from the item boundary timestamps.
      const sample =
        saved.version === HEADER_USAGE_TIMING_VERSION && saved.basis === HEADER_USAGE_TIMING_BASIS
          ? (saved.sample ?? null)
          : null;
      timing.observe(
        { direction: String(event.direction), stage: String(event.stage), payload: event.payload },
        now,
        sample,
      );
    } catch {
      requestTiming.invalidatePending();
      /* Corrupt protocol lines invalidate pending estimated intervals. */
    }
  }
}
