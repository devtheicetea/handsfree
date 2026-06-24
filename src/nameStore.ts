import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { AgentName } from "./backends/types.js";
import { debugLog } from "./debug.js";

const DEFAULT_PATH = join(homedir(), ".handsfree", "session-names.json");

/**
 * Durable per-session custom display name, keyed by `${agent}:${sessionId}`.
 * Lets a user rename a session and have that name survive bridge restarts (the
 * derived title from the transcript is used when no custom name is set). An
 * empty name clears the custom name. Best-effort: any IO error is swallowed
 * (persistence is a convenience, never required for correctness).
 */
export class NameStore {
  private readonly path: string;
  private map: Record<string, string> = {};

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    try {
      this.map = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
    } catch {
      this.map = {};
    }
  }

  private key(agent: AgentName, sessionId: string): string {
    return `${agent}:${sessionId}`;
  }

  get(agent: AgentName, sessionId: string): string | undefined {
    return this.map[this.key(agent, sessionId)];
  }

  set(agent: AgentName, sessionId: string, name: string): void {
    const k = this.key(agent, sessionId);
    const trimmed = name.trim();
    if (trimmed) {
      if (this.map[k] === trimmed) return;
      this.map[k] = trimmed;
    } else {
      if (!(k in this.map)) return;
      delete this.map[k]; // empty -> back to the derived title
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.map, null, 2));
      debugLog("name.persist", { session: sessionId, agent, name: trimmed });
    } catch {
      /* best-effort */
    }
  }
}
