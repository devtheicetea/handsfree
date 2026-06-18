import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { PermissionModeName } from "./protocol.js";
import type { AgentName } from "./backends/types.js";
import { debugLog } from "./debug.js";

const DEFAULT_PATH = join(homedir(), ".handsfree", "modes.json");

/**
 * Durable per-session permission-mode store, keyed by `${agent}:${sessionId}`.
 * The live PermissionPolicy is the source of truth while a session runs, but it's
 * in-memory and resets to `safelist` whenever the session is torn down (disconnect
 * grace, bridge restart, sleep). This file lets a reopened/resumed session come back
 * in the mode the user last chose instead of the default. Best-effort: any IO error
 * is swallowed (persistence is a convenience, never required for correctness).
 */
export class ModeStore {
  private readonly path: string;
  private map: Record<string, PermissionModeName> = {};

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
    try {
      this.map = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, PermissionModeName>;
    } catch {
      this.map = {};
    }
  }

  private key(agent: AgentName, sessionId: string): string {
    return `${agent}:${sessionId}`;
  }

  get(agent: AgentName, sessionId: string): PermissionModeName | undefined {
    return this.map[this.key(agent, sessionId)];
  }

  set(agent: AgentName, sessionId: string, mode: PermissionModeName): void {
    const k = this.key(agent, sessionId);
    if (this.map[k] === mode) return;
    this.map[k] = mode;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.map, null, 2));
      debugLog("mode.persist", { session: sessionId, agent, mode });
    } catch {
      /* best-effort */
    }
  }
}
