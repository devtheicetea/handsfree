import { WebSocketServer, WebSocket } from "ws";
import { AddressInfo } from "node:net";
import { parseClientMessage, encode, type BridgeToClient, type ClientMessage } from "./protocol.js";
import { PermissionPolicy } from "./permissions.js";
import { Session } from "./session.js";
import { listProjects, resolveResume, defaultClaudeHome } from "./projects.js";
import type { Config } from "./config.js";

const VERSION = "0.1.0";

export interface ServerDeps {
  config: Config;
  makeSession?: () => Session;
  claudeHome?: string;
}

export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private readonly config: Config;
  private readonly makeSession: () => Session;
  private readonly claudeHome: string;
  private client: WebSocket | null = null;
  // Single-client bridge (v1): one active session/policy at a time. A second
  // connection is rejected as "busy" before it can reach open_session, so these
  // instance fields are never contended across clients.
  private session: Session | null = null;
  private policy: PermissionPolicy | null = null;

  constructor(deps: ServerDeps) {
    this.config = deps.config;
    this.makeSession = deps.makeSession ?? (() => new Session());
    this.claudeHome = deps.claudeHome ?? defaultClaudeHome();
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
        // Auto-reattach: if a session is still live (client reconnected after a
        // dropped socket), replay current state. Session output + permission
        // requests already route through sendToClient (the current socket).
        if (this.session?.isActive()) {
          this.session.reattach((m) => this.sendToClient(m));
        }
        return;
      }

      try {
        await this.route(ws, msg);
      } catch (err) {
        this.send(ws, { type: "error", code: "internal", message: String(err) });
      }
    });

    ws.on("close", () => {
      if (this.client === ws) this.client = null;
    });
  }

  private async route(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "list_projects":
        this.send(ws, { type: "projects", projects: listProjects(this.claudeHome) });
        return;
      case "open_session": {
        const resume = resolveResume(this.claudeHome, msg.projectPath, msg.resume);
        // Swap to the new session synchronously (start()'s body runs synchronously
        // and establishes readiness) so a prompt racing right behind open_session
        // sees the started session; then drain the previous one.
        const previous = this.session;
        this.policy = new PermissionPolicy(this.config.safelist, (req) =>
          this.sendToClient({
            type: "permission_request",
            id: req.id,
            tool: req.tool,
            input: req.input,
            detail:
              req.input && typeof req.input === "object"
                ? `${req.tool} ${JSON.stringify(req.input).slice(0, 180)}`
                : req.tool,
          }),
        );
        this.session = this.makeSession();
        const startPromise = this.session.start({
          projectPath: msg.projectPath,
          resume,
          policy: this.policy,
          emit: (m) => this.sendToClient(m),
        });
        await previous?.stop();
        await startPromise;
        return;
      }
      case "prompt":
        if (!this.session) { this.send(ws, { type: "error", code: "no_session", message: "open a session first" }); return; }
        this.session.prompt(msg.text);
        return;
      case "permission_response":
        this.policy?.resolve(msg.id, msg.decision);
        return;
      case "set_mode":
        this.policy?.setMode(msg.mode);
        return;
      case "abort":
        this.session?.abortTurn();
        this.policy?.abortAll();
        return;
      case "hello":
        return;
    }
  }

  async close(): Promise<void> {
    await this.session?.stop();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      for (const c of this.wss.clients) c.terminate();
      this.wss.close(() => resolve());
    });
  }
}
