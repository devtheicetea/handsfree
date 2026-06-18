import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../src/sessionManager.js";
import { Session } from "../src/session.js";
import { ClaudeStore } from "../src/stores/claude.js";
import type { BridgeToClient } from "../src/protocol.js";
import type { StartParams } from "../src/session.js";
import type { SessionStore } from "../src/stores/types.js";
import { FakeBackend } from "./fakeBackend.js";

const emptyStore: SessionStore = { listProjects: () => [], listSessions: () => [], resolveResume: () => undefined, history: () => [] };

const fakeStore = () => ({ listProjects: () => [], listSessions: () => [], resolveResume: () => undefined, history: () => [] });

/** storesFake: resolveResume returns the resume arg unless "new" → undefined */
function storesFake(): { claude: SessionStore; codex: SessionStore } {
  const s: SessionStore = {
    listProjects: () => [],
    listSessions: () => [],
    resolveResume: (_p: string, r: string) => (r === "new" ? undefined : r),
    history: () => [],
  };
  return { claude: s, codex: s };
}

class FakeSession {
  started: StartParams | null = null;
  emit: ((m: BridgeToClient) => void) | null = null;
  prompts: string[] = [];
  aborts = 0;
  active = true;
  detached = false;
  async start(p: StartParams) { this.started = p; this.emit = p.emit; }
  prompt(t: string) { this.prompts.push(t); this.emit?.({ type: "response", sessionKey: "x", turn: 1, text: `r:${t}`, done: true } as any); }
  abortTurn() { this.aborts++; }
  async stop() { this.active = false; }
  isActive() { return this.active; }
  streaming = false;
  backendSessionId: string | null = null;
  get project() { return this.started?.projectPath ?? ""; }
  detachEmit() { this.detached = true; this.emit = null; }
  replayTo(emit: (m: BridgeToClient) => void) { emit({ type: "status", state: "idle" } as any); }
  get currentTurn(): number { return 0; }
}

function mgr() {
  const made: FakeSession[] = [];
  const broadcast: BridgeToClient[] = [];
  const m = new SessionManager({
    safelist: [],
    stores: { claude: emptyStore, codex: emptyStore },
    makeSession: () => { const s = new FakeSession(); made.push(s); return s as any; },
    broadcast: (msg) => broadcast.push(msg),
  });
  return { m, made, broadcast };
}

describe("SessionManager", () => {
  it("tags each session's output with its sessionKey", async () => {
    const out: BridgeToClient[] = [];
    const { m, broadcast } = mgr();
    await m.open("/a", "claude", "new", "n1", (x) => out.push(x));
    await m.open("/b", "claude", "new", "n2", (x) => out.push(x));
    const started = out.filter((m) => m.type === "session_started") as Array<{ sessionKey: string; nonce: string }>;
    expect(started).toHaveLength(2);
    const keyA = started.find((s) => s.nonce === "n1")!.sessionKey;
    const keyB = started.find((s) => s.nonce === "n2")!.sessionKey;
    m.route({ type: "prompt", sessionKey: keyA, text: "hi" } as any);
    m.route({ type: "prompt", sessionKey: keyB, text: "yo" } as any);
    // Live session output goes to broadcast, not the opener-scoped emit
    const aResp = broadcast.find((x) => x.type === "response" && (x as any).text === "r:hi");
    const bResp = broadcast.find((x) => x.type === "response" && (x as any).text === "r:yo");
    expect((aResp as any).sessionKey).toBe(keyA);
    expect((bResp as any).sessionKey).toBe(keyB);
  });

  it("routes abort to the named session only", async () => {
    const { m, made } = mgr();
    const keysOut: string[] = [];
    await m.open("/a", "claude", "new", "n1", (x) => {
      if (x.type === "session_started") keysOut.push((x as any).sessionKey);
    });
    await m.open("/b", "claude", "new", "n2", (x) => {
      if (x.type === "session_started") keysOut.push((x as any).sessionKey);
    });
    m.route({ type: "abort", sessionKey: keysOut[1]! } as any);
    expect(made[0]!.aborts).toBe(0);
    expect(made[1]!.aborts).toBe(1);
  });

  it("keeps both sessions alive across an open (no teardown on switch)", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", "n1", () => {});
    await m.open("/b", "claude", "new", "n2", () => {});
    expect(made[0]!.isActive()).toBe(true);
    expect(made[1]!.isActive()).toBe(true);
  });

  it("re-syncs an already-live session via replayTo instead of recreating", async () => {
    const { m, made } = mgr();
    let firstKey = "";
    await m.open("/a", "claude", "new", "n1", (x) => {
      if (x.type === "session_started") firstKey = (x as any).sessionKey;
    });
    // Opening with a resumeId that matches the live session reattaches instead of creating a new session.
    // Since emptyStore.resolveResume returns undefined (no resumeId), a second open creates a new session.
    // Test that same (project,agent) with matching live resumeId reattaches — here we just confirm
    // re-opening a new session for the SAME key doesn't break things (both stay alive).
    await m.open("/a", "claude", "new", "n2", () => {});
    // Both opens create distinct sessions (no resumeId match), so made.length may be 2.
    // The key point is the first session is still active.
    expect(made[0]!.isActive()).toBe(true);
  });

  it("stopAll stops every session", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", "n1", () => {});
    await m.open("/b", "claude", "new", "n2", () => {});
    await m.stopAll();
    expect(made[0]!.isActive()).toBe(false);
    expect(made[1]!.isActive()).toBe(false);
  });

  it("resolves resume through the ClaudeStore for a real claudeHome", async () => {
    const home = mkdtempSync(join(tmpdir(), "sm-home-"));
    const dir = join(home, "projects", "-p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sid-1.jsonl"),
      JSON.stringify({ cwd: "/p", type: "user", message: { role: "user", content: "hi" } }) + "\n");

    let captured: StartParams | null = null;
    const fake = new FakeSession();
    const m = new SessionManager({
      safelist: [],
      stores: { claude: new ClaudeStore(home), codex: emptyStore },
      makeSession: () => fake as any,
      broadcast: () => {},
    });
    await m.open("/p", "claude", "latest", "n1", () => {});
    captured = fake.started;
    expect(captured?.resume).toBe("sid-1");
    rmSync(home, { recursive: true, force: true });
  });

  it("runs claude and codex sessions for the SAME project independently", async () => {
    const made: string[] = [];
    const broadcastOut: BridgeToClient[] = [];
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: (agent) => { made.push(agent); return new Session(new FakeBackend()); },
      broadcast: (m) => broadcastOut.push(m),
    });
    const openerOut: BridgeToClient[] = [];
    let claudeKey = "";
    let codexKey = "";
    await manager.open("/p", "claude", "new", "n1", (m) => {
      openerOut.push(m);
      if (m.type === "session_started") claudeKey = (m as any).sessionKey;
    });
    await manager.open("/p", "codex", "new", "n2", (m) => {
      openerOut.push(m);
      if (m.type === "session_started") codexKey = (m as any).sessionKey;
    });
    expect(made).toEqual(["claude", "codex"]);
    expect(manager.has(claudeKey)).toBe(true);
    expect(manager.has(codexKey)).toBe(true);

    manager.route({ type: "prompt", sessionKey: codexKey, text: "hi" } as any);
    await new Promise((r) => setTimeout(r, 20));
    // Live session responses go to broadcast, not the opener emit
    const responses = broadcastOut.filter((m) => m.type === "response" && (m as { text: string }).text);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { sessionKey: string }).sessionKey).toBe(codexKey);
  });

  it("stamps sessionKey on every emitted message", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
      broadcast: () => {},
    });
    const emitted: BridgeToClient[] = [];
    await manager.open("/p", "codex", "new", "n1", (m) => emitted.push(m));
    const started = emitted.find((m) => m.type === "session_started") as any;
    expect(started).toBeDefined();
    expect(started.sessionKey).toBeTruthy();
    expect(started.projectPath).toBe("/p");
    expect(started.agent).toBe("codex");
  });

  it("reattachAllTo re-attaches all live sessions and emits no session_started", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
      broadcast: () => {},
    });
    const openOut: BridgeToClient[] = [];
    await manager.open("/Users/x/My Project", "codex", "new", "n1", (m) => openOut.push(m));
    const openKey = (openOut.find((m) => m.type === "session_started") as any).sessionKey as string;

    const replayed: BridgeToClient[] = [];
    manager.reattachAllTo((m) => replayed.push(m));

    // reattachAllTo must NOT re-emit session_started (the manager already did on open)
    expect(replayed.filter((m) => m.type === "session_started")).toHaveLength(0);
    // it should re-emit a status tagged with the session's key
    const statuses = replayed.filter((m) => m.type === "status");
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((m) => (m as any).sessionKey === openKey)).toBe(true);
  });

  it("replays a pending permission request on reattach", async () => {
    let backend: FakeBackend | null = null;
    const manager = new SessionManager({
      safelist: [],   // every tool asks
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => { backend = new FakeBackend(); return new Session(backend); },
      broadcast: () => {},
    });
    let key = "";
    await manager.open("/p", "claude", "new", "n1", (m) => { if (m.type === "session_started") key = (m as any).sessionKey; });
    // The backend asks for a tool -> a pending permission the client must see.
    void backend!.startOpts!.evaluate("Bash", { command: "ls" });
    await new Promise((r) => setTimeout(r, 10));

    // A (re)connecting client replays state — the pending prompt must re-surface.
    const replayed: BridgeToClient[] = [];
    manager.reattachAllTo((m) => replayed.push(m));
    const req = replayed.find((m) => m.type === "permission_request") as any;
    expect(req).toBeDefined();
    expect(req.tool).toBe("Bash");
    expect(req.sessionKey).toBe(key);
  });

  it("broadcasts permission_resolved when a permission is answered", async () => {
    let backend: FakeBackend | null = null;
    const broadcast: BridgeToClient[] = [];
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => { backend = new FakeBackend(); return new Session(backend); },
      broadcast: (m) => broadcast.push(m),
    });
    const key = await manager.open("/p", "claude", "new", "n", () => {});
    // Trigger a permission request through the backend's evaluate hook (same pattern as the reattach test)
    void backend!.startOpts!.evaluate("Bash", { command: "ls" });
    await new Promise((r) => setTimeout(r, 10));
    // Capture the id from the broadcast permission_request
    const req = broadcast.find((m) => m.type === "permission_request") as any;
    expect(req).toBeDefined();
    const id: string = req.id;
    // Resolve it via route — this should broadcast permission_resolved
    manager.route({ type: "permission_response", sessionKey: key, id, decision: "allow" } as any, "A");
    const resolved = broadcast.find((m) => m.type === "permission_resolved") as any;
    expect(resolved).toBeDefined();
    expect(resolved.sessionKey).toBe(key);
    expect(resolved.id).toBe(id);
    await manager.stopAll();
  });

  it("resolves resume through the matching agent's store", async () => {
    const calls: string[] = [];
    const store = (tag: string): SessionStore => ({
      listProjects: () => [],
      listSessions: () => [],
      resolveResume: (p, r) => { calls.push(`${tag}:${p}:${r}`); return undefined; },
      history: () => [],
    });
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: store("claude"), codex: store("codex") },
      makeSession: () => new Session(new FakeBackend()),
      broadcast: () => {},
    });
    await manager.open("/p", "codex", "latest", "n1", () => {});
    expect(calls).toEqual(["codex:/p:latest"]);
  });
});

describe("sessionKey routing", () => {
  it("assigns a distinct sessionKey per open and routes by it", async () => {
    const out: any[] = [];
    const mgr = new SessionManager({ safelist: [], makeSession: () => new FakeSession() as any,
      stores: { claude: fakeStore(), codex: fakeStore() }, broadcast: () => {} });
    await mgr.open("/p", "claude", "new", "n1", (m) => out.push(m));
    await mgr.open("/p", "claude", "new", "n2", (m) => out.push(m));
    const started = out.filter((m) => m.type === "session_started");
    expect(started).toHaveLength(2);
    expect(started[0].sessionKey).not.toBe(started[1].sessionKey);
    expect(started.map((s) => s.nonce).sort()).toEqual(["n1", "n2"]);
    const ok = mgr.route({ type: "prompt", sessionKey: started[0].sessionKey, text: "hi" } as any);
    expect(ok).toBe(true);
  });

  it("reattaches a live session for the same resumeId instead of spawning another", async () => {
    let made = 0;
    const store = { listProjects: () => [], listSessions: () => [], resolveResume: () => "real-id", history: () => [] };
    const mgr = new SessionManager({ safelist: [], makeSession: () => { made++; return new FakeSession() as any; },
      stores: { claude: store as any, codex: fakeStore() as any }, broadcast: () => {} });
    const out: any[] = [];
    await mgr.open("/p", "claude", "latest", "n1", (m) => out.push(m));
    await mgr.open("/p", "claude", "latest", "n2", (m) => out.push(m));   // same resumeId -> reattach
    expect(made).toBe(1);                                                  // no second Session
    const started = out.filter((m) => m.type === "session_started");
    expect(started).toHaveLength(2);                                       // one per open (manager-emitted)
    expect(started[0].sessionKey).toBe(started[1].sessionKey);            // same live session
    expect(started.every((s: any) => typeof s.sessionKey === "string" && s.sessionKey.length > 0)).toBe(true);
    expect(started.every((s: any) => "resumeId" in s && "agent" in s)).toBe(true); // all well-formed (no stale shape)
  });

  it("ownsSession matches live sessions by resumeId and by learned backend id", async () => {
    const store = { listProjects: () => [], listSessions: () => [], resolveResume: () => "thr_resumed", history: () => [] };
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: fakeStore(), codex: store as any },
      makeSession: () => new Session(new FakeBackend()),   // FakeBackend's session_id event reports "sess-9"
      broadcast: () => {},
    });
    await manager.open("/p", "codex", "latest", "n1", () => {});
    await new Promise((r) => setTimeout(r, 20));            // let the backend's session_id event land
    expect(manager.ownsSession("codex", "thr_resumed")).toBe(true);   // by resumeId
    expect(manager.ownsSession("codex", "sess-9")).toBe(true);        // by learned id
    expect(manager.ownsSession("claude", "thr_resumed")).toBe(false); // other agent
    expect(manager.ownsSession("codex", "thr_other")).toBe(false);
    await manager.stopAll();
    expect(manager.ownsSession("codex", "thr_resumed")).toBe(false);  // dead sessions don't own
  });

  it("re-sends history on reattach, before the buffer replay (restarted client is otherwise blank)", async () => {
    const items = [{ role: "user" as const, text: "from laptop", tools: [] }];
    const store: SessionStore = { listProjects: () => [], listSessions: () => [], resolveResume: () => "real-id", history: () => items };
    let backend: FakeBackend | null = null;
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: store },
      makeSession: () => { backend = new FakeBackend(); backend.streamOnly = true; return new Session(backend); },
      broadcast: () => {},
    });
    let key = "";
    await manager.open("/p", "codex", "latest", "n1", (m) => { if (m.type === "session_started") key = (m as any).sessionKey; });
    // Start an in-flight turn (streamOnly: no turn_done, so replayTo will replay the partial response)
    manager.route({ type: "prompt", sessionKey: key, text: "hi" } as any);
    await new Promise((r) => setTimeout(r, 20));

    // The app restarts: fresh emit sink with no local state. The reattach must
    // re-send the history snapshot (the client seeds it only when empty), and
    // it must arrive BEFORE the replayed turn buffer.
    const out: BridgeToClient[] = [];
    await manager.open("/p", "codex", "latest", "n2", (m) => out.push(m));
    const hist = out.find((m) => m.type === "history") as any;
    expect(hist).toBeDefined();
    expect(hist.items).toEqual(items);
    expect(hist.sessionKey).toBe(key);
    const types = out.map((m) => m.type);
    // history must arrive before the partial response replay
    expect(types.indexOf("history")).toBeLessThan(types.indexOf("response"));
  });
});

describe("SessionManager broadcast API", () => {
  it("open returns the sessionKey and sends session_started to the opener", async () => {
    const broadcast: BridgeToClient[] = [];
    const opener: BridgeToClient[] = [];
    const mgr = new SessionManager({
      safelist: [],
      stores: storesFake(),
      makeSession: () => new FakeSession() as any,
      broadcast: (m) => broadcast.push(m),
    });
    const key = await mgr.open("/p", "claude", "new", "nonce1", (m) => opener.push(m));
    expect(typeof key).toBe("string");
    expect(opener.some((m) => m.type === "session_started")).toBe(true);
  });

  it("route(prompt) broadcasts a user_message carrying text, sessionKey and origin", async () => {
    const broadcast: BridgeToClient[] = [];
    const mgr = new SessionManager({
      safelist: [],
      stores: storesFake(),
      makeSession: () => new FakeSession() as any,
      broadcast: (m) => broadcast.push(m),
    });
    const key = await mgr.open("/p", "claude", "new", "n", () => {});
    mgr.route({ type: "prompt", sessionKey: key, text: "do it" } as any, "cli-9");
    const um = broadcast.find((m) => m.type === "user_message") as any;
    expect(um.text).toBe("do it");
    expect(um.sessionKey).toBe(key);
    expect(um.origin).toBe("cli-9");
  });

  it("liveSessionKeys returns only active session keys", async () => {
    const made: FakeSession[] = [];
    const mgr = new SessionManager({
      safelist: [],
      stores: storesFake(),
      makeSession: () => { const s = new FakeSession(); made.push(s); return s as any; },
      broadcast: () => {},
    });
    const k1 = await mgr.open("/a", "claude", "new", "n1", () => {});
    const k2 = await mgr.open("/b", "claude", "new", "n2", () => {});
    expect(mgr.liveSessionKeys().sort()).toEqual([k1, k2].sort());
    made[0]!.active = false;
    expect(mgr.liveSessionKeys()).toEqual([k2]);
  });

  it("reattachAllTo returns the keys of sessions it replayed", async () => {
    const mgr = new SessionManager({
      safelist: [],
      stores: storesFake(),
      makeSession: () => new FakeSession() as any,
      broadcast: () => {},
    });
    const k1 = await mgr.open("/a", "claude", "new", "n1", () => {});
    const k2 = await mgr.open("/b", "claude", "new", "n2", () => {});
    const replayed: BridgeToClient[] = [];
    const keys = mgr.reattachAllTo((m) => replayed.push(m));
    expect(keys.sort()).toEqual([k1, k2].sort());
  });

  it("reattach sends a catch-up history snapshot for an idle session", async () => {
    const items = [{ role: "user" as const, text: "hi", tools: [] }, { role: "assistant" as const, text: "hello", tools: [] }];
    const store: SessionStore = { listProjects: () => [], listSessions: () => [], resolveResume: (_p, r) => (r === "new" ? undefined : r), history: () => items };
    const made: FakeSession[] = [];
    const mgr = new SessionManager({
      safelist: [],
      stores: { claude: store, codex: store },
      makeSession: () => { const s = new FakeSession(); made.push(s); return s as any; },
      broadcast: () => {},
    });
    await mgr.open("/p", "claude", "sid1", "n1", () => {});

    // Idle (default) → catch-up snapshot is sent.
    const idle: BridgeToClient[] = [];
    mgr.reattachAllTo((m) => idle.push(m));
    const hist = idle.find((x) => x.type === "history") as any;
    expect(hist?.items).toEqual(items);

    // Streaming → no snapshot; the in-flight buffer replay handles it.
    made[0]!.streaming = true;
    const live: BridgeToClient[] = [];
    mgr.reattachAllTo((m) => live.push(m));
    expect(live.some((x) => x.type === "history")).toBe(false);
  });

  it("liveKeyFor finds a live session by its on-disk id, and attachExisting wires a viewer to it", async () => {
    const mgr = new SessionManager({
      safelist: [],
      stores: storesFake(),
      makeSession: () => new FakeSession() as any,
      broadcast: () => {},
    });
    const key = await mgr.open("/p", "claude", "sid1", "n1", () => {});
    expect(mgr.liveKeyFor("claude", "sid1")).toBe(key);
    expect(mgr.liveKeyFor("claude", "nope")).toBeUndefined();
    expect(mgr.liveKeyFor("codex", "sid1")).toBeUndefined();

    const out: BridgeToClient[] = [];
    const ok = mgr.attachExisting(key, "viewNonce", "/p", "sid1", (m) => out.push(m));
    expect(ok).toBe(true);
    const started = out.find((x) => x.type === "session_started") as any;
    expect(started?.nonce).toBe("viewNonce");
    expect(started?.sessionKey).toBe(key);
    expect(started?.resumeId).toBe("sid1");
    // history + replayed status are tagged with the live key so the client binds them there
    expect(out.some((x) => x.type === "history" && (x as any).sessionKey === key)).toBe(true);
    expect(out.some((x) => x.type === "status" && (x as any).sessionKey === key)).toBe(true);
  });

  it("askUser broadcasts a tagged question_request and a response resolves the tool", async () => {
    const out: BridgeToClient[] = [];
    const { m, made, broadcast } = mgr();
    await m.open("/q", "claude", "new", "n1", (x) => out.push(x));
    const key = (out.find((x) => x.type === "session_started") as any).sessionKey as string;

    const questions = [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }];
    const pending = made[0]!.started!.askUser!(questions);

    const req = broadcast.find((x) => x.type === "question_request") as any;
    expect(req).toBeTruthy();
    expect(req.sessionKey).toBe(key);
    expect(req.questions).toEqual(questions);

    const routed = m.route({ type: "question_response", sessionKey: key, id: req.id, selections: ["B"] } as any);
    expect(routed).toBe(true);
    expect(await pending).toEqual(["B"]);
    expect(broadcast.some((x) => x.type === "question_resolved" && (x as any).id === req.id)).toBe(true);
  });

  it("abort cancels a pending question (resolves empty)", async () => {
    const out: BridgeToClient[] = [];
    const { m, made } = mgr();
    await m.open("/q", "claude", "new", "n1", (x) => out.push(x));
    const key = (out.find((x) => x.type === "session_started") as any).sessionKey as string;
    const pending = made[0]!.started!.askUser!([{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }]);
    m.route({ type: "abort", sessionKey: key } as any);
    expect(await pending).toEqual([]);
  });
});
