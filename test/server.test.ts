import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { BridgeServer } from "../src/server.js";
import { Session } from "../src/session.js";
import { CodexUnavailableError } from "../src/backends/codex.js";
import { FakeBackend } from "./fakeBackend.js";
import type { BridgeToClient } from "../src/protocol.js";
import type { StartParams } from "../src/session.js";
import type { SessionStore, StoreProject } from "../src/stores/types.js";
import type { HistoryItem } from "../src/sessionHistory.js";

/** Minimal in-memory SessionStore for server tests; override per-test as needed. */
function fakeStore(over: Partial<SessionStore> = {}): SessionStore {
  return {
    listProjects: () => [],
    listSessions: () => [],
    resolveResume: (_p, resume) => (resume === "new" ? undefined : resume),
    history: () => [],
    ...over,
  };
}

class FakeSession {
  emit: ((m: BridgeToClient) => void) | null = null;
  started: StartParams | null = null;
  prompts: string[] = [];
  active = true;
  reattached = 0;
  async start(p: StartParams) { this.started = p; this.emit = p.emit; }
  prompt(text: string) { this.prompts.push(text); this.emit?.({ type: "response", turn: 1, text: `r:${text}`, done: true } as any); }
  abortTurn() {}
  async stop() {}
  isActive() { return this.active; }
  detachEmit() { this.emit = null; }
  get project() { return this.started?.projectPath ?? ""; }
  reattach(emit: (m: BridgeToClient) => void) { this.reattached++; this.emit = emit; emit({ type: "session_started", sessionId: "x", projectPath: "/x", mode: "safelist" } as any); }
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
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: ["Read"], codexPath: null },
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");

    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
    const started = await waitFor(msgs, (m) => m.type === "session_started");
    const sessionKey = (started as any).sessionKey as string;
    ws.send(JSON.stringify({ type: "prompt", sessionKey, text: "hello" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.started?.projectPath).toBe("/x");
    expect(fake.prompts).toContain("hello");
    ws.close();
  });

  it("reattaches instead of restarting when the same project is re-opened", async () => {
    const fake = new FakeSession();
    let made = 0;
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => { made++; return fake as any; },
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(made).toBe(1);
    // The app re-sends open_session for the same project on every reconnect — the
    // bridge must reattach, not tear down + recreate (which aborts the in-flight turn).
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "latest", nonce: "n1" }));
    await waitFor(msgs, () => fake.reattached > 0);
    expect(made).toBe(1);            // no second session created
    expect(fake.reattached).toBe(1); // reattached instead
    ws.close();
  });

  it("rejects a bad token", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: "secret", safelist: [], codexPath: null },
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
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
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
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null }, // empty safelist => Bash asks
      makeSession: () => fake as any,
    });
    const port = await server.listen();

    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
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

  // Phase 3 follow-up: re-attribute crash-loop guard per project in SessionManager
  it.skip("guards against a resume crash-loop", async () => {
    class CrashSession {
      emit: ((m: BridgeToClient) => void) | null = null;
      active = false;
      async start(p: StartParams) { this.emit = p.emit; p.emit({ type: "status", state: "error" }); p.emit({ type: "error", code: "session_crashed", message: "boom" }); }
      prompt() {}
      abortTurn() {}
      async stop() {}
      isActive() { return this.active; }
      detachEmit() { this.emit = null; }
      reattach() {}
    }
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new CrashSession() as any,
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");

    // Two crashing resumes of the same id within the window.
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "sid" }));
    await new Promise((r) => setTimeout(r, 15));
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "sid" }));
    await new Promise((r) => setTimeout(r, 15));

    // Third resume of the same id should be rejected as crash_loop.
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "sid" }));
    const got = await waitFor(msgs, (m) => m.type === "error" && (m as { code: string }).code === "crash_loop");
    expect(got).toMatchObject({ type: "error", code: "crash_loop" });
    ws.close();
  });

  it("runs two projects concurrently with tagged output over one socket", async () => {
    const made: any[] = [];
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => { const f = new FakeSession(); made.push(f); return f as any; },
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/a", resume: "new", nonce: "na" }));
    const aStarted = await waitFor(msgs, (m) => m.type === "session_started" && (m as any).projectPath === "/a");
    const aKey = (aStarted as any).sessionKey as string;
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/b", resume: "new", nonce: "nb" }));
    await waitFor(msgs, (m) => m.type === "session_started" && (m as any).projectPath === "/b");
    ws.send(JSON.stringify({ type: "prompt", sessionKey: aKey, text: "hi" }));
    await new Promise((r) => setTimeout(r, 30));
    const aResp = msgs.find((m) => m.type === "response" && (m as any).sessionKey === aKey);
    expect(aResp).toBeTruthy();
    expect(made[0].isActive()).toBe(true);
    expect(made[1].isActive()).toBe(true);
    ws.close();
  });

  it("rejects a second concurrent client as busy", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
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

  it("sends conversation history on open_session", async () => {
    const home = mkdtempSync(join(tmpdir(), "srv-home-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    ].join("\n") + "\n");

    const fake = new FakeSession();
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => fake as any,
      claudeHome: home,
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/Users/me/app", resume: "latest", nonce: "n0" }));
    const hist = await waitFor(msgs, (m) => m.type === "history");
    expect(hist).toMatchObject({
      type: "history",
      items: [
        { role: "user", text: "hi", tools: [] },
        { role: "assistant", text: "yo", tools: [] },
      ],
    });
    ws.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("reports protocol version 0.3.0 in hello_ok", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
    });
    const port = await server.listen();
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello" }));
    expect(await next(ws)).toMatchObject({ type: "hello_ok", version: "0.3.0" });
    ws.close();
  });

  it("rejects opening a codex session when the codex binary is unavailable", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new Session(new FakeBackend()),
      stores: { claude: fakeStore(), codex: fakeStore() },
      checkCodex: async () => { throw new CodexUnavailableError("cannot run codex"); },
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "new", agent: "codex", nonce: "n0" }));
    const err = await waitFor(msgs, (m) => m.type === "error");
    expect(err).toMatchObject({ type: "error", code: "codex_unavailable" });
    // No session_started must arrive for the failed preflight.
    await new Promise((r) => setTimeout(r, 30));
    expect(msgs.find((m) => m.type === "session_started")).toBeUndefined();
    ws.close();
  });

  it("serves per-agent history from the agent's own store", async () => {
    const codexItem: HistoryItem = { role: "user", text: "from codex", tools: [] };
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new Session(new FakeBackend()),
      stores: {
        claude: fakeStore({ history: () => [] }),
        codex: fakeStore({ history: () => [codexItem] }),
      },
      checkCodex: async () => "codex 0.99.0",
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "latest", agent: "codex", nonce: "n0" }));
    const hist = await waitFor(msgs, (m) => m.type === "history");
    expect(hist).toMatchObject({ type: "history", items: [codexItem] });
    ws.close();
  });

  it("reattaches a live codex session even when the preflight would fail", async () => {
    let checks = 0;
    const fake = new FakeSession();
    let made = 0;
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => { made++; return fake as any; },
      stores: { claude: fakeStore(), codex: fakeStore() },
      checkCodex: async () => {
        checks++;
        if (checks > 1) throw new CodexUnavailableError("flaky");
        return "codex 0.99.0";
      },
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");

    // First open_session: preflight runs (checks === 1), session starts.
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "new", agent: "codex", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(checks).toBe(1);

    // Re-open the same live session: preflight must be skipped entirely.
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "latest", agent: "codex", nonce: "n1" }));
    await waitFor(msgs, () => fake.reattached > 0);

    // No codex_unavailable error must have arrived.
    expect(msgs.find((m) => m.type === "error" && (m as any).code === "codex_unavailable")).toBeUndefined();
    // checkCodex was NOT called a second time.
    expect(checks).toBe(1);
    // Only one session was ever created; the second open reattached.
    expect(made).toBe(1);
    ws.close();
  });

  it("merges claude and codex projects into one entry per path", async () => {
    const claudeProj: StoreProject = { path: "/p", lastSessionId: "c1", lastActive: 1, lastMessage: null };
    const codexProj: StoreProject = { path: "/p", lastSessionId: "x1", lastActive: 2, lastMessage: null };
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new Session(new FakeBackend()),
      stores: {
        claude: fakeStore({ listProjects: () => [claudeProj] }),
        codex: fakeStore({ listProjects: () => [codexProj] }),
      },
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "list_projects" }));
    const got = await waitFor(msgs, (m) => m.type === "projects") as Extract<BridgeToClient, { type: "projects" }>;
    expect(got.projects).toHaveLength(1);
    const [proj] = got.projects;
    expect(proj!.agents.claude?.lastSessionId).toBe("c1");
    expect(proj!.agents.codex?.lastSessionId).toBe("x1");
    ws.close();
  });

  it("lists sessions and opens one by sessionKey", async () => {
    const home = mkdtempSync(join(tmpdir(), "srv-ls-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "ai-title", value: "T1" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    ].join("\n") + "\n");
    const fake = new FakeSession();
    server = new BridgeServer({ config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => fake as any, claudeHome: home });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "list_sessions", projectPath: "/Users/me/app", agent: "claude" }));
    const list = await waitFor(msgs, (m) => m.type === "sessions");
    expect((list as any).sessions[0].title).toBe("T1");
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/Users/me/app", agent: "claude", resume: "s1", nonce: "n1" }));
    const started = await waitFor(msgs, (m) => m.type === "session_started");
    expect((started as any).nonce).toBe("n1");
    expect((started as any).sessionKey).toBeTruthy();
    ws.close(); rmSync(home, { recursive: true, force: true });
  });
});
