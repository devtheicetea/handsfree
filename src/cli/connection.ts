import { WebSocket } from "ws";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeToClient, ClientMessage } from "../protocol.js";

/** Stable per-machine client id so reconnects replace our own socket. */
export function loadClientId(): string {
  const dir = join(homedir(), ".handsfree");
  const file = join(dir, "cli-client-id");
  try { return readFileSync(file, "utf8").trim(); }
  catch {
    const id = randomUUID();
    try { mkdirSync(dir, { recursive: true }); writeFileSync(file, id); } catch {}
    return id;
  }
}

export interface Connection {
  send(msg: ClientMessage): void;
  close(): void;
}

/** Connect with auto-reconnect; calls onEvent for every bridge message and
 *  onHelloOk after each successful handshake (so the caller can (re)open). */
export function connect(opts: {
  host: string; port: number; token: string | undefined; clientId: string;
  onEvent: (m: BridgeToClient) => void; onHelloOk: () => void; onClose: () => void;
  onStatus?: (s: "connecting" | "connected" | "reconnecting") => void;
}): Connection {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;

  const open = () => {
    opts.onStatus?.(attempt === 0 ? "connecting" : "reconnecting");
    ws = new WebSocket(`ws://${opts.host}:${opts.port}`);
    ws.on("open", () => {
      attempt = 0;
      ws!.send(JSON.stringify({ type: "hello", token: opts.token, clientId: opts.clientId }));
    });
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as BridgeToClient;
      if (m.type === "hello_ok") opts.onHelloOk();
      else if (m.type === "error" && m.code === "unauthorized") { process.stderr.write("Unauthorized: bad token\n"); process.exit(1); }
      else opts.onEvent(m);
    });
    ws.on("close", () => {
      if (closed) return;
      opts.onStatus?.("reconnecting");
      const delay = Math.min(15000, 2 ** Math.min(attempt++, 4) * 500);
      setTimeout(open, delay);
    });
    ws.on("error", () => { /* close handler drives reconnect */ });
  };
  open();

  return {
    send: (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    close: () => { closed = true; ws?.close(); },
  };
}
