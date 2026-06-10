import { describe, it, expect } from "vitest";
import { SessionManager } from "../src/sessionManager.js";
import type { BridgeToClient } from "../src/protocol.js";
import type { StartParams } from "../src/session.js";

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
    makeSession: () => { const s = new FakeSession(); made.push(s); return s as any },
    claudeHome: "/tmp/none",
    resolveResume: () => undefined,
  });
  return { m, made };
}

describe("SessionManager", () => {
  it("tags each project's output with its projectPath", async () => {
    const out: BridgeToClient[] = [];
    const { m } = mgr();
    await m.open("/a", "new", (x) => out.push(x));
    await m.open("/b", "new", (x) => out.push(x));
    m.route({ type: "prompt", projectPath: "/a", text: "hi" } as any);
    m.route({ type: "prompt", projectPath: "/b", text: "yo" } as any);
    const aResp = out.find((x) => x.type === "response" && (x as any).text === "r:hi");
    const bResp = out.find((x) => x.type === "response" && (x as any).text === "r:yo");
    expect((aResp as any).projectPath).toBe("/a");
    expect((bResp as any).projectPath).toBe("/b");
  });

  it("routes abort to the named project only", async () => {
    const { m, made } = mgr();
    await m.open("/a", "new", () => {});
    await m.open("/b", "new", () => {});
    m.route({ type: "abort", projectPath: "/b" } as any);
    expect(made[0].aborts).toBe(0);
    expect(made[1].aborts).toBe(1);
  });

  it("keeps both sessions alive across an open (no teardown on switch)", async () => {
    const { m, made } = mgr();
    await m.open("/a", "new", () => {});
    await m.open("/b", "new", () => {});
    expect(made[0].isActive()).toBe(true);
    expect(made[1].isActive()).toBe(true);
  });

  it("re-syncs an already-live project via reattach instead of recreating", async () => {
    const { m, made } = mgr();
    await m.open("/a", "new", () => {});
    await m.open("/a", "latest", () => {});
    expect(made.length).toBe(1);
  });

  it("stopAll stops every session", async () => {
    const { m, made } = mgr();
    await m.open("/a", "new", () => {});
    await m.open("/b", "new", () => {});
    await m.stopAll();
    expect(made[0].isActive()).toBe(false);
    expect(made[1].isActive()).toBe(false);
  });
});
