import { describe, it, expect } from "vitest";
import { Session } from "../src/session.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { BridgeToClient } from "../src/protocol.js";
import { FakeBackend } from "./fakeBackend.js";

const policy =(ask: (req: { id: string; tool: string; input: unknown }) => void = () => {}) =>
  new PermissionPolicy(["Read"], ask);
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("Session (backend-agnostic shell)", () => {
  it("streams responses with status transitions (session_started is now emitted by SessionManager, not Session)", async () => {
    const emitted: BridgeToClient[] = [];
    const session = new Session(new FakeBackend());
    await session.start({ projectPath: "/x", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    session.prompt("hi");
    await tick();
    // session_started is no longer emitted by Session.start() — the manager emits it before calling start().
    expect(emitted.find((m) => m.type === "session_started")).toBeUndefined();
    const responses = emitted.filter((m) => m.type === "response") as Array<{ text: string; done: boolean; turn: number }>;
    expect(responses.some((r) => r.text === "echo:hi" && !r.done && r.turn === 1)).toBe(true);
    expect(responses.some((r) => r.done)).toBe(true);
    const states = (emitted.filter((m) => m.type === "status") as Array<{ state: string }>).map((s) => s.state);
    expect(states).toContain("thinking");
    expect(states).toContain("idle");
    await session.stop();
  });

  it("hands the policy's evaluate to the backend", async () => {
    const asked: string[] = [];
    const backend = new FakeBackend();
    const session = new Session(backend);
    await session.start({ projectPath: "/x", resume: undefined, policy: policy((r) => asked.push(r.tool)), emit: () => {} });
    await tick();
    void backend.startOpts!.evaluate("Bash", { command: "ls" });
    expect(asked).toEqual(["Bash"]);
    await session.stop();
  });

  it("buffers the in-flight turn and replays it on reattach (no session_started — manager owns that)", async () => {
    const backend = new FakeBackend();
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.prompt("hi");
    await tick();
    const replayed: BridgeToClient[] = [];
    session.reattach((m) => replayed.push(m));
    // session_started must NOT be emitted by reattach — the SessionManager owns it
    expect(replayed.find((m) => m.type === "session_started")).toBeUndefined();
    const text = replayed.filter((m) => m.type === "response").map((m) => (m as { text: string }).text).join("");
    expect(text).toBe("echo:hi");
    // status is still replayed
    expect(replayed.some((m) => m.type === "status")).toBe(true);
    await session.stop();
  });

  it("detachEmit stops output reaching the old sink", async () => {
    const emitted: BridgeToClient[] = [];
    const session = new Session(new FakeBackend());
    await session.start({ projectPath: "/a", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    session.detachEmit();
    const before = emitted.length;
    session.prompt("hi");
    await tick();
    expect(emitted.length).toBe(before);
    await session.stop();
  });

  it("abortTurn() delegates to backend.interrupt() and the session stays active", async () => {
    const backend = new FakeBackend();
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.abortTurn();
    await tick();
    expect(backend.interrupts).toBe(1);
    expect(session.isActive()).toBe(true);
    await session.stop();
    expect(session.isActive()).toBe(false);
  });

  it("reports a backend throw as session_crashed, but a clean stop as nothing", async () => {
    const crashing = new FakeBackend();
    crashing.crash = new Error("backend exploded");
    const emitted: BridgeToClient[] = [];
    const s1 = new Session(crashing);
    await s1.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    await tick();
    expect(emitted.some((m) => m.type === "error" && (m as { code: string }).code === "session_crashed")).toBe(true);

    const clean: BridgeToClient[] = [];
    const s2 = new Session(new FakeBackend());
    await s2.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => clean.push(m) });
    await s2.stop();
    expect(clean.some((m) => m.type === "error")).toBe(false);
  });

  it("numbers turns and clears the buffer on the next prompt, not on done", async () => {
    const emitted: BridgeToClient[] = [];
    const session = new Session(new FakeBackend());
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    session.prompt("one");
    await tick();
    const replay: BridgeToClient[] = [];
    session.reattach((m) => replay.push(m)); // turn 1 finished but still replayable
    expect(replay.some((m) => m.type === "response" && (m as { text: string }).text === "echo:one")).toBe(true);
    session.prompt("two");
    await tick();
    const last = replay.filter((m) => m.type === "response" && (m as { text: string }).text).pop();
    expect((last as { turn: number }).turn).toBe(2);
    await session.stop();
  });
});
