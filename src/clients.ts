import type { WebSocket } from "ws";

export interface RegisteredClient {
  clientId: string;
  socket: WebSocket;
  sessions: Set<string>;   // sessionKeys this client is subscribed to (live)
  mirrors: Set<string>;    // mirror ids `${agent}:${sessionId}` (single-slot)
}

/**
 * Tracks connected, authenticated clients by a stable clientId and which
 * sessions/mirrors each is subscribed to. Pure over sockets — no protocol or
 * agent logic. The server broadcasts session output to socketsForSession(key).
 */
export class ClientRegistry {
  private readonly byId = new Map<string, RegisteredClient>();

  /** Register a client, or replace the socket if the same clientId reconnects.
   *  Returns the prior socket to close (same id, different socket), else null. */
  register(clientId: string, socket: WebSocket): WebSocket | null {
    const existing = this.byId.get(clientId);
    if (existing) {
      const prior = existing.socket !== socket ? existing.socket : null;
      existing.socket = socket;       // keep subscriptions across reconnect
      return prior;
    }
    this.byId.set(clientId, { clientId, socket, sessions: new Set(), mirrors: new Set() });
    return null;
  }

  remove(socket: WebSocket): void {
    for (const [id, c] of this.byId) {
      if (c.socket === socket) { this.byId.delete(id); break; }
    }
  }

  get(clientId: string): RegisteredClient | undefined {
    return this.byId.get(clientId);
  }

  bySocket(socket: WebSocket): RegisteredClient | undefined {
    for (const c of this.byId.values()) if (c.socket === socket) return c;
    return undefined;
  }

  subscribe(socket: WebSocket, sessionKey: string): void {
    this.bySocket(socket)?.sessions.add(sessionKey);
  }

  unsubscribe(socket: WebSocket, sessionKey: string): void {
    this.bySocket(socket)?.sessions.delete(sessionKey);
  }

  /** A client mirrors at most one session at a time (matches the phone). */
  subscribeMirror(socket: WebSocket, mirrorId: string): void {
    const c = this.bySocket(socket);
    if (c) { c.mirrors.clear(); c.mirrors.add(mirrorId); }
  }

  unsubscribeMirror(socket: WebSocket): void {
    this.bySocket(socket)?.mirrors.clear();
  }

  socketsForSession(sessionKey: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const c of this.byId.values()) if (c.sessions.has(sessionKey)) out.push(c.socket);
    return out;
  }

  socketsForMirror(mirrorId: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const c of this.byId.values()) if (c.mirrors.has(mirrorId)) out.push(c.socket);
    return out;
  }

  all(): WebSocket[] {
    return [...this.byId.values()].map((c) => c.socket);
  }

  hasAny(): boolean { return this.byId.size > 0; }
}
