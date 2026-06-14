import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import { PermissionPolicy, type AskRequest } from "./permissions.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import type { AgentName } from "./backends/types.js";
import type { SessionStore } from "./stores/types.js";
import { ClaudeStore } from "./stores/claude.js";
import { CodexStore } from "./stores/codex.js";
import type { BridgeToClient, ClientMessage } from "./protocol.js";

const HISTORY_LIMIT = 25;

interface LiveSession {
  session: Session;
  policy: PermissionPolicy;
  projectPath: string;
  agent: AgentName;
  resumeId: string | null;
}

export interface SessionManagerDeps {
  safelist: string[];
  makeSession?: (agent: AgentName, projectPath: string) => Session;
  stores?: { claude: SessionStore; codex: SessionStore };
  codexPath?: string | null;
}

/**
 * Owns one live Session per sessionKey (UUID). All sessions stay alive (none
 * stopped on switch); every session's output is tagged with its sessionKey
 * before reaching the client. Input messages are routed by sessionKey.
 */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly safelist: string[];
  private readonly makeSession: (agent: AgentName, projectPath: string) => Session;
  private readonly stores: { claude: SessionStore; codex: SessionStore };

  constructor(deps: SessionManagerDeps) {
    this.safelist = deps.safelist;
    const codexPath = deps.codexPath ?? null;
    this.makeSession = deps.makeSession ?? ((agent) =>
      agent === "claude"
        ? new Session(new ClaudeBackend())
        : new Session(new CodexBackend({ codexPath })));
    this.stores = deps.stores ?? { claude: new ClaudeStore(), codex: new CodexStore() };
  }

  /** Wrap a session's emit so every message is tagged with its sessionKey. */
  private tagged(sessionKey: string, emit: (m: BridgeToClient) => void) {
    return (m: BridgeToClient) => emit({ ...m, sessionKey } as BridgeToClient);
  }

  /** Build a permission_request message from a pending ask (sessionKey added by `tagged`). */
  private permissionRequestMsg(req: AskRequest): BridgeToClient {
    return {
      type: "permission_request", id: req.id, tool: req.tool, input: req.input,
      detail: req.input && typeof req.input === "object" ? `${req.tool} ${JSON.stringify(req.input).slice(0, 180)}` : req.tool,
    } as BridgeToClient;
  }

  /** Re-send any still-pending permission requests to a (re)connected client. */
  private replayPending(key: string, ls: LiveSession, emit: (m: BridgeToClient) => void): void {
    for (const req of ls.policy.pendingRequests()) {
      this.tagged(key, emit)(this.permissionRequestMsg(req));
    }
  }

  async open(projectPath: string, agent: AgentName, resume: string, nonce: string, emit: (m: BridgeToClient) => void): Promise<void> {
    const resumeId = this.stores[agent].resolveResume(projectPath, resume) ?? null;
    // Reattach a still-live session ONLY when the resumed id matches exactly
    // (reconnect path). Never match by (project, agent) — that would grab an
    // arbitrary session when several are live for the same folder/agent.
    if (resumeId) {
      for (const [key, ls] of this.sessions) {
        if (ls.resumeId === resumeId && ls.session.isActive()) {
          emit({ type: "session_started", nonce, sessionKey: key, projectPath, agent, resumeId, mode: ls.policy.getMode() });
          // The client may have restarted and lost all local state (it seeds
          // history only into an empty conversation), so re-send the snapshot —
          // and do it BEFORE reattach's buffer replay, or the replayed turn
          // would make the conversation non-empty and the seed would be skipped.
          this.tagged(key, emit)({ type: "history", items: this.stores[agent].history(projectPath, resume, HISTORY_LIMIT) } as BridgeToClient);
          ls.session.reattach(this.tagged(key, emit));
          this.replayPending(key, ls, emit);   // re-surface a permission prompt the client missed
          return;
        }
      }
    }
    const sessionKey = randomUUID();
    const policy = new PermissionPolicy(this.safelist, (req) =>
      this.tagged(sessionKey, emit)(this.permissionRequestMsg(req)));
    const session = this.makeSession(agent, projectPath);
    this.sessions.set(sessionKey, { session, policy, projectPath, agent, resumeId });
    emit({ type: "session_started", nonce, sessionKey, projectPath, agent, resumeId: resumeId ?? "", mode: policy.getMode() });
    // History snapshot (the app seeds an empty conversation with this); tagged by this session's key.
    this.tagged(sessionKey, emit)({ type: "history", items: this.stores[agent].history(projectPath, resume, HISTORY_LIMIT) } as BridgeToClient);
    await session.start({ projectPath, resume: resumeId ?? undefined, policy, emit: this.tagged(sessionKey, emit) });
  }

  /** Replay every live session's current state to a (re)connected client. */
  reattachAll(emit: (m: BridgeToClient) => void): void {
    for (const [key, ls] of this.sessions) {
      if (ls.session.isActive()) {
        ls.session.reattach(this.tagged(key, emit));
        this.replayPending(key, ls, emit);   // re-surface any missed permission prompt
      }
    }
  }

  /** Route a session-scoped client message to its session/policy by sessionKey. */
  route(msg: Extract<ClientMessage, { sessionKey: string }>): boolean {
    const ls = this.sessions.get(msg.sessionKey);
    if (!ls) return false;
    switch (msg.type) {
      case "prompt": ls.session.prompt(msg.text, msg.attachments); return true;
      case "abort": ls.session.abortTurn(); ls.policy.abortAll(); return true;
      case "set_mode": ls.policy.setMode(msg.mode); return true;
      case "permission_response": ls.policy.resolve(msg.id, msg.decision); return true;
      default: return false;
    }
  }

  has(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.session.isActive() ?? false;
  }

  /** True if a LIVE bridge session is writing this (agent, sessionId) — its file
   *  appends are our own output, not external laptop activity. */
  ownsSession(agent: AgentName, sessionId: string): boolean {
    for (const ls of this.sessions.values()) {
      if (ls.agent !== agent || !ls.session.isActive()) continue;
      if (ls.resumeId === sessionId || ls.session.backendSessionId === sessionId) return true;
    }
    return false;
  }

  /** Returns true if any live session exists for the given project+agent pair. */
  hasForProject(projectPath: string, agent: AgentName): boolean {
    for (const ls of this.sessions.values()) {
      if (ls.projectPath === projectPath && ls.agent === agent && ls.session.isActive()) return true;
    }
    return false;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((ls) => ls.session.stop()));
    this.sessions.clear();
  }
}
