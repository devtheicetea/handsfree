import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
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
import type { SessionWatcherDeps } from "../src/watcher.js";

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
  get currentTurn(): number { return 0; }
  /** Replay in-flight state to a new subscriber (mirrors real Session.replayTo). */
  replayTo(emit: (m: BridgeToClient) => void) {
    this.reattached++;
    emit({ type: "status", state: "idle" } as any);
  }
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
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "sess-x1", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(made).toBe(1);
    // The app re-sends open_session for the same project on every reconnect — the
    // bridge must reattach by resumeId, not tear down + recreate (which aborts the in-flight turn).
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "sess-x1", nonce: "n1" }));
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
    a.send(JSON.stringify({ type: "hello", clientId: "client-A" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 20));
    a.close();
    await new Promise((r) => setTimeout(r, 20));

    const b = await connect(port);
    const msgs = collect(b);
    b.send(JSON.stringify({ type: "hello", clientId: "client-B" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    // reattachAllTo replays the in-flight turn state (status) to the new client.
    await waitFor(msgs, (m) => m.type === "status");
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
    a.send(JSON.stringify({ type: "hello", clientId: "client-A" }));
    await next(a);
    a.send(JSON.stringify({ type: "open_session", projectPath: "/x", resume: "new", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 20));
    a.close();
    await new Promise((r) => setTimeout(r, 20));

    const b = await connect(port);
    const msgs = collect(b);
    b.send(JSON.stringify({ type: "hello", clientId: "client-B" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    // Wait for reattach replay (status) before triggering a new permission request.
    await waitFor(msgs, (m) => m.type === "status");

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
      async start(p: StartParams) { this.emit = p.emit; p.emit({ type: "status", state: "error" } as any); p.emit({ type: "error", code: "session_crashed", message: "boom" }); }
      prompt() {}
      abortTurn() {}
      async stop() {}
      isActive() { return this.active; }
      detachEmit() { this.emit = null; }
      replayTo() {}
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

  it("a second client with the SAME clientId supersedes the first", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      checkCodex: async () => "codex 0.139.0",
    });
    const port = await server.listen();
    const a = await connect(port);
    a.send(JSON.stringify({ type: "hello", clientId: "shared-id" }));
    await next(a);   // hello_ok for the first client
    const aSuperseded = next(a);   // listen before b connects (avoids a message race)
    const b = await connect(port);
    b.send(JSON.stringify({ type: "hello", clientId: "shared-id" }));
    // The new client connects successfully...
    expect(await next(b)).toMatchObject({ type: "hello_ok" });
    // ...and the old one is told it was superseded (same clientId).
    expect(await aSuperseded).toMatchObject({ type: "error", code: "superseded" });
    a.close(); b.close();
  });

  it("does not close a different client when a new clientId connects", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      stores: { claude: fakeStore(), codex: fakeStore() },
    });
    const port = await server.listen();

    // Connect client A with its own clientId.
    const a = await connect(port);
    const aMsgs = collect(a);
    a.send(JSON.stringify({ type: "hello", clientId: "A" }));
    await waitFor(aMsgs, (m) => m.type === "hello_ok");

    // Connect client B with a DIFFERENT clientId — must NOT supersede A.
    const b = await connect(port);
    const bMsgs = collect(b);
    b.send(JSON.stringify({ type: "hello", clientId: "B" }));
    await waitFor(bMsgs, (m) => m.type === "hello_ok");

    // Give a moment for any spurious "superseded" to arrive.
    await new Promise((r) => setTimeout(r, 50));

    // A must NOT have received a superseded error.
    expect(aMsgs.find((m) => m.type === "error" && (m as any).code === "superseded")).toBeUndefined();
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

  it("mirrors REAL file appends end-to-end: view_session -> append -> external_turns (real watcher)", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "srv-codex-"));
    const claudeHome = mkdtempSync(join(tmpdir(), "srv-claude-"));
    const day = join(codexHome, "sessions", "2026", "06", "11");
    mkdirSync(day, { recursive: true });
    const meta = JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "thr_e2e", cwd: "/p", cli_version: "0.139.0" } }) + "\n";
    const assistant = JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "live from laptop" }] } }) + "\n";
    const file = join(day, "rollout-2026-06-11T10-00-00-thr_e2e.jsonl");
    writeFileSync(file, meta);

    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      claudeHome,
      codexHome,
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");

    ws.send(JSON.stringify({ type: "view_session", projectPath: "/p", agent: "codex", sessionId: "thr_e2e" }));
    await waitFor(msgs, (m) => m.type === "session_history");

    appendFileSync(file, assistant);
    const turns = await waitFor(msgs, (m) => m.type === "external_turns", 4000);
    expect((turns as any).sessionId).toBe("thr_e2e");
    expect((turns as any).items).toEqual([{ role: "assistant", text: "live from laptop", tools: [] }]);

    ws.close();
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  it("reports protocol version and agent capabilities in hello_ok", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      checkCodex: async () => "codex 0.139.0",
    });
    const port = await server.listen();
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello" }));
    expect(await next(ws)).toMatchObject({ type: "hello_ok", version: "0.8.0", agents: { claude: true, codex: true } });
    ws.close();
  });

  it("advertises codex: false in hello_ok when the preflight fails", async () => {
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      checkCodex: async () => { throw new CodexUnavailableError("cannot run codex"); },
    });
    const port = await server.listen();
    const ws = await connect(port);
    ws.send(JSON.stringify({ type: "hello" }));
    expect(await next(ws)).toMatchObject({ type: "hello_ok", agents: { claude: true, codex: false } });
    ws.close();
  });

  it("view_session snapshots history, registers the watch, and routes watcher events per ownership", async () => {
    let watcherDeps: SessionWatcherDeps | null = null;
    let starts = 0;
    let stops = 0;
    const item: HistoryItem = { role: "user", text: "from laptop", tools: [] };
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => new FakeSession() as any,
      stores: { claude: fakeStore(), codex: fakeStore({ history: () => [item] }) },
      makeWatcher: (d) => { watcherDeps = d; return { start: () => { starts++; }, stop: () => { stops++; } } as any; },
    });
    const port = await server.listen();
    expect(starts).toBe(1); // watcher runs with the server
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");

    ws.send(JSON.stringify({ type: "view_session", projectPath: "/p", agent: "codex", sessionId: "thr_1" }));
    const hist = await waitFor(msgs, (m) => m.type === "session_history");
    expect(hist).toMatchObject({ projectPath: "/p", agent: "codex", sessionId: "thr_1", items: [item] });

    // watched + un-owned -> external_turns AND session_activity (with preview)
    watcherDeps!.onEvent({ agent: "codex", projectPath: "/p", sessionId: "thr_1", items: [item], lastActive: 7, owned: false });
    await waitFor(msgs, (m) => m.type === "external_turns" && (m as any).sessionId === "thr_1");
    const act = await waitFor(msgs, (m) => m.type === "session_activity" && (m as any).lastActive === 7);
    expect((act as any).preview).toMatchObject({ text: "from laptop" });

    // a different (unwatched) session -> session_activity to ALL clients (list freshness), but no external_turns
    watcherDeps!.onEvent({ agent: "codex", projectPath: "/p", sessionId: "thr_2", items: [item], lastActive: 8, owned: false });
    // session_activity for thr_2 IS delivered to all connected clients (list freshness).
    // external_turns for thr_2 is NOT delivered since the client only mirrors thr_1.
    await waitFor(msgs, (m) => m.type === "session_activity" && (m as any).sessionId === "thr_2");
    expect(msgs.some((m) => m.type === "external_turns" && (m as any).sessionId === "thr_2")).toBe(false);

    // owned (bridge-authored) -> no external_turns echo even when watched
    watcherDeps!.onEvent({ agent: "codex", projectPath: "/p", sessionId: "thr_1", items: [item], lastActive: 9, owned: true });
    await waitFor(msgs, (m) => m.type === "session_activity" && (m as any).lastActive === 9);
    expect(msgs.filter((m) => m.type === "external_turns")).toHaveLength(1);

    // unview clears the watch -> no more external_turns mirror events, but session_activity still fans out
    ws.send(JSON.stringify({ type: "unview_session" }));
    await new Promise((r) => setTimeout(r, 30));
    watcherDeps!.onEvent({ agent: "codex", projectPath: "/p", sessionId: "thr_1", items: [item], lastActive: 10, owned: false });
    // session_activity for lastActive=10 IS still delivered (list freshness, all clients)
    await waitFor(msgs, (m) => m.type === "session_activity" && (m as any).lastActive === 10);
    // external_turns still only the one from the initial watched event (unview stopped mirror delivery)
    expect(msgs.filter((m) => m.type === "external_turns")).toHaveLength(1);

    ws.close();
    await server.close();
    expect(stops).toBeGreaterThan(0); // watcher stops with the server
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
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "sess-p1", agent: "codex", nonce: "n0" }));
    await new Promise((r) => setTimeout(r, 30));
    expect(checks).toBe(1);

    // Re-open the same live session by its resumeId: preflight must be skipped entirely
    // (hasForProject returns true) and the session must reattach by resumeId (not project+agent).
    ws.send(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "sess-p1", agent: "codex", nonce: "n1" }));
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

  it("replies no_session tagged with the sessionKey for an unknown session", async () => {
    const fake = new FakeSession();
    server = new BridgeServer({
      config: { port: 0, bindAddress: "127.0.0.1", token: null, safelist: [], codexPath: null },
      makeSession: () => fake as any,
    });
    const port = await server.listen();
    const ws = await connect(port);
    const msgs = collect(ws);
    ws.send(JSON.stringify({ type: "hello" }));
    await waitFor(msgs, (m) => m.type === "hello_ok");
    ws.send(JSON.stringify({ type: "prompt", sessionKey: "gone-key", text: "hi" }));
    const err = await waitFor(msgs, (m) => m.type === "error");
    expect((err as any).code).toBe("no_session");
    expect((err as any).sessionKey).toBe("gone-key");
    ws.close();
  });
});
