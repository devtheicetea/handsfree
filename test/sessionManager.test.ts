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

class FakeSession {
  started: StartParams | null = null;
  emit: ((m: BridgeToClient) => void) | null = null;
  prompts: string[] = [];
  aborts = 0;
  active = true;
  detached = false;
  async start(p: StartParams) { this.started = p; this.emit = p.emit; }
  prompt(t: string) { this.prompts.push(t); this.emit?.({ type: "response", projectPath: "X", turn: 1, text: `r:${t}`, done: true } as any); }
  abortTurn() { this.aborts++; }
  async stop() { this.active = false; }
  isActive() { return this.active; }
  get project() { return this.started?.projectPath ?? ""; }
  detachEmit() { this.detached = true; this.emit = null; }
  reattach(emit: (m: BridgeToClient) => void) { this.emit = emit; emit({ type: "session_started", projectPath: this.project, sessionId: "s", mode: "safelist" } as any); }
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
  it("tags each project's output with its projectPath", async () => {
    const out: BridgeToClient[] = [];
    const { m } = mgr();
    await m.open("/a", "claude", "new", (x) => out.push(x));
    await m.open("/b", "claude", "new", (x) => out.push(x));
    m.route({ type: "prompt", projectPath: "/a", agent: "claude", text: "hi" } as any);
    m.route({ type: "prompt", projectPath: "/b", agent: "claude", text: "yo" } as any);
    const aResp = out.find((x) => x.type === "response" && (x as any).text === "r:hi");
    const bResp = out.find((x) => x.type === "response" && (x as any).text === "r:yo");
    expect((aResp as any).projectPath).toBe("/a");
    expect((bResp as any).projectPath).toBe("/b");
  });

  it("routes abort to the named project only", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", () => {});
    await m.open("/b", "claude", "new", () => {});
    m.route({ type: "abort", projectPath: "/b", agent: "claude" } as any);
    expect(made[0]!.aborts).toBe(0);
    expect(made[1]!.aborts).toBe(1);
  });

  it("keeps both sessions alive across an open (no teardown on switch)", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", () => {});
    await m.open("/b", "claude", "new", () => {});
    expect(made[0]!.isActive()).toBe(true);
    expect(made[1]!.isActive()).toBe(true);
  });

  it("re-syncs an already-live project via reattach instead of recreating", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", () => {});
    await m.open("/a", "claude", "latest", () => {});
    expect(made.length).toBe(1);
  });

  it("stopAll stops every session", async () => {
    const { m, made } = mgr();
    await m.open("/a", "claude", "new", () => {});
    await m.open("/b", "claude", "new", () => {});
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
    await m.open("/p", "claude", "latest", () => {});
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
    await manager.open("/p", "claude", "new", (m) => emitted.push(m));
    await manager.open("/p", "codex", "new", (m) => emitted.push(m));
    expect(made).toEqual(["claude", "codex"]);
    expect(manager.has("/p", "claude")).toBe(true);
    expect(manager.has("/p", "codex")).toBe(true);

    manager.route({ type: "prompt", projectPath: "/p", agent: "codex", text: "hi" } as any);
    await new Promise((r) => setTimeout(r, 20));
    const responses = emitted.filter((m) => m.type === "response" && (m as { text: string }).text);
    expect(responses).toHaveLength(1);
    expect((responses[0] as { agent: string }).agent).toBe("codex");
  });

  it("stamps projectPath AND agent on every emitted message", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
    });
    const emitted: BridgeToClient[] = [];
    await manager.open("/p", "codex", "new", (m) => emitted.push(m));
    for (const m of emitted) {
      expect((m as { projectPath: string }).projectPath).toBe("/p");
      expect((m as { agent: string }).agent).toBe("codex");
    }
  });

  it("reattachAll preserves project paths containing spaces", async () => {
    const manager = new SessionManager({
      safelist: [],
      stores: { claude: emptyStore, codex: emptyStore },
      makeSession: () => new Session(new FakeBackend()),
    });
    await manager.open("/Users/x/My Project", "codex", "new", () => {});
    const replayed: BridgeToClient[] = [];
    manager.reattachAll((m) => replayed.push(m));
    const started = replayed.find((m) => m.type === "session_started")!;
    expect((started as { projectPath: string }).projectPath).toBe("/Users/x/My Project");
    expect((started as { agent: string }).agent).toBe("codex");
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
    await manager.open("/p", "codex", "latest", () => {});
    expect(calls).toEqual(["codex:/p:latest"]);
  });
});
