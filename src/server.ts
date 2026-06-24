import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { parseClientMessage, encode, type BridgeToClient, type ClientMessage } from "./protocol.js";
import { Session } from "./session.js";
import { mergeProjects } from "./projects.js";
import { SessionManager } from "./sessionManager.js";
import { ClientRegistry } from "./clients.js";
import { debugLog, isDebug } from "./debug.js";
import { ClaudeStore } from "./stores/claude.js";
import { CodexStore } from "./stores/codex.js";
import { checkCodexAvailable } from "./backends/codex.js";
import { SessionWatcher, type SessionWatcherDeps, type WatcherEvent } from "./watcher.js";
import type { SessionStore } from "./stores/types.js";
import type { AgentName } from "./backends/types.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

const VERSION = "0.8.0";
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
  private readonly clients = new ClientRegistry();
  private readonly sessions: SessionManager;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private readonly logger?: Logger;
  private readonly watcher: Pick<SessionWatcher, "start" | "stop">;

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
      model: this.config.model,
      broadcast: (m) => this.broadcastToSession((m as { sessionKey?: string }).sessionKey, m),
    });
    this.watcher = (deps.makeWatcher ?? ((d) => new SessionWatcher(d)))({
      claudeHome: deps.claudeHome,
      codexHome: deps.codexHome,
      ownsSession: (agent, id) => this.sessions.ownsSession(agent, id),
      onEvent: (e) => this.onWatcherEvent(e),
      log: (m) => this.logger?.info(m),
    });
  }

  /** Route host-side file activity: full turns to subscribers of the mirror,
   *  and a lightweight activity ping for list freshness always. */
  private onWatcherEvent(e: WatcherEvent): void {
    const mirrorId = `${e.agent}:${e.sessionId}`;
    if (!e.owned) {
      this.broadcastToMirror(mirrorId, { type: "external_turns", projectPath: e.projectPath, agent: e.agent, sessionId: e.sessionId, items: e.items });
    }
    const preview = e.items.length ? e.items[e.items.length - 1]! : null;
    this.broadcastToAll({ type: "session_activity", projectPath: e.projectPath, agent: e.agent, sessionId: e.sessionId, lastActive: e.lastActive, preview });
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

  private broadcastToSession(sessionKey: string | undefined, msg: BridgeToClient): void {
    if (!sessionKey) return;
    const socks = this.clients.socketsForSession(sessionKey);
    const d = this.sessions.describe(sessionKey);
    debugLog("broadcast.session", { folder: d.folder, session: d.session, type: msg.type, clients: socks.length });
    for (const ws of socks) this.send(ws, msg);
  }

  private broadcastToMirror(mirrorId: string, msg: BridgeToClient): void {
    const socks = this.clients.socketsForMirror(mirrorId);
    debugLog("broadcast.mirror", { mirror: mirrorId, type: msg.type, clients: socks.length });
    for (const ws of socks) this.send(ws, msg);
  }

  private broadcastToAll(msg: BridgeToClient): void {
    const socks = this.clients.all();
    debugLog("broadcast.all", { type: msg.type, clients: socks.length });
    for (const ws of socks) this.send(ws, msg);
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
    let clientId = "";

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
        clientId = msg.clientId ?? randomUUID();
        const prior = this.clients.register(clientId, ws);
        if (prior && prior.readyState === WebSocket.OPEN) {
          prior.send(encode({ type: "error", code: "superseded", message: "Reconnected" }), () => prior.close());
        }
        const codex = await this.detectCodex();
        this.send(ws, { type: "hello_ok", version: VERSION, agents: { claude: true, codex } });
        helloDone = true;
        if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
        this.logger?.info("hello", { clientId });
        // Catch this client up on every live session AND subscribe it to them.
        // Reattach diagnostics only in debug mode (HANDSFREE_ENV=debug).
        const keys = this.sessions.reattachAllTo((m) => this.send(ws, m),
          isDebug() ? (m, d) => this.logger?.info(m, d) : undefined);
        for (const k of keys) this.clients.subscribe(ws, k);
        return;
      }

      try {
        await this.route(ws, msg, clientId);
      } catch (err) {
        this.send(ws, { type: "error", code: "internal", message: String(err) });
      }
    });

    ws.on("close", () => {
      this.clients.remove(ws);
      if (this.clients.hasAny()) return;   // other clients still connected — keep sessions alive
      if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
      this.disconnectTimer = setTimeout(() => {
        this.logger?.info("all clients gone — stopping all sessions");
        void this.sessions.stopAll();
        this.disconnectTimer = null;
      }, DISCONNECT_GRACE_MS);
    });
  }

  private async route(ws: WebSocket, msg: ClientMessage, clientId: string): Promise<void> {
    switch (msg.type) {
      case "list_projects":
        this.send(ws, { type: "projects", projects: mergeProjects(this.stores.claude.listProjects(), this.stores.codex.listProjects()) });
        return;
      case "list_sessions":
        this.send(ws, { type: "sessions", projectPath: msg.projectPath, agent: msg.agent,
                        sessions: this.sessions.listSessions(msg.agent, msg.projectPath) });
        return;
      case "delete_session":
        await this.sessions.deleteSession(msg.projectPath, msg.agent, msg.sessionId);
        this.send(ws, { type: "sessions", projectPath: msg.projectPath, agent: msg.agent,
                        sessions: this.sessions.listSessions(msg.agent, msg.projectPath) });
        return;
      case "rename_session":
        // Persist the custom name (survives bridge restart), then re-send the
        // authoritative list with the new title applied.
        this.sessions.setName(msg.agent, msg.sessionId, msg.name);
        this.send(ws, { type: "sessions", projectPath: msg.projectPath, agent: msg.agent,
                        sessions: this.sessions.listSessions(msg.agent, msg.projectPath) });
        return;
      case "diag":
        // Client reconnect/catch-up breadcrumb — landed in the bridge log file
        // alongside the bridge's own events, but only when running in debug mode
        // (HANDSFREE_ENV=debug). Accepted-and-ignored in prod so older/debug clients
        // never error. Kept for diagnosing the missing-final-message reconnect path.
        if (isDebug()) this.logger?.info("client_diag", { msg: msg.msg });
        return;
      case "open_session": {
        this.logger?.info("open_session", { projectPath: msg.projectPath, agent: msg.agent, resume: msg.resume });
        if (msg.agent === "codex" && !this.sessions.hasForProject(msg.projectPath, msg.agent)) {
          if (!(await this.detectCodex())) {
            this.send(ws, { type: "error", code: "codex_unavailable", message: "codex is not available on this machine" });
            return;
          }
        }
        const key = await this.sessions.open(msg.projectPath, msg.agent, msg.resume, msg.nonce, (m) => this.send(ws, m));
        this.clients.subscribe(ws, key);
        return;
      }
      case "view_session": {
        // If this on-disk session is actually LIVE and bridge-owned, attach the
        // client to it (live streaming + answerable permissions) rather than
        // handing back a read-only mirror it can't update or answer from.
        const liveKey = this.sessions.liveKeyFor(msg.agent, msg.sessionId);
        if (liveKey) {
          this.clients.subscribe(ws, liveKey);
          this.sessions.attachExisting(liveKey, msg.nonce ?? "", msg.projectPath, msg.sessionId, (m) => this.send(ws, m));
          return;
        }
        this.clients.subscribeMirror(ws, `${msg.agent}:${msg.sessionId}`);
        const items = this.stores[msg.agent].history(msg.projectPath, msg.sessionId, HISTORY_LIMIT);
        // Carry the session's saved permission mode so the picker shows what will be
        // enforced once the mirror forks live — not a stale safelist default.
        const mode = this.sessions.savedMode(msg.agent, msg.sessionId);
        this.send(ws, { type: "session_history", projectPath: msg.projectPath, agent: msg.agent, sessionId: msg.sessionId, items, mode });
        return;
      }
      case "unview_session":
        this.clients.unsubscribeMirror(ws);
        return;
      case "unsubscribe":
        this.clients.unsubscribe(ws, msg.sessionKey);
        return;
      case "prompt":
      case "abort":
      case "set_mode":
      case "permission_response":
      case "question_response": {
        if (msg.type === "prompt") {
          this.logger?.info("prompt", { sessionKey: msg.sessionKey, textLen: msg.text.length, attachments: msg.attachments?.length ?? 0 });
        }
        const ok = this.sessions.route(msg, clientId);
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
