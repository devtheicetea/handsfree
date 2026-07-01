import { describe, it, expect, vi } from "vitest";
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

  it("buffers the in-flight turn and replays it on replayTo (no session_started — manager owns that)", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true;   // keep turn in-flight
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.prompt("hi");
    await tick();
    const replayed: BridgeToClient[] = [];
    session.replayTo((m) => replayed.push(m));
    // session_started must NOT be emitted by replayTo — the SessionManager owns it
    expect(replayed.find((m) => m.type === "session_started")).toBeUndefined();
    const text = replayed.filter((m) => m.type === "response").map((m) => (m as { text: string }).text).join("");
    expect(text).toBe("echo:hi");
    // status is still replayed
    expect(replayed.some((m) => m.type === "status")).toBe(true);
    await session.stop();
  });

  it("replays an in-flight (mid-stream) turn on replayTo — backgrounding mid-stream loses nothing", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true;   // the turn streams but never finishes before reconnect
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.prompt("hello");
    await tick();
    // The app backgrounded mid-stream and reconnected — replayTo must replay the
    // partial-so-far, with the turn still marked in-flight (not done).
    const replayed: BridgeToClient[] = [];
    session.replayTo((m) => replayed.push(m));
    const text = replayed.filter((m) => m.type === "response").map((m) => (m as { text: string }).text).join("");
    expect(text).toBe("echo:hello");
    expect(replayed.some((m) => m.type === "response" && (m as { done: boolean }).done)).toBe(false);
    expect(replayed.some((m) => m.type === "status" && (m as { state: string }).state === "thinking")).toBe(true);
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

  it("surfaces a turn_failed as error{code:turn_failed} + done response + idle, keeping the session active", async () => {
    const emitted: BridgeToClient[] = [];
    const backend = new FakeBackend();
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    backend.failNext = "401 Unauthorized";
    session.prompt("hi");
    await tick();
    const err = emitted.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err?.code).toBe("turn_failed");
    expect(err?.message).toContain("401 Unauthorized");
    expect(emitted.some((m) => m.type === "response" && (m as { done: boolean }).done)).toBe(true);
    const states = (emitted.filter((m) => m.type === "status") as Array<{ state: string }>).map((s) => s.state);
    expect(states).toContain("idle");
    // the session stays alive and a follow-up prompt still works
    expect(session.isActive()).toBe(true);
    session.prompt("again");
    await tick();
    expect(emitted.some((m) => m.type === "response" && (m as { text: string }).text === "echo:again")).toBe(true);
    await session.stop();
  });

  it("numbers turns and clears the buffer on the next prompt, not on done", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true;   // keep turn in-flight for first replay
    const emitted: BridgeToClient[] = [];
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    session.prompt("one");
    await tick();
    const replay: BridgeToClient[] = [];
    session.replayTo((m) => replay.push(m)); // turn 1 in-flight — replayable
    expect(replay.some((m) => m.type === "response" && (m as { text: string }).text === "echo:one")).toBe(true);
    backend.emitTurnDone();
    await tick();
    session.prompt("two");
    await tick();
    const last = emitted.filter((m) => m.type === "response" && (m as { text: string }).text).pop();
    expect((last as { turn: number }).turn).toBe(2);
    await session.stop();
  });

  it("replayTo replays the in-flight turn + status to a one-off sink without rebinding live emit", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true; // keep turn in-flight until we call emitTextDelta/emitTurnDone manually
    const out: BridgeToClient[] = [];
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => out.push(m) });
    session.prompt("hi");
    backend.emitTextDelta("partial");
    await tick();
    const caught: BridgeToClient[] = [];
    session.replayTo((m) => caught.push(m));
    expect(caught.some((m) => m.type === "response" && (m as any).text === "partial")).toBe(true);
    expect(caught.some((m) => m.type === "status" && (m as any).state === "thinking")).toBe(true);
    backend.emitTextDelta("more");
    await tick();
    expect(out.some((m) => m.type === "response" && (m as any).text === "more")).toBe(true);
    await session.stop();
  });

  it("queues a second prompt while a turn is in flight and runs it after turn_done", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true; // keep turns in-flight; we control turn_done manually
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.prompt("first");
    session.prompt("second"); // should NOT reach the backend yet
    expect(backend.prompts).toEqual(["first"]);
    backend.emitTurnDone();
    await tick();
    expect(backend.prompts).toEqual(["first", "second"]);
    await session.stop();
  });

  it("runs multiple queued prompts in FIFO order", async () => {
    const backend = new FakeBackend();
    backend.streamOnly = true;
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: () => {} });
    session.prompt("first");
    session.prompt("second");
    session.prompt("third");
    expect(backend.prompts).toEqual(["first"]);
    backend.emitTurnDone();
    await tick();
    expect(backend.prompts).toEqual(["first", "second"]);
    backend.emitTurnDone();
    await tick();
    expect(backend.prompts).toEqual(["first", "second", "third"]);
  });

  it("replayTo on an idle session emits only status, not the finished turn's text", async () => {
    const backend = new FakeBackend();
    const out: BridgeToClient[] = [];
    const s = new Session(backend);
    const policy = new PermissionPolicy(["Read"], () => {});
    await s.start({ projectPath: "/p", resume: undefined, policy, emit: (m) => out.push(m) });
    s.prompt("hi");
    backend.emitTextDelta("answer");
    await tick();
    backend.emitTurnDone();
    await tick();
    const caught: BridgeToClient[] = [];
    s.replayTo((m) => caught.push(m));
    expect(caught.some((m) => m.type === "response")).toBe(false);
    expect(caught.some((m) => m.type === "status" && (m as any).state === "idle")).toBe(true);
  });

  it("stays 'working' (thinking) — not idle — while a background task is pending after the turn ends", async () => {
    const backend = new FakeBackend();
    const emitted: BridgeToClient[] = [];
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    await tick();
    // A turn streams, launches a background task, then the turn ends.
    backend.events.push({ kind: "text_delta", text: "starting" });
    await tick();
    backend.events.push({ kind: "task_started", taskId: "t1", description: "Compile build 8" });
    await tick();
    backend.events.push({ kind: "turn_done" });
    await tick();
    const states = (emitted.filter((m) => m.type === "status") as Array<{ state: string }>).map((s) => s.state);
    expect(states[states.length - 1]).toBe("thinking"); // NOT idle — the task is still running
    expect(session.streaming).toBe(false);              // nothing actively streaming -> reattach snapshots, not buffer-replays
    expect(session.hasPendingTasks).toBe(true);
    expect(session.pendingTaskCount).toBe(1);
    // The task settles -> pending clears (the idle transition is debounced, not asserted here).
    backend.events.push({ kind: "task_settled", taskId: "t1", status: "completed", summary: "ok" });
    await tick();
    expect(session.hasPendingTasks).toBe(false);
    await session.stop();
  });

  it("force-settles a background task that never delivers a settle signal (stuck-⚙️ backstop)", async () => {
    vi.useFakeTimers();
    try {
      const backend = new FakeBackend();
      const emitted: BridgeToClient[] = [];
      const session = new Session(backend);
      void session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
      await vi.advanceTimersByTimeAsync(0);
      // A background task starts and the turn ends, but NO settle ever arrives (the background
      // AGENT / Task-tool bug — its completion isn't an SDK task_notification).
      backend.events.push({ kind: "task_started", taskId: "t1", description: "Research OpenClaw" });
      backend.events.push({ kind: "turn_done" });
      await vi.advanceTimersByTimeAsync(0);
      expect(session.hasPendingTasks).toBe(true);
      // Past the cap → the backstop sweeps it so the "working" indicator can't spin forever.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100);
      expect(session.hasPendingTasks).toBe(false);
      const swept = emitted.filter((m) => (m as { type: string }).type === "task_settled") as Array<{ id: string; status: string }>;
      expect(swept.some((m) => m.id === "t1" && m.status === "swept")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an SDK auto-continuation after a task settles as its own fresh turn", async () => {
    const backend = new FakeBackend();
    const emitted: BridgeToClient[] = [];
    const session = new Session(backend);
    await session.start({ projectPath: "/p", resume: undefined, policy: policy(), emit: (m) => emitted.push(m) });
    await tick();
    backend.events.push({ kind: "text_delta", text: "turn one" });          // turn 1 begins
    backend.events.push({ kind: "task_started", taskId: "t1", description: "x" });
    backend.events.push({ kind: "turn_done" });
    await tick();
    backend.events.push({ kind: "task_settled", taskId: "t1", status: "completed", summary: "" });
    await tick();
    // The agent reacts to the notification with NO client prompt — a fresh turn.
    backend.events.push({ kind: "text_delta", text: "auto reply" });
    await tick();
    expect(session.streaming).toBe(true);                                    // actively streaming again
    const replies = emitted.filter((m) => m.type === "response") as Array<{ text: string; turn: number }>;
    const turn1 = replies.find((r) => r.text === "turn one")!.turn;
    const auto = replies.find((r) => r.text === "auto reply")!.turn;
    expect(auto).toBeGreaterThan(turn1);                                     // a new turn number, its own bubble
    backend.events.push({ kind: "turn_done" });
    await tick();
    expect((emitted.filter((m) => m.type === "status") as Array<{ state: string }>).pop()?.state).toBe("idle");
    await session.stop();
  });
});
