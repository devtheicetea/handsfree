import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { CodexBackend, checkCodexAvailable, CodexUnavailableError, type SpawnFn } from "../src/backends/codex.js";
import type { AgentEvent } from "../src/backends/types.js";
import type { PermissionResult } from "../src/permissions.js";

type Json = Record<string, unknown>;

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  kill(): boolean { this.killed = true; this.emit("exit", 0); return true; }
  /** Run a scripted server: for each stdin line, optionally write responses/notifications. */
  script(handle: (msg: Json, write: (o: Json) => void) => void): void {
    let buf = "";
    const write = (o: Json) => this.stdout.write(JSON.stringify(o) + "\n");
    this.stdin.on("data", (c) => {
      buf += String(c);
      let i = buf.indexOf("\n");
      while (i >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) handle(JSON.parse(line) as Json, write);
        i = buf.indexOf("\n");
      }
    });
  }
}

/** Standard happy-path script: initialize -> ok; thread/start -> thr_1; turn/start -> delta+completed. */
function happyChild(): FakeChild {
  const child = new FakeChild();
  child.script((msg, write) => {
    if (msg.method === "initialize") write({ id: msg.id, result: { userAgent: "codex" } });
    else if (msg.method === "thread/start") {
      write({ id: msg.id, result: { thread: { id: "thr_1" } } });
      write({ method: "thread/started", params: { thread: { id: "thr_1" } } });
    } else if (msg.method === "turn/start") {
      write({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress" } } });
      write({ method: "turn/started", params: { turn: { id: "turn_1" } } });
      const input = (msg.params as { input: Array<{ text: string }> }).input[0]!.text;
      write({ method: "item/agentMessage/delta", params: { itemId: "i1", delta: `echo:${input}` } });
      write({ method: "turn/completed", params: { turn: { id: "turn_1", status: "completed" } } });
    } else if (msg.method === "turn/interrupt") {
      write({ id: msg.id, result: {} });
      write({ method: "turn/completed", params: { turn: { id: "turn_1", status: "interrupted" } } });
    }
  });
  return child;
}

const spawnOf = (child: FakeChild): SpawnFn => vi.fn(() => child as never);
const allow = async (): Promise<PermissionResult> => ({ behavior: "allow" });

async function collect(iter: AsyncIterable<AgentEvent>, until: (evs: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
  const evs: AgentEvent[] = [];
  for await (const ev of iter) { evs.push(ev); if (until(evs)) break; }
  return evs;
}

describe("CodexBackend", () => {
  it("initializes, starts a thread, and maps deltas/turn-completed to AgentEvents", async () => {
    const child = happyChild();
    const spawnFn = spawnOf(child);
    const b = new CodexBackend({ spawnFn, codexPath: "/fake/codex" });
    const iter = b.start({ projectPath: "/p", resume: undefined, evaluate: allow });
    b.prompt("hi"); // queued: thread not started yet — must flush after session_id
    const evs = await collect(iter, (e) => e.some((x) => x.kind === "turn_done"));
    expect(spawnFn).toHaveBeenCalledWith("/fake/codex", ["app-server"]);
    expect(evs).toEqual([
      { kind: "session_id", id: "thr_1" },
      { kind: "text_delta", text: "echo:hi" },
      { kind: "turn_done" },
    ]);
    await b.stop();
    expect(child.killed).toBe(true);
  });

  it("resumes via thread/resume when resume id is given", async () => {
    const child = new FakeChild();
    const seen: string[] = [];
    child.script((msg, write) => {
      seen.push(String(msg.method));
      if (msg.method === "initialize") write({ id: msg.id, result: {} });
      else if (msg.method === "thread/resume") {
        expect((msg.params as Json).threadId).toBe("thr_old");
        write({ id: msg.id, result: { thread: { id: "thr_old" } } });
      }
    });
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const evs = await collect(b.start({ projectPath: "/p", resume: "thr_old", evaluate: allow }), (e) => e.length >= 1);
    expect(evs[0]).toEqual({ kind: "session_id", id: "thr_old" });
    expect(seen).toContain("thread/resume");
    await b.stop();
  });

  it("routes command approval through evaluate('CodexExec') — allow=accept, deny=decline", async () => {
    const child = new FakeChild();
    const decisions: Json[] = [];
    child.script((msg, write) => {
      if (msg.method === "initialize") write({ id: msg.id, result: {} });
      else if (msg.method === "thread/start") {
        write({ id: msg.id, result: { thread: { id: "thr_1" } } });
        // server asks for two approvals
        write({ id: 101, method: "item/commandExecution/requestApproval", params: { itemId: "i1", threadId: "thr_1", turnId: "t1", command: ["rm", "-rf"], cwd: "/p" } });
        write({ id: 102, method: "item/commandExecution/requestApproval", params: { itemId: "i2", threadId: "thr_1", turnId: "t1", command: ["ls"], cwd: "/p" } });
      }
      if (msg.method === undefined && msg.id !== undefined) decisions.push(msg);
    });
    const calls: Array<[string, Json]> = [];
    const evaluate = async (tool: string, input: Json): Promise<PermissionResult> => {
      calls.push([tool, input]);
      return (input.command as string[])[0] === "ls" ? { behavior: "allow" } : { behavior: "deny", message: "no" };
    };
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    await collect(b.start({ projectPath: "/p", resume: undefined, evaluate }), (e) => e.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.map(([t]) => t)).toEqual(["CodexExec", "CodexExec"]);
    // sort by id: the two replies resolve concurrently, order is not guaranteed
    expect([...decisions].sort((a, b2) => Number(a.id) - Number(b2.id))).toEqual([
      { id: 101, result: { decision: "decline" } },
      { id: 102, result: { decision: "accept" } },
    ]);
    await b.stop();
  });

  it("classifies file changes: inside project = CodexApplyPatch, outside/unknown = CodexApplyPatchOutside", async () => {
    const child = new FakeChild();
    child.script((msg, write) => {
      if (msg.method === "initialize") write({ id: msg.id, result: {} });
      else if (msg.method === "thread/start") {
        write({ id: msg.id, result: { thread: { id: "thr_1" } } });
        write({ method: "item/started", params: { item: { id: "f1", type: "fileChange", changes: [{ path: "/p/src/a.ts" }, { path: "/p/b.ts" }] } } });
        write({ id: 201, method: "item/fileChange/requestApproval", params: { itemId: "f1", threadId: "thr_1", turnId: "t1" } });
        write({ method: "item/started", params: { item: { id: "f2", type: "fileChange", changes: [{ path: "/etc/passwd" }] } } });
        write({ id: 202, method: "item/fileChange/requestApproval", params: { itemId: "f2", threadId: "thr_1", turnId: "t1" } });
        write({ id: 203, method: "item/fileChange/requestApproval", params: { itemId: "f-unknown", threadId: "thr_1", turnId: "t1" } });
      }
    });
    const tools: string[] = [];
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    await collect(b.start({ projectPath: "/p", resume: undefined, evaluate: async (tool) => { tools.push(tool); return { behavior: "allow" }; } }), (e) => e.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(tools).toEqual(["CodexApplyPatch", "CodexApplyPatchOutside", "CodexApplyPatchOutside"]);
    await b.stop();
  });

  it("interrupt() sends turn/interrupt with the current turn id", async () => {
    const child = happyChild();
    const sent: Json[] = [];
    child.stdin.on("data", (c) => { for (const l of String(c).split("\n")) if (l.trim()) sent.push(JSON.parse(l) as Json); });
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const iter = b.start({ projectPath: "/p", resume: undefined, evaluate: allow });
    b.prompt("hi");
    await collect(iter, (e) => e.some((x) => x.kind === "turn_done"));
    await b.interrupt();
    expect(sent.some((m) => m.method === "turn/interrupt" && (m.params as Json).turnId === "turn_1")).toBe(true);
    await b.stop();
  });

  it("throws from start() when the child exits unexpectedly mid-session", async () => {
    const child = happyChild();
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const run = (async () => { for await (const _ of b.start({ projectPath: "/p", resume: undefined, evaluate: allow })) { /* consume */ } })();
    await new Promise((r) => setTimeout(r, 20));
    child.emit("exit", 1); // crash, not stop()
    await expect(run).rejects.toThrow(/exited/);
  });

  it("start() rejects when spawn fails (ENOENT arrives as 'error' event)", async () => {
    const child = new FakeChild(); // never answers; emits error below
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const run = (async () => { for await (const _ of b.start({ projectPath: "/p", resume: undefined, evaluate: allow })) { /* none */ } })();
    child.emit("error", new Error("spawn codex ENOENT"));
    await expect(run).rejects.toThrow(/ENOENT|jsonrpc/);
  });

  it("returns cleanly when stop() races the startup phase", async () => {
    const child = new FakeChild(); // never answers initialize
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const run = (async () => { for await (const _ of b.start({ projectPath: "/p", resume: undefined, evaluate: allow })) { /* none */ } })();
    await new Promise((r) => setTimeout(r, 10));
    await b.stop();
    await expect(run).resolves.toBeUndefined();
  });

  it("reports the child-exit reason when the child dies during startup", async () => {
    const child = new FakeChild(); // never answers initialize
    const b = new CodexBackend({ spawnFn: spawnOf(child) });
    const run = (async () => { for await (const _ of b.start({ projectPath: "/p", resume: undefined, evaluate: allow })) { /* none */ } })();
    await new Promise((r) => setTimeout(r, 10));
    child.emit("exit", 1); // crash during startup
    await expect(run).rejects.toThrow(/exited with code 1/);
  });
});

describe("checkCodexAvailable", () => {
  it("resolves with the version output on exit 0", async () => {
    const child = new FakeChild();
    const spawnFn: SpawnFn = vi.fn(() => {
      setTimeout(() => { child.stdout.write("codex-cli 0.99.0\n"); child.emit("exit", 0); }, 5);
      return child as never;
    });
    await expect(checkCodexAvailable("/fake/codex", spawnFn)).resolves.toContain("0.99.0");
    expect(spawnFn).toHaveBeenCalledWith("/fake/codex", ["--version"]);
  });

  it("rejects with CodexUnavailableError on spawn error or non-zero exit", async () => {
    const errChild = new FakeChild();
    const errSpawn: SpawnFn = vi.fn(() => { setTimeout(() => errChild.emit("error", new Error("ENOENT")), 5); return errChild as never; });
    await expect(checkCodexAvailable(null, errSpawn)).rejects.toBeInstanceOf(CodexUnavailableError);

    const badChild = new FakeChild();
    const badSpawn: SpawnFn = vi.fn(() => { setTimeout(() => badChild.emit("exit", 127), 5); return badChild as never; });
    await expect(checkCodexAvailable(null, badSpawn)).rejects.toBeInstanceOf(CodexUnavailableError);
  });
});
