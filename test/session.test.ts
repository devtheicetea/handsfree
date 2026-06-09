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
});
