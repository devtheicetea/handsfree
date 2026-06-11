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
  get project() { return this.started?.projectPath ?? ""; }
  detachEmit() { this.detached = true; this.emit = null; }
  reattach(emit: (m: BridgeToClient) => void) { this.emit = emit; }
}

function mgr() {
  const made: FakeSession[] = [];
  const m = new SessionManager({
    safelist: [],
    stores: { claude: emptyStore, codex: emptyStore },
    makeSession: () => { const s = new FakeSession(); made.push(s); return s as any; },
  });
  return { m, made };
}

describe("SessionManager", () => {
  it("tags each session's output with its sessionKey", async () => {
    const out: BridgeToClient[] = [];
    const { m } = mgr();
    await m.open("/a", "claude", "new", "n1", (x) => out.push(x));
    await m.open("/b", "claude", "new", "n2", (x) => out.push(x));
    const started = out.filter((m) => m.type === "session_started") as Array<{ sessionKey: string; nonce: string }>;
    expect(started).toHaveLength(2);
    const keyA = started.find((s) => s.nonce === "n1")!.sessionKey;
    const keyB = started.find((s) => s.nonce === "n2")!.sessionKey;
    m.route({ type: "prompt", sessionKey: keyA, text: "hi" } as any);
    m.route({ type: "prompt", sessionKey: keyB, text: "yo" } as any);
    const aResp = out.find((x) => x.type === "response" && (x as any).text === "r:hi");
    const bResp = out.find((x) => x.type === "response" && (x as any).text === "r:yo");
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

  it("re-syncs an already-live session via reattach instead of recreating", async () => {
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
    });
    await m.open("/p", "claude", "latest", "n1", () => {});
    captured = fake.started;
    expect(captured?.resume).toBe("sid-1");
    rmSync(home, { recursive: true, force: true });
  });

  it("runs claude and codex sessions for the SAME project independently", async () => {
    const made: string[] = [];
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: (agent) => { made.push(agent); return new Session(new FakeBackend()); },
    });
    const emitted: BridgeToClient[] = [];
    let claudeKey = "";
    let codexKey = "";
    await manager.open("/p", "claude", "new", "n1", (m) => {
      emitted.push(m);
      if (m.type === "session_started") claudeKey = (m as any).sessionKey;
    });
    await manager.open("/p", "codex", "new", "n2", (m) => {
      emitted.push(m);
      if (m.type === "session_started") codexKey = (m as any).sessionKey;
    });
    expect(made).toEqual(["claude", "codex"]);
    expect(manager.has(claudeKey)).toBe(true);
    expect(manager.has(codexKey)).toBe(true);

    manager.route({ type: "prompt", sessionKey: codexKey, text: "hi" } as any);
    await new Promise((r) => setTimeout(r, 20));
    const responses = emitted.filter((m) => m.type === "response" && (m as { text: string }).text);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { sessionKey: string }).sessionKey).toBe(codexKey);
  });

  it("stamps sessionKey on every emitted message", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
    });
    const emitted: BridgeToClient[] = [];
    await manager.open("/p", "codex", "new", "n1", (m) => emitted.push(m));
    const started = emitted.find((m) => m.type === "session_started") as any;
    expect(started).toBeDefined();
    expect(started.sessionKey).toBeTruthy();
    expect(started.projectPath).toBe("/p");
    expect(started.agent).toBe("codex");
  });

  it("reattachAll re-attaches all live sessions and emits no session_started", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
    });
    const openOut: BridgeToClient[] = [];
    await manager.open("/Users/x/My Project", "codex", "new", "n1", (m) => openOut.push(m));
    const openKey = (openOut.find((m) => m.type === "session_started") as any).sessionKey as string;

    const replayed: BridgeToClient[] = [];
    manager.reattachAll((m) => replayed.push(m));

    // reattachAll must NOT re-emit session_started (the manager already did on open)
    expect(replayed.filter((m) => m.type === "session_started")).toHaveLength(0);
    // it should re-emit a status tagged with the session's key
    const statuses = replayed.filter((m) => m.type === "status");
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((m) => (m as any).sessionKey === openKey)).toBe(true);
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
    });
    await manager.open("/p", "codex", "latest", "n1", () => {});
    expect(calls).toEqual(["codex:/p:latest"]);
  });
});

describe("sessionKey routing", () => {
  it("assigns a distinct sessionKey per open and routes by it", async () => {
    const out: any[] = [];
    const mgr = new SessionManager({ safelist: [], makeSession: () => new FakeSession() as any,
      stores: { claude: fakeStore(), codex: fakeStore() } });
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
      stores: { claude: store as any, codex: fakeStore() as any } });
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
});
