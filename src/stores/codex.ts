import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
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

interface ScannedRollout {
  threadId: string;
  cwd: string;
  mtimeMs: number;
  text: string;
}

export class CodexStore implements SessionStore {
  constructor(private readonly codexHome = defaultCodexHome()) {}

  /** All readable rollouts with a valid session_meta first line, newest first. */
  private scan(): ScannedRollout[] {
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

    const out: ScannedRollout[] = [];
    for (const { file, mtimeMs } of files) {
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { continue; }
      const nl = text.indexOf("\n");
      const first = (nl >= 0 ? text.slice(0, nl) : text).trim();
      if (!first) continue;
      let metaLine: CodexLine;
      try { metaLine = JSON.parse(first) as CodexLine; } catch { continue; }
      const p = metaLine.payload;
      if (metaLine.type !== "session_meta" || typeof p?.id !== "string" || typeof p?.cwd !== "string") continue;
      out.push({ threadId: p.id, cwd: p.cwd, mtimeMs, text });
    }
    return out;
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
    return this.scan()
      .filter((s) => s.cwd === projectPath)
      .map((s) => {
        const turns = parseCodexHistory(s.text, 1);
        return {
          sessionId: s.threadId,
          lastActive: s.mtimeMs,
          title: this.titleFrom(s.text),
          preview: truncatePreview(turns.length ? turns[turns.length - 1]! : null),
        };
      });
  }

  listProjects(): StoreProject[] {
    const byPath = new Map<string, StoreProject>();
    for (const s of this.scan()) {
      if (byPath.has(s.cwd)) continue; // newest-first scan: first hit wins
      const turns = parseCodexHistory(s.text, 1);
      byPath.set(s.cwd, {
        path: s.cwd,
        lastSessionId: s.threadId,
        lastActive: s.mtimeMs,
        lastMessage: truncatePreview(turns.length ? turns[turns.length - 1]! : null),
      });
    }
    return [...byPath.values()];
  }

  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined {
    if (resume === "new") return undefined;
    if (resume === "latest") return this.scan().find((s) => s.cwd === projectPath)?.threadId;
    return resume;
  }

  history(projectPath: string, resume: string, limit: number): HistoryItem[] {
    if (resume === "new") return [];
    const all = this.scan();
    const match = resume !== "latest"
      ? (all.find((s) => s.threadId === resume) ?? all.find((s) => s.cwd === projectPath))
      : all.find((s) => s.cwd === projectPath);
    return match ? parseCodexHistory(match.text, limit) : [];
  }

  deleteSession(_projectPath: string, sessionId: string): boolean {
    const root = join(this.codexHome, "sessions");
    if (!existsSync(root)) return false;
    const walk = (dir: string): boolean => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        let st;
        try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (walk(p)) return true; continue; }
        if (!(entry.startsWith("rollout-") && entry.endsWith(".jsonl"))) continue;
        let first: string;
        try {
          const text = readFileSync(p, "utf8");
          const nl = text.indexOf("\n");
          first = (nl >= 0 ? text.slice(0, nl) : text).trim();
        } catch { continue; }
        try {
          const meta = JSON.parse(first) as { type?: string; payload?: { id?: string } };
          if (meta.type === "session_meta" && meta.payload?.id === sessionId) {
            unlinkSync(p);
            return true;
          }
        } catch { continue; }
      }
      return false;
    };
    try { return walk(root); } catch { return false; }
  }
}
