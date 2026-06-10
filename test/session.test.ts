import { describe, it, expect, vi } from "vitest";
import { Session, type QueryFn } from "../src/session.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { BridgeToClient } from "../src/protocol.js";

function fakeQueryFn(): QueryFn {
  return ({ prompt }) => {
    async function* gen() {
      // Models the real SDK: init only after the first user input, then
      // token deltas arrive as stream_event before the result.
      let first = true;
      for await (const userMsg of prompt as AsyncIterable<any>) {
        if (first) {
          first = false;
          yield { type: "system", subtype: "init", session_id: "sess-1", tools: ["Read", "Bash"] } as any;
        }
        const text = typeof userMsg.message.content === "string" ? userMsg.message.content : "";
        yield {
          type: "stream_event",
          session_id: "sess-1",
          parent_tool_use_id: null,
          event: { type: "content_block_delta", delta: { type: "text_delta", text: `echo:${text}` } },
        } as any;
        yield { type: "result", subtype: "success", session_id: "sess-1", result: `echo:${text}` } as any;
      }
    }
    const g = gen() as any;
    g.setPermissionMode = async () => {};
    return g;
  };
}

describe("Session", () => {
  it("emits session_started on init and streams a response on prompt", async () => {
    const emitted: BridgeToClient[] = [];
    const emit = (m: BridgeToClient) => emitted.push(m);
    const policy = new PermissionPolicy(["Read"], () => {});
    const session = new Session({ queryFn: fakeQueryFn(), waitForSessionFile: async () => {} });

    await session.start({ projectPath: "/x", resume: undefined, policy, emit });
    session.prompt("hi");
    await session.stop(); // drains the loop deterministically — no arbitrary sleep

    // session_started fires immediately on start() (decoupled from SDK init),
    // so a new session reports an empty id; the real id is learned internally.
    const started = emitted.find((m) => m.type === "session_started");
    expect(started).toMatchObject({ type: "session_started", sessionId: "", projectPath: "/x" });

    const responses = emitted.filter((m) => m.type === "response") as Array<{ text: string; done: boolean }>;
    expect(responses.some((r) => r.text === "echo:hi" && r.done === false)).toBe(true);
    expect(responses.some((r) => r.done === true)).toBe(true);

    const statuses = emitted.filter((m) => m.type === "status") as Array<{ state: string }>;
    expect(statuses.some((s) => s.state === "thinking")).toBe(true);
    expect(statuses.some((s) => s.state === "idle")).toBe(true);
  });

  it("wires the permission policy into canUseTool", async () => {
    const askSpy = vi.fn();
    const policy = new PermissionPolicy(["Read"], askSpy);
    let captured: ((tool: string, input: unknown, opts: unknown) => unknown) | null = null;
    const queryFn: QueryFn = ({ options }) => {
      captured = options!.canUseTool as typeof captured;
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s", tools: [] } as any;
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      return g;
    };
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/x", resume: undefined, policy, emit: () => {} });
    // queryFn runs synchronously inside start(), so canUseTool is captured by now
    expect(captured).toBeTypeOf("function");
    captured!("Bash", { command: "ls" }, { signal: new AbortController().signal, toolUseID: "t1" });
    expect(askSpy).toHaveBeenCalledTimes(1);
    await session.stop();
  });

  it("runs in strict permission mode (settingSources: ['project'])", async () => {
    let captured: { settingSources?: unknown } | undefined;
    const queryFn: QueryFn = ({ options }) => {
      captured = options as { settingSources?: unknown };
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s", tools: [] } as any;
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      return g;
    };
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/x", resume: undefined, policy: new PermissionPolicy([], () => {}), emit: () => {} });
    expect(captured?.settingSources).toEqual(["project"]);
    await session.stop();
  });

  it("enables partial streaming (includePartialMessages)", async () => {
    let captured: { includePartialMessages?: unknown } | undefined;
    const queryFn: QueryFn = ({ options }) => {
      captured = options as { includePartialMessages?: unknown };
      async function* gen() {
        yield { type: "system", subtype: "init", session_id: "s", tools: [] } as any;
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      return g;
    };
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/x", resume: undefined, policy: new PermissionPolicy([], () => {}), emit: () => {} });
    expect(captured?.includePartialMessages).toBe(true);
    await session.stop();
  });

  it("buffers the in-flight turn and replays it on reattach", async () => {
    const queryFn: QueryFn = ({ prompt }) => {
      async function* gen() {
        let first = true;
        for await (const _ of prompt as AsyncIterable<any>) {
          if (first) { first = false; yield { type: "system", subtype: "init", session_id: "s9", tools: [] } as any; }
          yield { type: "stream_event", session_id: "s9", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } } as any;
          yield { type: "stream_event", session_id: "s9", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } } as any;
        }
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      return g;
    };
    const policy = new PermissionPolicy([], () => {});
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/p", resume: undefined, policy, emit: () => {} });
    session.prompt("hi");
    await new Promise((r) => setTimeout(r, 20));

    expect(session.isActive()).toBe(true);

    const replayed: BridgeToClient[] = [];
    session.reattach((m) => replayed.push(m));

    expect(replayed[0]).toMatchObject({ type: "session_started", sessionId: "s9", projectPath: "/p" });
    const replayedText = replayed.filter((m) => m.type === "response").map((m) => (m as { text: string }).text).join("");
    expect(replayedText).toBe("hello");
    expect(replayed.some((m) => m.type === "status" && (m as { state: string }).state === "thinking")).toBe(true);

    await session.stop();
    expect(session.isActive()).toBe(false);
  });

  it("stops emitting after detachEmit so a switched-away session does not bleed", async () => {
    const emitted: BridgeToClient[] = [];
    const policy = new PermissionPolicy([], () => {});
    const session = new Session({ queryFn: fakeQueryFn(), waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/a", resume: undefined, policy, emit: (m) => emitted.push(m) });
    session.detachEmit();
    const before = emitted.length;
    session.prompt("hi"); // would normally emit status thinking + a response delta
    await new Promise((r) => setTimeout(r, 20));
    expect(emitted.length).toBe(before); // nothing reaches the (detached) client
    await session.stop();
  });

  it("interrupts the current turn on abort but keeps the session alive for the next prompt", async () => {
    let interrupts = 0;
    const queryFn: QueryFn = ({ prompt }) => {
      async function* gen() {
        let first = true;
        for await (const userMsg of prompt as AsyncIterable<any>) {
          if (first) { first = false; yield { type: "system", subtype: "init", session_id: "s", tools: [] } as any; }
          const text = userMsg.message.content as string;
          yield { type: "stream_event", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: `r:${text}` } } } as any;
          yield { type: "result", subtype: "success", session_id: "s", result: `r:${text}` } as any;
        }
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      g.interrupt = async () => { interrupts++; };
      return g;
    };
    const emitted: BridgeToClient[] = [];
    const policy = new PermissionPolicy([], () => {});
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/p", resume: undefined, policy, emit: (m) => emitted.push(m) });
    session.prompt("one");
    await new Promise((r) => setTimeout(r, 20));
    session.abortTurn();           // barge-in: must interrupt, NOT abort the query
    session.prompt("two");         // the post-barge-in question
    await new Promise((r) => setTimeout(r, 20));

    expect(interrupts).toBe(1);                 // used interrupt(), not abortController.abort()
    expect(session.isActive()).toBe(true);      // session was not torn down
    const texts = emitted.filter((m) => m.type === "response").map((m) => (m as { text: string }).text);
    expect(texts).toContain("r:one");
    expect(texts).toContain("r:two");           // the barge-in prompt was actually processed
    await session.stop();
  });

  it("does not report a deliberately aborted turn as session_crashed", async () => {
    // The real SDK throws a plain Error("Operation aborted") (name "Error", not
    // "AbortError") when its abortController fires. A deliberate abort — e.g. the
    // previous session being torn down on a second open_session, or barge-in — must
    // NOT surface as session_crashed.
    const queryFn: QueryFn = ({ options }) => {
      async function* gen() {
        await new Promise<void>((_resolve, reject) => {
          options.abortController!.signal.addEventListener("abort", () => {
            reject(new Error("Operation aborted")); // name === "Error"
          });
        });
      }
      const g = gen() as any;
      g.setPermissionMode = async () => {};
      return g;
    };
    const emitted: BridgeToClient[] = [];
    const policy = new PermissionPolicy([], () => {});
    const session = new Session({ queryFn, waitForSessionFile: async () => {} });
    await session.start({ projectPath: "/p", resume: undefined, policy, emit: (m) => emitted.push(m) });
    await session.stop(); // triggers this.abort.abort()

    expect(emitted.some((m) => m.type === "error" && (m as { code: string }).code === "session_crashed")).toBe(false);
    expect(emitted.some((m) => m.type === "status" && (m as { state: string }).state === "error")).toBe(false);
  });
});
