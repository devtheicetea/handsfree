import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { BridgeServer } from "../src/server.js";
import type { BridgeToClient } from "../src/protocol.js";
import type { StartParams } from "../src/session.js";

class FakeSession {
  emit: ((m: BridgeToClient) => void) | null = null;
  started: StartParams | null = null;
  prompts: string[] = [];
  async start(p: StartParams) { this.started = p; this.emit = p.emit; }
  prompt(text: string) { this.prompts.push(text); this.emit?.({ type: "response", text: `r:${text}`, done: true }); }
  abortTurn() {}
  async stop() {}
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
