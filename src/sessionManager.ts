import { randomUUID } from "node:crypto";
import { Session } from "./session.js";
import { PermissionPolicy, type AskRequest } from "./permissions.js";
import { QuestionRegistry, type QuestionRequest } from "./questions.js";
import { ModeStore } from "./modeStore.js";
import { NameStore } from "./nameStore.js";
import { ClaudeBackend } from "./backends/claude.js";
import { CodexBackend } from "./backends/codex.js";
import type { AgentName } from "./backends/types.js";
import type { SessionStore, SessionMeta } from "./stores/types.js";
import { ClaudeStore } from "./stores/claude.js";
import { CodexStore } from "./stores/codex.js";
import type { BridgeToClient, ClientMessage, ProjectInfo } from "./protocol.js";
import { mergeProjects } from "./projects.js";
import { debugLog, preview } from "./debug.js";

const HISTORY_LIMIT = 25;

// Disconnect-teardown grace (all clients gone). The most-recently-active ("held") session
// survives a long gap — the user likely just locked the phone and will return; other live
// sessions are cleaned up quickly. A session with work in flight is NEVER stopped — re-checked
// on WORK_RECHECK_MS until it settles. Spec: docs/superpowers/specs/2026-06-25-session-liveness-grace-design.md
const HELD_GRACE_MS = 30 * 60_000;   // 30 min — the session the user is actually in
const IDLE_GRACE_MS = 120_000;       // 2 min — older / background live sessions
const WORK_RECHECK_MS = 30_000;      // re-poll a still-working session rather than kill it mid-task

interface LiveSession {
  session: Session;
  policy: PermissionPolicy;
  questions: QuestionRegistry;
  projectPath: string;
  agent: AgentName;
  resumeId: string | null;
  /** Wall-clock of the last open/prompt — picks the "held" session on disconnect. */
  lastActiveMs: number;
  /** Explicitly held by the client (voice mode on, or backgrounded with this conversation
   *  open) — gets the long grace regardless of recency; cleared on release. */
  held: boolean;
}

export interface SessionManagerDeps {
  safelist: string[];
  makeSession?: (agent: AgentName, projectPath: string) => Session;
  stores?: { claude: SessionStore; codex: SessionStore };
  codexPath?: string | null;
  model?: string | null;
  modeStore?: ModeStore;   // durable per-session permission mode (default ~/.handsfree/modes.json)
  nameStore?: NameStore;   // durable per-session custom name (default ~/.handsfree/session-names.json)
  broadcast: (m: BridgeToClient) => void;   // server fan-out by m.sessionKey
}

/**
 * Owns one live Session per sessionKey (UUID). All sessions stay alive (none
 * stopped on switch); every session's output is tagged with its sessionKey
 * before reaching the client. Input messages are routed by sessionKey.
 */
export class SessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  /** Pending per-session disconnect-teardown timers (cancelled on reconnect). */
  private readonly stopTimers = new Map<string, NodeJS.Timeout>();
  private readonly safelist: string[];
  private readonly makeSession: (agent: AgentName, projectPath: string) => Session;
  private readonly stores: { claude: SessionStore; codex: SessionStore };
  private readonly modeStore: ModeStore;
  private readonly nameStore: NameStore;
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
    this.modeStore = deps.modeStore ?? new ModeStore();
    this.nameStore = deps.nameStore ?? new NameStore();
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
    // Restore the user's last-chosen mode for this session id — durable across the
    // disconnect-grace teardown and bridge restarts; falls back to the safelist default.
    const savedMode = resumeId ? this.modeStore.get(agent, resumeId) : undefined;
    if (savedMode) policy.setMode(savedMode);
    const session = this.makeSession(agent, projectPath);
    this.sessions.set(sessionKey, { session, policy, questions, projectPath, agent, resumeId, lastActiveMs: Date.now(), held: false });
    toOpener({ type: "session_started", nonce, sessionKey, projectPath, agent, resumeId: resumeId ?? "", mode: policy.getMode() });
    this.tagged(sessionKey, toOpener)({ type: "history", items: this.stores[agent].history(projectPath, resume, HISTORY_LIMIT) } as BridgeToClient);
    await session.start({
      projectPath, resume: resumeId ?? undefined, policy,
      askUser: (qs) => questions.ask(qs),
      // A fresh session's id isn't known until its first turn — persist any
      // non-default mode the user set before then, once the id arrives.
      onSessionId: (id) => { const m = policy.getMode(); if (m !== "safelist") this.modeStore.set(agent, id, m); },
      emit: this.tagged(sessionKey, this.broadcast),
    });
    return sessionKey;
  }

  /** Replay every live session's current state to a (re)connected client. */
  reattachAllTo(emit: (m: BridgeToClient) => void, log?: (msg: string, data?: Record<string, unknown>) => void): string[] {
    const keys: string[] = [];
    for (const [key, ls] of this.sessions) {
      if (ls.session.isActive()) {
        const sid = ls.session.backendSessionId ?? ls.resumeId ?? "";
        // Announce this session's IDENTITY first. A client that just cold-launched has lost
        // its in-memory live-session map, so without this it can't tell that `key` is the live
        // backing for on-disk session `sid` and would open a read-only mirror instead of
        // attaching live. (No nonce: this is unsolicited, not the reply to an open/view.)
        emit({ type: "session_attached", sessionKey: key, projectPath: ls.projectPath, agent: ls.agent, resumeId: sid } as BridgeToClient);
        ls.session.replayTo(this.tagged(key, emit));
        this.replayPending(key, ls, emit);
        // If no turn is in flight, replayTo can't recover a reply that completed
        // while this client was disconnected (e.g. phone backgrounded mid-stream).
        // Send an authoritative history snapshot so the client catches up.
        const streaming = ls.session.streaming;
        let sentHistory = false, itemCount = 0;
        if (!streaming && sid) {
          const items = this.stores[ls.agent].history(ls.projectPath, sid, HISTORY_LIMIT);
          itemCount = items.length;
          sentHistory = true;
          this.tagged(key, emit)({ type: "history", items } as BridgeToClient);
        }
        log?.("reattach", { key, streaming, sentHistory, itemCount, sid });
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
        ls.lastActiveMs = Date.now();   // this is now the "held" session if the client drops
        ls.session.prompt(msg.text, msg.attachments);
        return true;
      case "session_hold":
        ls.held = true;   // voice mode on, or backgrounded with this conversation open
        debugLog("session.hold", { folder: ls.projectPath, session: ls.session.backendSessionId ?? "", reason: msg.reason ?? "" });
        return true;
      case "session_release":
        ls.held = false;
        debugLog("session.release", { folder: ls.projectPath, session: ls.session.backendSessionId ?? "" });
        return true;
      case "abort": {
        // Interrupting records "[Request interrupted by user]" in the transcript as a
        // USER-side entry. Emit it live too (matching disk + reopen) so it shows on the
        // user's side immediately and is never spoken — the SDK doesn't stream it. Origin
        // "" so every client, including the one that aborted, shows it.
        if (ls.session.streaming) {
          this.broadcast({ type: "user_message", sessionKey: msg.sessionKey, turn: ls.session.currentTurn,
                           text: "[Request interrupted by user]", origin: "" });
        }
        ls.session.abortTurn();
        ls.policy.abortAll();
        ls.questions.abortAll();
        return true;
      }
      case "set_mode": {
        ls.policy.setMode(msg.mode);
        // Persist by the durable session id so the choice survives a restart.
        const id = ls.session.backendSessionId ?? ls.resumeId;
        if (id) this.modeStore.set(ls.agent, id, msg.mode);
        return true;
      }
      case "permission_response": ls.policy.resolve(msg.id, msg.decision); return true;
      case "question_response": ls.questions.resolve(msg.id, msg.selections); return true;
      default: return false;
    }
  }

  has(sessionKey: string): boolean {
    return this.sessions.get(sessionKey)?.session.isActive() ?? false;
  }

  /** The durably-saved permission mode for an on-disk session, if any — so a mirror
   *  (no live session/policy yet) can still show the mode that will be enforced. */
  savedMode(agent: AgentName, sessionId: string) {
    return this.modeStore.get(agent, sessionId);
  }

  /** Set/clear a session's durable custom name (empty string clears it). */
  setName(agent: AgentName, sessionId: string, name: string): void {
    this.nameStore.set(agent, sessionId, name);
  }

  /** A project+agent's session list with any custom names applied over the
   *  transcript-derived titles. Use this wherever a `sessions` message is built. */
  listSessions(agent: AgentName, projectPath: string): SessionMeta[] {
    return this.stores[agent].listSessions(projectPath).map((s) => {
      const name = this.nameStore.get(agent, s.sessionId);
      return name ? { ...s, title: name } : s;
    });
  }

  /** Projects across both agents, with each project's latest-session title resolved (a custom
   *  rename name overrides the AI-derived title) so the client's session switcher shows the
   *  same titles as the session list. */
  listProjects(): ProjectInfo[] {
    const projects = mergeProjects(this.stores.claude.listProjects(), this.stores.codex.listProjects());
    for (const p of projects) {
      for (const agent of ["claude", "codex"] as AgentName[]) {
        const a = p.agents[agent];
        if (a?.lastSessionId) {
          const name = this.nameStore.get(agent, a.lastSessionId);
          if (name) a.lastTitle = name;
        }
      }
    }
    return projects;
  }

  /** Folder + session id for a sessionKey — used to tag broadcast debug logs. */
  describe(sessionKey: string): { folder: string; session: string } {
    const ls = this.sessions.get(sessionKey);
    return { folder: ls?.projectPath ?? "?", session: ls?.session.backendSessionId ?? ls?.resumeId ?? "?" };
  }

  /** True if a LIVE bridge session is writing this (agent, sessionId) — its file
   *  appends are our own output, not external activity (e.g. a terminal running the agent). */
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
    this.cancelGracefulStops();
    await Promise.all([...this.sessions.values()].map((ls) => ls.session.stop()));
    this.sessions.clear();
  }

  /** Last client disconnected: schedule per-session teardown instead of stopping everything at
   *  once. The most-recently-active ("held") session gets HELD_GRACE_MS (the user likely just
   *  locked the phone and will be back); the rest get IDLE_GRACE_MS. A session doing work is
   *  never stopped — re-checked until it settles. cancelGracefulStops() aborts all of these on
   *  reconnect. Idempotent: re-arming replaces the existing timers. */
  scheduleGracefulStop(): void {
    // The held session is the one most recently opened or prompted.
    let heldKey: string | null = null;
    let heldAt = -Infinity;
    for (const [key, ls] of this.sessions) {
      if (ls.lastActiveMs > heldAt) { heldAt = ls.lastActiveMs; heldKey = key; }
    }
    for (const [key, ls] of this.sessions) {
      const isHeld = key === heldKey || ls.held;   // most-recently-active OR explicitly held (voice/bg)
      this.scheduleStop(key, isHeld ? HELD_GRACE_MS : IDLE_GRACE_MS);
    }
  }

  /** Client explicitly holds/releases a session (voice mode on, or backgrounding with it open).
   *  A held session gets the long grace on disconnect regardless of recency. */
  setHeld(sessionKey: string, held: boolean): void {
    const ls = this.sessions.get(sessionKey);
    if (ls) ls.held = held;
  }

  private scheduleStop(key: string, delayMs: number): void {
    const existing = this.stopTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.stopTimers.delete(key);
      const ls = this.sessions.get(key);
      if (!ls) return;
      if (ls.session.hasWorkInFlight) {
        // Still producing output the user is waiting on — don't kill it mid-work; re-check soon.
        this.scheduleStop(key, WORK_RECHECK_MS);
        return;
      }
      void ls.session.stop();
      this.sessions.delete(key);
    }, delayMs);
    this.stopTimers.set(key, timer);
  }

  /** A client reconnected: cancel all pending disconnect teardowns. */
  cancelGracefulStops(): void {
    for (const t of this.stopTimers.values()) clearTimeout(t);
    this.stopTimers.clear();
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
