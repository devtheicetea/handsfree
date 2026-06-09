import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "../src/server.js";
import type { BridgeToClient } from "../src/protocol.js";
import type { StartParams } from "../src/session.js";

class FakeSession {
  emit: ((m: BridgeToClient) => void) | null = null;
  started: StartParams | null = null;
  prompts: string[] = [];
  active = true;
  reattached = 0;
  async start(p: StartParams) { this.started = p; this.emit = p.emit; }
  prompt(text: string) { this.prompts.push(text); this.emit?.({ type: "response", text: `r:${text}`, done: true }); }
  abortTurn() {}
  async stop() {}
  isActive() { return this.active; }
  reattach(emit: (m: BridgeToClient) => void) { this.reattached++; this.emit = emit; emit({ type: "session_started", sessionId: "x", projectPath: "/x", mode: "safelist" }); }
  // Simulate a tool call asking for permission (uses the real policy the server wired in).
  askNow() { void (this.started as StartParams).policy.evaluate("Bash", {}); }
}

let server: BridgeServer;
afterEach(async () => { await server.close(); });

function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  return new Promise((res, rej) => { ws.on("open", () => res(ws)); ws.on("error", rej); });
}
function next(ws: WebSocket): Promise<BridgeToClient> {
  return new Promise((res) => ws.once("message", (d) => res(JSON.parse(d.toString()))));
}
// Robust collector: accumulate every message, then poll for the one we want.
// Avoids the race where back-to-back messages (e.g. hello_ok + session_started)
// arrive before a sequential once() listener is re-registered.
function collect(ws: WebSocket): BridgeToClient[] {
  const msgs: BridgeToClient[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
  return msgs;
}
async function waitFor(msgs: BridgeToClient[], pred: (m: BridgeToClient) => boolean, ms = 2000): Promise<BridgeToClient> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const found = msgs.find(pred);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

describe("BridgeServer", () => {
  it("accepts hello and routes a prompt through the session", async () => {
    const fake = new FakeSession();
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: ["Read"] },
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello" }));
    expect((await next(ws)).type).toBe("hello_ok");

    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new" }));
    ws.send(JSON.stringify({ type: "prompt", text: "hello" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.started?.projectPath).toBe("/x");
    expect(fake.prompts).toContain("hello");
    ws.close();
  });

  it("rejects a bad token", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: "secret", safelist: [] },
      makeSession: () => new FakeSession() as any,
    });
    const port = await server.listen();
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello", token: "wrong" }));
    const msg = await next(ws);
    expect(msg.type).toBe("error");
    ws.close();
  });

  it("auto-reattaches on hello when a session is live", async () => {
    const fake = new FakeSession();
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [] },
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new" }));
    await new Promise((r) => setTimeout(r, 20));
    a.close();
    await new Promise((r) => setTimeout(r, 20));

    const b = await connect(port);
    const msgs = collect(b);
    b.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    const replay = await waitFor(msgs, (m) => m.type === "session_started");
    expect(replay).toMatchObject({ type: "session_started" });
    expect(fake.reattached).toBe(1);
    b.close();
  });

  it("routes a permission request to the reconnected client after reattach", async () => {
    const fake = new FakeSession();
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [] }, // empty safelist => Bash asks
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new" }));
    await new Promise((r) => setTimeout(r, 20));
    a.close();
    await new Promise((r) => setTimeout(r, 20));

    const b = await connect(port);
    const msgs = collect(b);
    b.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "session_started");

    // A tool now asks for permission AFTER reconnect — must reach the new socket.
    fake.askNow();
    const req = await waitFor(msgs, (m) => m.type === "permission_request");
    expect(req).toMatchObject({ type: "permission_request", tool: "Bash" });
    b.close();
  });

  it("rejects a second concurrent client as busy", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [] },
      makeSession: () => new FakeSession() as any,
    });
    const port = await server.listen();
    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello" }));
    await next(a);
    const b = await connect(port);
    b.send(JSON.stringify({ type: "hello" }));
    const msg = await next(b);
    expect(msg).toMatchObject({ type: "error", code: "busy" });
    a.close(); b.close();
  });
});
