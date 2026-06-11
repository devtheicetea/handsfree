import type { Readable, Writable } from "node:stream";

export type Json = Record<string, unknown>;

export interface JsonRpcHandlers {
  onNotification?: (method: string, params: Json) => void;
  onRequest?: (method: string, params: Json) => Promise<Json>;
}

interface Pending { resolve: (r: Json) => void; reject: (e: Error) => void }

/**
 * Minimal newline-delimited JSON-RPC connection for the codex app-server wire:
 * one JSON object per line, NO "jsonrpc":"2.0" header. Supports client->server
 * requests/notifications and server->client requests (answered via onRequest).
 */
export class JsonRpcConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = "";
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonRpcHandlers = {},
    private readonly log: (msg: string) => void = () => {},
  ) {
    input.on("data", (chunk: Buffer | string) => this.onData(String(chunk)));
    input.on("end", () => this.end("stream ended"));
    input.on("close", () => this.end("stream closed"));
    input.on("error", (err) => this.end(String(err)));
  }

  request(method: string, params: Json = {}): Promise<Json> {
    if (this.closed) return Promise.reject(new Error("jsonrpc: connection closed"));
    const id = this.nextId++;
    const p = new Promise<Json>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.write({ id, method, params });
    return p;
  }

  notify(method: string, params: Json = {}): void {
    this.write({ method, params });
  }

  /** Reject everything pending and refuse further traffic. Idempotent. */
  end(reason = "closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`jsonrpc: ${reason}`));
    this.pending.clear();
  }

  private write(obj: Json): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(obj) + "\n");
  }

  private onData(text: string): void {
    this.buffer += text;
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: { message?: string } };
    try { msg = JSON.parse(line) as typeof msg; } catch {
      this.log(`jsonrpc: unparseable line: ${line.slice(0, 120)}`);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      // server -> client request; answer asynchronously
      const id = msg.id;
      const handle = this.handlers.onRequest ?? (async () => { throw new Error("no request handler"); });
      void handle(msg.method, msg.params ?? {}).then(
        (result) => this.write({ id, result }),
        (err) => this.write({ id, error: { code: -32000, message: String(err) } }),
      );
    } else if (msg.method !== undefined) {
      this.handlers.onNotification?.(msg.method, msg.params ?? {});
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) { this.log(`jsonrpc: response for unknown id ${msg.id}`); return; }
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "jsonrpc error"));
      else p.resolve(msg.result ?? {});
    } else {
      this.log(`jsonrpc: unroutable line: ${line.slice(0, 120)}`);
    }
  }
}
