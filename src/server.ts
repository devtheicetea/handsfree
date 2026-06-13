import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { parseClientMessage, encode, type BridgeToClient, type ClientMessage } from "./protocol.js";
import { Session } from "./session.js";
import { mergeProjects } from "./projects.js";
import { SessionManager } from "./sessionManager.js";
import { ClaudeStore } from "./stores/claude.js";
import { CodexStore } from "./stores/codex.js";
import { checkCodexAvailable } from "./backends/codex.js";
import { SessionWatcher, type SessionWatcherDeps, type WatcherEvent } from "./watcher.js";
import type { SessionStore } from "./stores/types.js";
import type { AgentName } from "./backends/types.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

const VERSION = "0.6.0";
const DISCONNECT_GRACE_MS = 120_000;
const HISTORY_LIMIT = 25; // turns per view_session snapshot (matches the manager's open snapshot)

export interface ServerDeps {
  config: Config;
  makeSession?: (agent: AgentName, projectPath: string) => Session;
  stores?: { claude: SessionStore; codex: SessionStore };
  checkCodex?: (codexPath: string | null) => Promise<string>;
  claudeHome?: string; // default ClaudeStore root
  codexHome?: string; // default CodexStore root
  makeWatcher?: (deps: SessionWatcherDeps) => Pick<SessionWatcher, "start" | "stop">;
  logger?: Logger;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly config: Config;
  private readonly stores: { claude: SessionStore; codex: SessionStore };
  private readonly checkCodex: (codexPath: string | null) => Promise<string>;
  private readonly codexPath: string | null;
  /** Cached Codex availability (preflight), so we probe the binary once, not on every (re)connect. */
  private codexAvailable: boolean | null = null;
  private client: WebSocket | null = null;
  // Single-client bridge: one active client at a time, but a fresh connection
  // takes over from the existing one (last-writer-wins) so the single user is
  // never locked out by a stale half-open socket.
  private readonly sessions: SessionManager;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private readonly logger?: Logger;
  private readonly watcher: Pick<SessionWatcher, "start" | "stop">;
  /** The one session the client is mirroring (v0.4.0); null = none. */
  private watched: { agent: AgentName; sessionId: string } | null = null;

  constructor(deps: ServerDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.stores = deps.stores ?? { claude: new ClaudeStore(deps.claudeHome), codex: new CodexStore(deps.codexHome) };
    this.checkCodex = deps.checkCodex ?? checkCodexAvailable;
    this.codexPath = this.config.codexPath;
    this.sessions = new SessionManager({
      safelist: this.config.safelist,
      makeSession: deps.makeSession,
      stores: this.stores,
      codexPath: this.codexPath,
    });
    this.watcher = (deps.makeWatcher ?? ((d) => new SessionWatcher(d)))({
      claudeHome: deps.claudeHome,
      codexHome: deps.codexHome,
      ownsSession: (agent, id) => this.sessions.ownsSession(agent, id),
      onEvent: (e) => this.onWatcherEvent(e),
      log: (m) => this.logger?.info(m),
    });
  }

  /** Route laptop-side file activity: full turns to the watched session's
   *  mirror (never for bridge-owned sessions — those already stream as
   *  `response`s), and a lightweight activity ping for list freshness always. */
  private onWatcherEvent(e: WatcherEvent): void {
    if (this.watched && !e.owned && this.watched.agent === e.agent && this.watched.sessionId === e.sessionId) {
      this.sendToClient({ type: "external_turns", projectPath: e.projectPath, agent: e.agent, sessionId: e.sessionId, items: e.items });
    }
    const preview = e.items.length ? e.items[e.items.length - 1]! : null;
    this.sendToClient({ type: "session_activity", projectPath: e.projectPath, agent: e.agent, sessionId: e.sessionId, lastActive: e.lastActive, preview });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.config.port, host: this.config.bindAddress });
      this.wss.on("connection", (ws) => this.onConnection(ws));
      this.wss.on("error", reject);
      this.wss.on("listening", () => {
        this.watcher.start();
        const addr = this.wss!.address() as AddressInfo;
        resolve(addr.port);
      });
    });
  }

  private send(ws: WebSocket, msg: BridgeToClient): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  }

  /**
   * Send to the *current* client socket. All session output and permission
   * requests go through here so that on reconnect (this.client is updated in
   * onConnection) everything follows the new socket automatically — including
   * the PermissionPolicy's onAsk, which would otherwise stay bound to the old
   * closed socket and hang a post-reconnect permission prompt.
   */
  private sendToClient(msg: BridgeToClient): void {
    if (this.client) this.send(this.client, msg);
  }

  /**
   * Preflight Codex once and cache the result. Single source of truth for both
   * the `hello_ok` capability advertisement and the `open_session` gate, so the
   * binary is probed once per connection rather than on every (re)connect/open.
   */
  private async detectCodex(): Promise<boolean> {
    if (this.codexAvailable !== null) return this.codexAvailable;
    try {
      const version = await this.checkCodex(this.codexPath);
      this.logger?.info("codex version", { version });
      if (!/\b0\.139\.\d+\b/.test(version)) {
        this.logger?.info("codex version outside tested range — wire constants may need re-verification", { version });
      }
      this.codexAvailable = true;
    } catch {
      this.codexAvailable = false;
    }
    return this.codexAvailable;
  }

  private onConnection(ws: WebSocket): void {
    let helloDone = false;

    ws.on("message", async (data) => {
      const parsed = parseClientMessage(data.toString());
      if (!parsed.ok) {
        this.send(ws, { type: "error", code: "bad_message", message: parsed.error });
        return;
      }
      const msg = parsed.value;

      if (!helloDone) {
        if (msg.type !== "hello") {
          this.send(ws, { type: "error", code: "expected_hello", message: "send hello first" });
          return;
        }
        if (this.config.token !== null && msg.token !== this.config.token) {
          ws.send(encode({ type: "error", code: "unauthorized", message: "bad token" }), () => ws.close());
          return;
        }
        // Single-user app: a freshly-authenticated client takes over from any
        // existing one (which may be a stale half-open socket) rather than being
        // locked out. The old socket is told it was superseded and closed.
        if (this.client && this.client !== ws && this.client.readyState === WebSocket.OPEN) {
          const old = this.client;
          old.send(encode({ type: "error", code: "superseded", message: "Connected on another device" }), () => old.close());
        }
        this.client = ws;
        helloDone = true;
        const codex = await this.detectCodex();
        this.send(ws, { type: "hello_ok", version: VERSION, agents: { claude: true, codex } });
        // The client reconnected (or connected fresh) — cancel any pending
        // sustained-disconnect teardown so live sessions are preserved.
        if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
        this.logger?.info("hello", { reconnected: false });
        // Replay every live session's current state to the (re)connected client.
        this.sessions.reattachAll((m) => this.sendToClient(m));
        return;
      }

      try {
        await this.route(ws, msg);
      } catch (err) {
        this.send(ws, { type: "error", code: "internal", message: String(err) });
      }
    });

    ws.on("close", () => {
      if (this.client === ws) {
        this.client = null;
        this.watched = null; // the mirror re-registers via view_session on reconnect
        // Don't tear sessions down on a transient drop — the app reconnects and
        // re-sends hello. Only stop everything after a sustained disconnect.
        if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
        this.disconnectTimer = setTimeout(() => {
          this.logger?.info("sustained disconnect — stopping all sessions");
          void this.sessions.stopAll();
          this.disconnectTimer = null;
        }, DISCONNECT_GRACE_MS);
      }
    });
  }

  private async route(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list_projects":
        this.send(ws, { type: "projects", projects: mergeProjects(this.stores.claude.listProjects(), this.stores.codex.listProjects()) });
        return;
      case "list_sessions":
        this.send(ws, { type: "sessions", projectPath: msg.projectPath, agent: msg.agent,
                        sessions: this.stores[msg.agent].listSessions(msg.projectPath) });
        return;
      case "open_session": {
        this.logger?.info("open_session", { projectPath: msg.projectPath, agent: msg.agent, resume: msg.resume });
        if (msg.agent === "codex" && !this.sessions.hasForProject(msg.projectPath, msg.agent)) {
          if (!(await this.detectCodex())) {
            this.sendToClient({ type: "error", code: "codex_unavailable", message: "codex is not available on this machine" });
            return;
          }
        }
        await this.sessions.open(msg.projectPath, msg.agent, msg.resume, msg.nonce, (m) => this.sendToClient(m));
        return;
      }
      case "view_session": {
        // Mirror mode: history snapshot + live watch. No bridge session is
        // created and nothing spawns (spec §2.2); the fork happens via a later
        // open_session when the user first prompts.
        this.watched = { agent: msg.agent, sessionId: msg.sessionId };
        const items = this.stores[msg.agent].history(msg.projectPath, msg.sessionId, HISTORY_LIMIT);
        this.send(ws, { type: "session_history", projectPath: msg.projectPath, agent: msg.agent, sessionId: msg.sessionId, items });
        return;
      }
      case "unview_session":
        this.watched = null;
        return;
      case "prompt":
      case "abort":
      case "set_mode":
      case "permission_response": {
        if (msg.type === "prompt") {
          this.logger?.info("prompt", { sessionKey: msg.sessionKey, textLen: msg.text.length, attachments: msg.attachments?.length ?? 0 });
        }
        const ok = this.sessions.route(msg);
        // Tag the failure with the sessionKey so the client can silently revive the
        // session (the bridge forgot it on restart, but its transcript is on disk).
        if (!ok) this.send(ws, { type: "error", sessionKey: msg.sessionKey, code: "no_session", message: "session not found — reopen it" });
        return;
      }
      case "hello":
        return;
    }
  }

  async close(): Promise<void> {
    this.watcher.stop();
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    await this.sessions.stopAll();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      for (const c of this.wss.clients) c.terminate();
      this.wss.close(() => resolve());
    });
  }
}
