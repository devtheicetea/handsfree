import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import { PermissionPolicy, type AskRequest } from "./permissions.js";
import { QuestionRegistry, type QuestionRequest } from "./questions.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import type { AgentName } from "./backends/types.js";
import type { SessionStore } from "./stores/types.js";
import { ClaudeStore } from "./stores/claude.js";
import { CodexStore } from "./stores/codex.js";
import type { BridgeToClient, ClientMessage } from "./protocol.js";
import { debugLog, preview } from "./debug.js";

const HISTORY_LIMIT = 25;

interface LiveSession {
  session: Session;
  policy: PermissionPolicy;
  questions: QuestionRegistry;
  projectPath: string;
  agent: AgentName;
  resumeId: string | null;
}

export interface SessionManagerDeps {
  safelist: string[];
  makeSession?: (agent: AgentName, projectPath: string) => Session;
  stores?: { claude: SessionStore; codex: SessionStore };
  codexPath?: string | null;
  model?: string | null;
  broadcast: (m: BridgeToClient) => void;   // server fan-out by m.sessionKey
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
  private readonly broadcast: (m: BridgeToClient) => void;

  constructor(deps: SessionManagerDeps) {
    this.safelist = deps.safelist;
    const codexPath = deps.codexPath ?? null;
    const model = deps.model ?? null;
    this.makeSession = deps.makeSession ?? ((agent) =>
      agent === "claude"
        ? new Session(new ClaudeBackend({ model }))
        : new Session(new CodexBackend({ codexPath })));
    this.stores = deps.stores ?? { claude: new ClaudeStore(), codex: new CodexStore() };
    this.broadcast = deps.broadcast;
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

  /** Build a question_request message from a pending ask (sessionKey added by `tagged`). */
  private questionRequestMsg(req: QuestionRequest): BridgeToClient {
    return { type: "question_request", id: req.id, questions: req.questions } as BridgeToClient;
  }

  /** Re-send any still-pending permission + question requests to a (re)connected client. */
  private replayPending(key: string, ls: LiveSession, emit: (m: BridgeToClient) => void): void {
    for (const req of ls.policy.pendingRequests()) {
      this.tagged(key, emit)(this.permissionRequestMsg(req));
    }
    for (const req of ls.questions.pendingRequests()) {
      this.tagged(key, emit)(this.questionRequestMsg(req));
    }
  }

  async open(projectPath: string, agent: AgentName, resume: string, nonce: string, toOpener: (m: BridgeToClient) => void): Promise<string> {
    const resumeId = this.stores[agent].resolveResume(projectPath, resume) ?? null;
    // Reattach a still-live session ONLY when the resumed id matches exactly
    // (reconnect path). Never match by (project, agent) — that would grab an
    // arbitrary session when several are live for the same folder/agent.
    // Match the live backend id too, not just resumeId: a session opened fresh
    // has resumeId === null and only acquires a backendSessionId once the agent
    // starts, so another client resuming that id must join via backendSessionId
    // (mirrors ownsSession) — otherwise it spawns a separate, divergent session.
    if (resumeId) {
      for (const [key, ls] of this.sessions) {
        if (ls.agent === agent && (ls.resumeId === resumeId || ls.session.backendSessionId === resumeId) && ls.session.isActive()) {
          toOpener({ type: "session_started", nonce, sessionKey: key, projectPath, agent, resumeId, mode: ls.policy.getMode() });
          // The client may have restarted and lost all local state (it seeds
          // history only into an empty conversation), so re-send the snapshot —
          // and do it BEFORE replayTo's buffer replay, or the replayed turn
          // would make the conversation non-empty and the seed would be skipped.
          this.tagged(key, toOpener)({ type: "history", items: this.stores[agent].history(projectPath, resume, HISTORY_LIMIT) } as BridgeToClient);
          ls.session.replayTo(this.tagged(key, toOpener));
          this.replayPending(key, ls, toOpener);
          return key;
        }
      }
    }
    const sessionKey = randomUUID();
    const policy = new PermissionPolicy(
      this.safelist,
      (req) => {
        debugLog("agent.permission", { folder: projectPath, session: this.sessions.get(sessionKey)?.session.backendSessionId ?? "", tool: req.tool, id: req.id });
        this.tagged(sessionKey, this.broadcast)(this.permissionRequestMsg(req));
      },
      (id) => this.broadcast({ type: "permission_resolved", sessionKey, id }),
    );
    const questions = new QuestionRegistry(
      (req) => {
        debugLog("agent.question", { folder: projectPath, session: this.sessions.get(sessionKey)?.session.backendSessionId ?? "", id: req.id, count: req.questions.length });
        this.tagged(sessionKey, this.broadcast)(this.questionRequestMsg(req));
      },
      (id) => this.broadcast({ type: "question_resolved", sessionKey, id }),
    );
    const session = this.makeSession(agent, projectPath);
    this.sessions.set(sessionKey, { session, policy, questions, projectPath, agent, resumeId });
    toOpener({ type: "session_started", nonce, sessionKey, projectPath, agent, resumeId: resumeId ?? "", mode: policy.getMode() });
    this.tagged(sessionKey, toOpener)({ type: "history", items: this.stores[agent].history(projectPath, resume, HISTORY_LIMIT) } as BridgeToClient);
    await session.start({
      projectPath, resume: resumeId ?? undefined, policy,
      askUser: (qs) => questions.ask(qs),
      emit: this.tagged(sessionKey, this.broadcast),
    });
    return sessionKey;
  }

  /** Replay every live session's current state to a (re)connected client. */
  reattachAllTo(emit: (m: BridgeToClient) => void): string[] {
    const keys: string[] = [];
    for (const [key, ls] of this.sessions) {
      if (ls.session.isActive()) {
        ls.session.replayTo(this.tagged(key, emit));
        this.replayPending(key, ls, emit);
        // If no turn is in flight, replayTo can't recover a reply that completed
        // while this client was disconnected (e.g. phone backgrounded mid-stream).
        // Send an authoritative history snapshot so the client catches up.
        if (!ls.session.streaming) {
          const sid = ls.session.backendSessionId ?? ls.resumeId ?? "";
          if (sid) {
            this.tagged(key, emit)({ type: "history", items: this.stores[ls.agent].history(ls.projectPath, sid, HISTORY_LIMIT) } as BridgeToClient);
          }
        }
        keys.push(key);
      }
    }
    return keys;
  }

  liveSessionKeys(): string[] {
    return [...this.sessions].filter(([, ls]) => ls.session.isActive()).map(([k]) => k);
  }

  /** The live sessionKey whose backend IS this on-disk (agent, sessionId), if any.
   *  Mirrors ownsSession's matching so a viewer of a live session can attach to it. */
  liveKeyFor(agent: AgentName, sessionId: string): string | undefined {
    for (const [key, ls] of this.sessions) {
      if (ls.agent !== agent || !ls.session.isActive()) continue;
      if (ls.resumeId === sessionId || ls.session.backendSessionId === sessionId) return key;
    }
    return undefined;
  }

  /** Attach a (re)viewing client to an already-live session instead of giving it a
   *  read-only mirror: announce the live sessionKey (session_started{nonce}) so the
   *  client leaves its optimistic mirror, seed history into that key, then replay
   *  the in-flight turn + pending permissions. Returns false if the key went away. */
  attachExisting(key: string, nonce: string, projectPath: string, sessionId: string, toClient: (m: BridgeToClient) => void): boolean {
    const ls = this.sessions.get(key);
    if (!ls || !ls.session.isActive()) return false;
    toClient({ type: "session_started", nonce, sessionKey: key, projectPath, agent: ls.agent, resumeId: sessionId, mode: ls.policy.getMode() });
    this.tagged(key, toClient)({ type: "history", items: this.stores[ls.agent].history(projectPath, sessionId, HISTORY_LIMIT) } as BridgeToClient);
    ls.session.replayTo(this.tagged(key, toClient));
    this.replayPending(key, ls, toClient);
    return true;
  }

  /** Route a session-scoped client message to its session/policy by sessionKey. */
  route(msg: Extract<ClientMessage, { sessionKey: string }>, origin?: string): boolean {
    const ls = this.sessions.get(msg.sessionKey);
    if (!ls) return false;
    switch (msg.type) {
      case "prompt":
        debugLog("user.prompt", { folder: ls.projectPath, session: ls.session.backendSessionId ?? ls.resumeId ?? "",
                                  origin: origin ?? "", text: preview(msg.text) });
        this.broadcast({ type: "user_message", sessionKey: msg.sessionKey, turn: ls.session.currentTurn + 1,
                         text: msg.text, attachments: msg.attachments, origin: origin ?? "" });
        ls.session.prompt(msg.text, msg.attachments);
        return true;
      case "abort": ls.session.abortTurn(); ls.policy.abortAll(); ls.questions.abortAll(); return true;
      case "set_mode": ls.policy.setMode(msg.mode); return true;
      case "permission_response": ls.policy.resolve(msg.id, msg.decision); return true;
      case "question_response": ls.questions.resolve(msg.id, msg.selections); return true;
      default: return false;
    }
  }

  has(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.session.isActive() ?? false;
  }

  /** Folder + session id for a sessionKey — used to tag broadcast debug logs. */
  describe(sessionKey: string): { folder: string; session: string } {
    const ls = this.sessions.get(sessionKey);
    return { folder: ls?.projectPath ?? "?", session: ls?.session.backendSessionId ?? ls?.resumeId ?? "?" };
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

  /** Permanently delete a session: stop it if it's currently live, then remove its file. */
  async deleteSession(projectPath: string, agent: AgentName, sessionId: string): Promise<boolean> {
    const key = this.liveKeyFor(agent, sessionId);
    if (key) {
      const ls = this.sessions.get(key);
      if (ls) { await ls.session.stop(); this.sessions.delete(key); }
    }
    const ok = this.stores[agent].deleteSession(projectPath, sessionId);
    debugLog("session.delete", { folder: projectPath, session: sessionId, agent, wasLive: key != null, ok });
    return ok;
  }
}
