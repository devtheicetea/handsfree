import { watch, openSync, readSync, closeSync, statSync, readdirSync, existsSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import type { HistoryItem } from "./sessionHistory.js";
import { parseHistory } from "./sessionHistory.js";
import { parseCodexHistory, defaultCodexHome } from "./stores/codex.js";
import { cwdFromText, defaultClaudeHome } from "./projects.js";
import type { AgentName } from "./backends/types.js";

export interface WatcherEvent {
  agent: AgentName;
  projectPath: string;
  sessionId: string;
  items: HistoryItem[];
  lastActive: number;
  /** A live bridge session is writing this file — its turns already reach the client. */
  owned: boolean;
}

export interface SessionWatcherDeps {
  claudeHome?: string;
  codexHome?: string;
  ownsSession: (agent: AgentName, sessionId: string) => boolean;
  onEvent: (e: WatcherEvent) => void;
  log?: (msg: string) => void;
  debounceMs?: number;
}

interface FileState {
  offset: number;
  /** Trailing bytes after the last newline, kept until the line completes. */
  partial: string;
  /** Cached once resolution SUCCEEDS. Failures are retried on the next event —
   *  a new file's first watch event can fire before its meta line is flushed. */
  meta: { sessionId: string; projectPath: string } | undefined;
}

/**
 * Watches both agents' session directories and emits HistoryItems parsed from
 * APPENDED lines only (per-file byte offsets; existing content is baselined at
 * start — history snapshots are the stores' job). One instance per BridgeServer.
 * Mirroring granularity is per completed message: the CLIs persist whole
 * messages per line, never token streams.
 */
export class SessionWatcher {
  private readonly claudeRoot: string;
  private readonly codexRoot: string;
  private readonly deps: SessionWatcherDeps;
  private readonly debounceMs: number;
  private readonly files = new Map<string, FileState>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private watchers: FSWatcher[] = [];
  private readonly log: (msg: string) => void;

  constructor(deps: SessionWatcherDeps) {
    this.deps = deps;
    this.claudeRoot = join(deps.claudeHome ?? defaultClaudeHome(), "projects");
    this.codexRoot = join(deps.codexHome ?? defaultCodexHome(), "sessions");
    this.debounceMs = deps.debounceMs ?? 200;
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    this.baseline(this.claudeRoot);
    this.baseline(this.codexRoot);
    for (const [agent, root] of [["claude", this.claudeRoot], ["codex", this.codexRoot]] as const) {
      if (!existsSync(root)) continue;
      try {
        const w = watch(root, { recursive: true }, (_ev, filename) => {
          if (!filename || !filename.toString().endsWith(".jsonl")) return;
          this.schedule(agent, join(root, filename.toString()));
        });
        w.on("error", (err) => this.log(`watcher(${agent}): ${String(err)}`));
        this.watchers.push(w);
      } catch (err) {
        this.log(`watcher(${agent}) failed to start: ${String(err)}`); // degrade silently
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Record current sizes so pre-existing content is never emitted. */
  private baseline(root: string): void {
    if (!existsSync(root)) return;
    const walk = (dir: string): void => {
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const entry of entries) {
        const p = join(dir, entry);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p);
        else if (entry.endsWith(".jsonl")) this.files.set(p, { offset: st.size, partial: "", meta: undefined });
      }
    };
    walk(root);
  }

  private schedule(agent: AgentName, file: string): void {
    const existing = this.timers.get(file);
    if (existing) clearTimeout(existing);
    this.timers.set(file, setTimeout(() => {
      this.timers.delete(file);
      try { this.process(agent, file); } catch (err) { this.log(`watcher process ${file}: ${String(err)}`); }
    }, this.debounceMs));
  }

  private process(agent: AgentName, file: string): void {
    let st; try { st = statSync(file); } catch { return; } // deleted/renamed — ignore
    const state = this.files.get(file) ?? { offset: 0, partial: "", meta: undefined };
    this.files.set(file, state);
    if (st.size < state.offset) { // truncation/rewrite: re-baseline silently
      state.offset = st.size;
      state.partial = "";
      return;
    }
    if (st.size === state.offset) return;
    const chunk = this.read(file, state.offset, st.size - state.offset);
    if (chunk === null) return;
    state.offset = st.size;
    const text = state.partial + chunk;
    const nl = text.lastIndexOf("\n");
    if (nl < 0) { state.partial = text; return; } // no complete line yet
    state.partial = text.slice(nl + 1);
    const complete = text.slice(0, nl + 1);

    if (state.meta === undefined) state.meta = this.resolve(agent, file) ?? undefined;
    if (!state.meta) return; // not (yet) resolvable — skip silently, retry next event

    const items = agent === "codex" ? parseCodexHistory(complete, 1000) : parseHistory(complete, 1000);
    if (items.length === 0) return;
    this.deps.onEvent({
      agent,
      projectPath: state.meta.projectPath,
      sessionId: state.meta.sessionId,
      items,
      lastActive: st.mtimeMs,
      owned: this.deps.ownsSession(agent, state.meta.sessionId),
    });
  }

  private read(file: string, offset: number, length: number): string | null {
    try {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(length);
        const n = readSync(fd, buf, 0, length, offset);
        return buf.subarray(0, n).toString("utf8");
      } finally { closeSync(fd); }
    } catch { return null; }
  }

  /** Read the file head up to (and incl.) the first newline, growing in chunks.
   *  Real codex session_meta lines run ~22KB (embedded base_instructions), so a
   *  fixed small head read silently fails to resolve real files. Capped at 256KB. */
  private readHead(file: string, cap = 256 * 1024): string | null {
    const step = 64 * 1024;
    const parts: Buffer[] = [];
    try {
      const fd = openSync(file, "r");
      try {
        for (let offset = 0; offset < cap; offset += step) {
          const buf = Buffer.alloc(step);
          const n = readSync(fd, buf, 0, step, offset);
          if (n <= 0) break;
          const part = buf.subarray(0, n);
          parts.push(part);
          if (n < step || part.includes(0x0a)) break; // EOF or newline reached
        }
      } finally { closeSync(fd); }
    } catch { return null; }
    if (parts.length === 0) return null;
    // Decode ONCE so multi-byte UTF-8 characters straddling chunk boundaries survive.
    return Buffer.concat(parts).toString("utf8");
  }

  /** Resolve (sessionId, projectPath) for a file from its head. */
  private resolve(agent: AgentName, file: string): { sessionId: string; projectPath: string } | null {
    if (agent === "codex") {
      // session_meta is the FIRST line; readHead grows until its newline.
      const head = this.readHead(file);
      if (head === null) return null;
      const nl = head.indexOf("\n");
      const first = (nl >= 0 ? head.slice(0, nl) : head).trim();
      try {
        const o = JSON.parse(first) as { type?: string; payload?: { id?: unknown; cwd?: unknown } };
        if (o.type === "session_meta" && typeof o.payload?.id === "string" && typeof o.payload?.cwd === "string") {
          return { sessionId: o.payload.id, projectPath: o.payload.cwd };
        }
      } catch { /* fallthrough */ }
      return null;
    }
    // claude: filename is the session id; the cwd appears on SOME early line
    // (metadata lines precede it), so scan a generous bounded head.
    const base = file.slice(file.lastIndexOf("/") + 1);
    if (!base.endsWith(".jsonl")) return null;
    const sessionId = base.slice(0, -".jsonl".length);
    const head = this.read(file, 0, 256 * 1024);
    if (head === null) return null;
    const cwd = cwdFromText(head); // tolerates a truncated trailing line
    return cwd ? { sessionId, projectPath: cwd } : null;
  }
}
