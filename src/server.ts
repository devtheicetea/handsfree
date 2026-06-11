import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { parseClientMessage, encode, type BridgeToClient, type ClientMessage } from "./protocol.js";
import { Session } from "./session.js";
import { mergeProjects, listClaudeProjects, defaultClaudeHome, historyForProject } from "./projects.js";
import { SessionManager } from "./sessionManager.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";

const VERSION = "0.1.0";
const DISCONNECT_GRACE_MS = 120_000;
const HISTORY_LIMIT = 25;

export interface ServerDeps {
  config: Config;
  makeSession?: () => Session;
  claudeHome?: string;
  logger?: Logger;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly config: Config;
  private readonly claudeHome: string;
  private client: WebSocket | null = null;
  // Single-client bridge (v1): one active client at a time. A second connection
  // is rejected as "busy" before it can reach open_session.
  private readonly sessions: SessionManager;
  private disconnectTimer: NodeJS.Timeout | null = null;
  private readonly logger?: Logger;

  constructor(deps: ServerDeps) {
    this.config = deps.config;
    this.claudeHome = deps.claudeHome ?? defaultClaudeHome();
    this.logger = deps.logger;
    this.sessions = new SessionManager({
      safelist: this.config.safelist,
      makeSession: deps.makeSession,
      claudeHome: this.claudeHome,
    });
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.config.port, host: this.config.bindAddress });
      this.wss.on("connection", (ws) => this.onConnection(ws));
      this.wss.on("error", reject);
      this.wss.on("listening", () => {
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

  private onConnection(ws: WebSocket): void {
    let helloDone = false;
    const isBusy = !!(this.client && this.client.readyState === WebSocket.OPEN);

    if (!isBusy) {
      this.client = ws;
    }

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
        if (isBusy) {
          ws.send(encode({ type: "error", code: "busy", message: "Another client is connected" }), () => ws.close());
          return;
        }
        if (this.config.token !== null && msg.token !== this.config.token) {
          ws.send(encode({ type: "error", code: "unauthorized", message: "bad token" }), () => ws.close());
          return;
        }
        helloDone = true;
        this.send(ws, { type: "hello_ok", version: VERSION });
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
        this.send(ws, { type: "projects", projects: mergeProjects(listClaudeProjects(this.claudeHome), []) });
        return;
      case "open_session": {
        this.logger?.info("open_session", { projectPath: msg.projectPath, resume: msg.resume });
        // History first (the app replaces its message list with this snapshot),
        // then the live session attaches and streams new turns on top.
        const items = historyForProject(this.claudeHome, msg.projectPath, msg.resume, HISTORY_LIMIT);
        this.sendToClient({ type: "history", projectPath: msg.projectPath, items, agent: msg.agent });
        await this.sessions.open(msg.projectPath, msg.resume, (m) => this.sendToClient(m));
        return;
      }
      case "prompt":
      case "abort":
      case "set_mode":
      case "permission_response": {
        const ok = this.sessions.route(msg);
        if (!ok) this.send(ws, { type: "error", projectPath: msg.projectPath, code: "no_session", message: "open the project first" });
        return;
      }
      case "hello":
        return;
    }
  }

  async close(): Promise<void> {
    if (this.disconnectTimer) { clearTimeout(this.disconnectTimer); this.disconnectTimer = null; }
    await this.sessions.stopAll();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      for (const c of this.wss.clients) c.terminate();
      this.wss.close(() => resolve());
    });
  }
}
