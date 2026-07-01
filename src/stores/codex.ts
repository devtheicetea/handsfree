import { readdirSync, readFileSync, statSync, existsSync, unlinkSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HistoryItem } from "../sessionHistory.js";
import { type SessionStore, type SessionMeta, type StoreProject, truncatePreview } from "./types.js";

export function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}

// Codex injects context as user messages wrapped in these tags; they are not
// things the user said and would pollute previews/history.
const SKIP_USER_PREFIXES = ["<environment_context>", "<user_instructions>", "<turn_aborted>"];

interface CodexLine {
  type?: string;
  payload?: { type?: string; role?: string; content?: unknown; name?: unknown; id?: unknown; cwd?: unknown };
}

function blockText(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const b of content as Array<{ type?: string; text?: string }>) {
    if (b?.type === type && typeof b.text === "string") texts.push(b.text);
  }
  return texts.length ? texts.join("\n") : null;
}

/**
 * Parse a codex rollout .jsonl into the last `limit` conversation turns,
 * mirroring the Claude parser's semantics: assistant turns coalesce text and
 * collect (deduped) tool names; injected-context user messages are skipped.
 */
export function parseCodexHistory(jsonlText: string, limit: number): HistoryItem[] {
  const items: HistoryItem[] = [];
  let text: string[] = [];
  let toolSet = new Set<string>();
  let open = false;

  const flush = () => {
    if (!open) return;
    items.push({ role: "assistant", text: text.join("\n").trim(), tools: [...toolSet] });
    text = []; toolSet = new Set<string>(); open = false;
  };

  for (const raw of jsonlText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let o: CodexLine;
    try { o = JSON.parse(trimmed) as CodexLine; } catch { continue; }
    if (o.type !== "response_item" || !o.payload) continue;
    const p = o.payload;
    if (p.type === "message" && p.role === "user") {
      const t = blockText(p.content, "input_text");
      if (t === null || SKIP_USER_PREFIXES.some((s) => t.startsWith(s))) continue;
      flush();
      items.push({ role: "user", text: t, tools: [] });
    } else if (p.type === "message" && p.role === "assistant") {
      open = true;
      const t = blockText(p.content, "output_text");
      if (t) text.push(t);
    } else if (p.type === "function_call" && typeof p.name === "string") {
      open = true;
      toolSet.add(p.name);
    } else if (p.type === "local_shell_call") {
      open = true;
      toolSet.add("shell");
    }
  }
  flush();
  return items.slice(-limit);
}

/**
 * Wall-clock ms of the rollout's most recent *real* turn, or null if none.
 *
 * Mirrors `lastTurnMs` for Claude: the rollout's file mtime tracks the last *write*,
 * which is routinely a non-turn record the codex CLI appends after the final
 * message — `event_msg/token_count`, `event_msg/task_complete`, `turn_context`,
 * `response_item/reasoning` — so mtime overstates recency. Read the timestamp of the
 * last real turn instead: a `response_item` that is a (non-injected) user/assistant
 * message or a tool call — exactly what `parseCodexHistory` counts as a turn.
 */
export function lastCodexTurnMs(jsonlText: string): number | null {
  let best: number | null = null;
  for (const raw of jsonlText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let o: CodexLine & { timestamp?: unknown };
    try { o = JSON.parse(trimmed) as CodexLine & { timestamp?: unknown }; } catch { continue; }
    if (o.type !== "response_item" || !o.payload) continue;
    const p = o.payload;
    const isTool = p.type === "function_call" || p.type === "local_shell_call";
    const isAssistantMsg = p.type === "message" && p.role === "assistant";
    const isUserMsg = p.type === "message" && p.role === "user";
    if (!isTool && !isAssistantMsg && !isUserMsg) continue;
    if (isUserMsg) {
      const t = blockText(p.content, "input_text");
      if (t === null || SKIP_USER_PREFIXES.some((s) => t.startsWith(s))) continue;   // injected context, not a real turn
    }
    if (typeof o.timestamp !== "string") continue;
    const ms = Date.parse(o.timestamp);
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}

interface ScannedMeta {
  threadId: string;
  cwd: string;
  mtimeMs: number;
  file: string;
}

/** Read just the first line (the session_meta) of a possibly-huge rollout without
 *  loading the whole transcript. Codex embeds ~22KB of instructions in that line,
 *  so read a generous head; only fall back to a full read if no newline is found. */
function firstLine(file: string, headBytes = 1 << 18): string | null {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return null; }
  try {
    const buf = Buffer.allocUnsafe(headBytes);
    const n = readSync(fd, buf, 0, headBytes, 0);
    const nl = buf.indexOf(0x0a);
    if (nl >= 0 && nl < n) return buf.subarray(0, nl).toString("utf8").trim();
    if (n < headBytes) return buf.subarray(0, n).toString("utf8").trim();   // tiny file, no newline
  } catch { return null; } finally { try { closeSync(fd); } catch { /* ignore */ } }
  try { return readFileSync(file, "utf8").split("\n", 1)[0]!.trim(); } catch { return null; }
}

export class CodexStore implements SessionStore {
  constructor(private readonly codexHome = defaultCodexHome()) {}

  /** Rollout files under the codex sessions dir, newest-first. Cheap: readdir + stat, no reads. */
  private rolloutFiles(): Array<{ file: string; mtimeMs: number }> {
    const root = join(this.codexHome, "sessions");
    if (!existsSync(root)) return [];
    const files: Array<{ file: string; mtimeMs: number }> = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) files.push({ file: p, mtimeMs: st.mtimeMs });
      }
    };
    try { walk(root); } catch { /* unreadable dir -> partial results */ }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files;
  }

  /** Metadata (threadId, cwd, mtime) for every rollout, newest-first — reading
   *  only each file's first line, NOT the whole transcript. */
  private scanMeta(): ScannedMeta[] {
    const out: ScannedMeta[] = [];
    for (const { file, mtimeMs } of this.rolloutFiles()) {
      const first = firstLine(file);
      if (!first) continue;
      let metaLine: CodexLine;
      try { metaLine = JSON.parse(first) as CodexLine; } catch { continue; }
      const p = metaLine.payload;
      if (metaLine.type !== "session_meta" || typeof p?.id !== "string" || typeof p?.cwd !== "string") continue;
      out.push({ threadId: p.id, cwd: p.cwd, mtimeMs, file });
    }
    return out;
  }

  /** The rollout file for a thread id, located by filename (`rollout-<ts>-<id>.jsonl`)
   *  with a meta-scan fallback — so viewing one session reads one file, not all. */
  private fileForId(sessionId: string): string | undefined {
    for (const { file } of this.rolloutFiles()) {
      if (file.endsWith(`-${sessionId}.jsonl`)) return file;
    }
    return this.scanMeta().find((s) => s.threadId === sessionId)?.file;
  }

  private fullText(file: string): string {
    try { return readFileSync(file, "utf8"); } catch { return ""; }
  }

  /** Extract a display title from a codex rollout: first real user prompt (<=60) -> "Untitled". */
  private titleFrom(text: string): string {
    for (const raw of text.split("\n")) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      let o: CodexLine;
      try { o = JSON.parse(trimmed) as CodexLine; } catch { continue; }
      if (o.type !== "response_item" || !o.payload) continue;
      const p = o.payload;
      if (p.type === "message" && p.role === "user") {
        const t = blockText(p.content, "input_text");
        if (t === null || SKIP_USER_PREFIXES.some((s) => t.startsWith(s))) continue;
        const trimmedT = t.trim();
        if (!trimmedT) continue;
        return trimmedT.length > 60 ? trimmedT.slice(0, 60) + "…" : trimmedT;
      }
    }
    return "Untitled";
  }

  listSessions(projectPath: string): SessionMeta[] {
    return this.scanMeta()
      .filter((s) => s.cwd === projectPath)
      .map((s) => {
        const text = this.fullText(s.file);   // full read only for THIS project's own sessions
        const turns = parseCodexHistory(text, 1);
        return {
          sessionId: s.threadId,
          lastActive: lastCodexTurnMs(text) ?? s.mtimeMs,
          title: text ? this.titleFrom(text) : "Untitled",
          preview: truncatePreview(turns.length ? turns[turns.length - 1]! : null),
        };
      });
  }

  listProjects(): StoreProject[] {
    const byPath = new Map<string, StoreProject>();
    for (const s of this.scanMeta()) {
      if (byPath.has(s.cwd)) continue; // newest-first: first hit wins
      const text = this.fullText(s.file);   // one full read per project
      const turns = parseCodexHistory(text, 1);
      byPath.set(s.cwd, {
        path: s.cwd,
        lastSessionId: s.threadId,
        lastActive: lastCodexTurnMs(text) ?? s.mtimeMs,
        lastMessage: truncatePreview(turns.length ? turns[turns.length - 1]! : null),
        lastTitle: text ? this.titleFrom(text) : null,
      });
    }
    return [...byPath.values()];
  }

  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined {
    if (resume === "new") return undefined;
    if (resume === "latest") return this.scanMeta().find((s) => s.cwd === projectPath)?.threadId;
    return resume;
  }

  history(projectPath: string, resume: string, limit: number): { items: HistoryItem[]; hasMore: boolean } {
    if (resume === "new") return { items: [], hasMore: false };
    // A specific id reads ONLY that rollout (located by filename); "latest" picks
    // the project's newest thread from a cheap meta scan. Never fall back to
    // another thread for a missing id — a brand-new session has no rollout yet,
    // and on a reconnect the fallback would seed it with a different session.
    const file = resume === "latest"
      ? this.scanMeta().find((s) => s.cwd === projectPath)?.file
      : this.fileForId(resume);
    if (!file) return { items: [], hasMore: false };
    // Parse one extra turn to detect whether older history exists beyond the window
    // (drives "load earlier" pagination) without a second full parse.
    const all = parseCodexHistory(this.fullText(file), limit + 1);
    const hasMore = all.length > limit;
    return { items: hasMore ? all.slice(-limit) : all, hasMore };
  }

  deleteSession(_projectPath: string, sessionId: string): boolean {
    // Match by the authoritative session_meta id (verify before unlinking), reading
    // only first lines — not whole transcripts.
    for (const { file } of this.rolloutFiles()) {
      const first = firstLine(file);
      if (!first) continue;
      try {
        const meta = JSON.parse(first) as { type?: string; payload?: { id?: string } };
        if (meta.type === "session_meta" && meta.payload?.id === sessionId) {
          unlinkSync(file);
          return true;
        }
      } catch { continue; }
    }
    return false;
  }
}
