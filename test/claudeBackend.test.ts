import { describe, it, expect } from "vitest";
import { ClaudeBackend, type QueryFn } from "../src/backends/claude.js";
import type { AgentEvent } from "../src/backends/types.js";

/** Same fake the old session.test.ts used: init after first prompt, then delta + result per turn. */
function fakeQueryFn(): QueryFn {
  return ({ prompt }) => {
    async function* gen() {
      let first = true;
      for await (const userMsg of prompt as AsyncIterable<any>) {
        if (first) { first = false; yield { type: "system", subtype: "init", session_id: "sess-1", tools: [] } as any; }
        const text = typeof userMsg.message.content === "string" ? userMsg.message.content : "";
        yield { type: "stream_event", session_id: "sess-1", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: `echo:${text}` } } } as any;
        yield { type: "result", subtype: "success", session_id: "sess-1", result: `echo:${text}` } as any;
      }
    }
    const g = gen() as any;
    g.setPermissionMode = async () => {};
    return g;
  };
}

const evaluate = async () => ({ behavior: "allow" as const });

async function collect(iter: AsyncIterable<AgentEvent>, until: (evs: AgentEvent[]) => boolean): Promise<AgentEvent[]> {
  const evs: AgentEvent[] = [];
  for await (const ev of iter) { evs.push(ev); if (until(evs)) break; }
  return evs;
}

describe("ClaudeBackend", () => {
  it("yields session_id (after the session file wait), text deltas, and turn_done", async () => {
    let waited = "";
    const b = new ClaudeBackend({ queryFn: fakeQueryFn(), waitForSessionFile: async (id) => { waited = id; } });
    const iter = b.start({ projectPath: "/p", resume: undefined, evaluate });
    b.prompt("hi");
    const evs = await collect(iter, (e) => e.some((x) => x.kind === "turn_done"));
    expect(waited).toBe("sess-1");
    expect(evs).toEqual([
      { kind: "session_id", id: "sess-1" },
      { kind: "text_delta", text: "echo:hi" },
      { kind: "turn_done" },
    ]);
    await b.stop();
  });

  it("passes strict options and wires evaluate into canUseTool", async () => {
    let captured: any;
    const queryFn: QueryFn = ({ options }) => {
      captured = options;
      async function* gen() { yield { type: "system", subtype: "init", session_id: "s", tools: [] } as any; }
      const g = gen() as any; g.setPermissionMode = async () => {}; return g;
    };
    const calls: string[] = [];
    const b = new ClaudeBackend({ queryFn, waitForSessionFile: async () => {} });
    const iter = b.start({ projectPath: "/x", resume: "r-1", evaluate: async (tool) => { calls.push(tool); return { behavior: "allow" }; } });
    await collect(iter, (e) => e.length >= 1);
    expect(captured.cwd).toBe("/x");
    expect(captured.resume).toBe("r-1");
    expect(captured.settingSources).toEqual(["project"]);
    expect(captured.includePartialMessages).toBe(true);
    await captured.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t" });
    expect(calls).toEqual(["Bash"]);
    await b.stop();
  });

  it("interrupt() uses query.interrupt, not the abort controller", async () => {
    let interrupts = 0;
    const queryFn: QueryFn = ({ prompt }) => {
      async function* gen() { for await (const _ of prompt as AsyncIterable<any>) { /* idle */ } }
      const g = gen() as any; g.setPermissionMode = async () => {}; g.interrupt = async () => { interrupts++; };
      return g;
    };
    const b = new ClaudeBackend({ queryFn, waitForSessionFile: async () => {} });
    const iter = b.start({ projectPath: "/p", resume: undefined, evaluate });
    const consuming = collect(iter, () => false).catch(() => []);
    await b.interrupt();
    expect(interrupts).toBe(1);
    await b.stop();
    await consuming;
  });

  it("throws on a second start() (use-once contract)", async () => {
    const b = new ClaudeBackend({ queryFn: fakeQueryFn(), waitForSessionFile: async () => {} });
    const iter1 = b.start({ projectPath: "/p", resume: undefined, evaluate });
    b.prompt("hi");
    await collect(iter1, (e) => e.some((x) => x.kind === "turn_done"));
    await expect((async () => { for await (const _ of b.start({ projectPath: "/p", resume: undefined, evaluate })) { /* none */ } })())
      .rejects.toThrow("backend already started");
    await b.stop();
  });

  it("ends cleanly on deliberate abort (plain Error('Operation aborted')) but throws on a real crash", async () => {
    // deliberate abort -> clean end
    const abortingQueryFn: QueryFn = ({ options }) => {
      async function* gen() {
        await new Promise<void>((_res, reject) => {
          options!.abortController!.signal.addEventListener("abort", () => reject(new Error("Operation aborted")));
        });
      }
      const g = gen() as any; g.setPermissionMode = async () => {}; return g;
    };
    const b1 = new ClaudeBackend({ queryFn: abortingQueryFn, waitForSessionFile: async () => {} });
    const done = (async () => { for await (const _ of b1.start({ projectPath: "/p", resume: undefined, evaluate })) { /* none */ } })();
    await b1.stop();
    await expect(done).resolves.toBeUndefined();

    // real crash -> throws
    const crashingQueryFn: QueryFn = () => {
      async function* gen() { throw new Error("SDK exploded"); }
      const g = gen() as any; g.setPermissionMode = async () => {}; return g;
    };
    const b2 = new ClaudeBackend({ queryFn: crashingQueryFn, waitForSessionFile: async () => {} });
    await expect((async () => { for await (const _ of b2.start({ projectPath: "/p", resume: undefined, evaluate })) { /* none */ } })())
      .rejects.toThrow("SDK exploded");
  });
});
