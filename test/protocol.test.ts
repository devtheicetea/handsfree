import { describe, it, expect } from "vitest";
import { parseClientMessage, encode, type BridgeToClient } from "../src/protocol.js";
import { mergeProjects } from "../src/projects.js";

describe("Phase 3 tagged client messages", () => {
  it("parses prompt with sessionKey", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", sessionKey: "k1", text: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: "prompt", sessionKey: "k1", text: "hi" });
  });
  it("rejects prompt without sessionKey", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", text: "hi" }));
    expect(r.ok).toBe(false);
  });
  it("parses a prompt with image attachments and empty text", () => {
    const r = parseClientMessage(JSON.stringify({
      type: "prompt", sessionKey: "k1", text: "",
      attachments: [{ mime: "image/jpeg", dataBase64: "QUJD" }],
    }));
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === "prompt") {
      expect(r.value.attachments).toEqual([{ mime: "image/jpeg", dataBase64: "QUJD" }]);
    }
  });
  it("parses abort/set_mode/permission_response with sessionKey", () => {
    expect(parseClientMessage(JSON.stringify({ type: "abort", sessionKey: "k1" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", sessionKey: "k1", mode: "safelist" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "permission_response", sessionKey: "k1", id: "x", decision: "allow" })).ok).toBe(true);
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid prompt message", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", sessionKey: "k1", text: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: "prompt", sessionKey: "k1", text: "hi" });
  });

  it("accepts open_session with resume literal and nonce", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "open_session", projectPath: "/x", agent: "claude", resume: "latest", nonce: "n1" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects an unknown type", () => {
    const r = parseClientMessage(JSON.stringify({ type: "nope" }));
    expect(r.ok).toBe(false);
  });

  it("rejects malformed JSON", () => {
    const r = parseClientMessage("{not json");
    expect(r.ok).toBe(false);
  });

  it("rejects prompt missing text", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt" }));
    expect(r.ok).toBe(false);
  });

  it("encodes a bridge->client response message as plain object", () => {
    const msg: BridgeToClient = { type: "response", sessionKey: "k1", turn: 1, text: "hello", done: false };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});

describe("agent field", () => {
  it("defaults agent to claude on open_session and list_sessions", () => {
    for (const raw of [
      { type: "open_session", projectPath: "/p", resume: "new", nonce: "n1" },
      { type: "list_sessions", projectPath: "/p" },
    ]) {
      const r = parseClientMessage(JSON.stringify(raw));
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.value as { agent: string }).agent).toBe("claude");
    }
  });

  it("accepts agent: codex on open_session", () => {
    const ok = parseClientMessage(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "new", nonce: "n1", agent: "codex" }));
    expect(ok.ok && (ok.value as { agent: string }).agent === "codex").toBe(true);
  });

  it("rejects unknown agents on open_session", () => {
    expect(parseClientMessage(JSON.stringify({ type: "open_session", projectPath: "/p", resume: "new", nonce: "n1", agent: "gemini" })).ok).toBe(false);
  });
});

describe("v0.3.0 client messages", () => {
  it("parses list_sessions", () => {
    const r = parseClientMessage(JSON.stringify({ type: "list_sessions", projectPath: "/p", agent: "claude" }));
    expect(r.ok).toBe(true);
  });
  it("parses open_session with a nonce", () => {
    const r = parseClientMessage(JSON.stringify({ type: "open_session", projectPath: "/p", agent: "claude", resume: "new", nonce: "n1" }));
    expect(r.ok && r.value.type === "open_session" && (r.value as any).nonce).toBe("n1");
  });
  it("parses prompt routed by sessionKey", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", sessionKey: "k1", text: "hi" }));
    expect(r.ok && r.value.type === "prompt" && (r.value as any).sessionKey).toBe("k1");
  });
  it("rejects open_session without nonce", () => {
    const r = parseClientMessage(JSON.stringify({ type: "open_session", projectPath: "/p", agent: "claude", resume: "new" }));
    expect(r.ok).toBe(false);
  });
});

describe("v0.4.0 mirroring messages", () => {
  it("parses view_session and unview_session", () => {
    const v = parseClientMessage(JSON.stringify({ type: "view_session", projectPath: "/p", agent: "codex", sessionId: "thr_1" }));
    expect(v.ok && v.value.type === "view_session").toBe(true);
    const u = parseClientMessage(JSON.stringify({ type: "unview_session" }));
    expect(u.ok && u.value.type === "unview_session").toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "view_session", projectPath: "/p", agent: "codex" })).ok).toBe(false); // sessionId required
  });

  it("encodes the three new server messages", () => {
    const item = { role: "user" as const, text: "hi", tools: [] };
    for (const msg of [
      { type: "session_history", projectPath: "/p", agent: "codex", sessionId: "s", items: [item] },
      { type: "external_turns", projectPath: "/p", agent: "codex", sessionId: "s", items: [item] },
      { type: "session_activity", projectPath: "/p", agent: "claude", sessionId: "s", lastActive: 5, preview: item },
    ] as const) {
      expect(JSON.parse(encode(msg as any)).type).toBe(msg.type);
    }
  });
});

describe("mergeProjects", () => {
  const sp = (path: string, id: string, at: number) =>
    ({ path, lastSessionId: id, lastActive: at, lastMessage: null });

  it("merges by path with per-agent metadata, sorted by latest activity across agents", () => {
    const merged = mergeProjects([sp("/a", "c1", 100), sp("/b", "c2", 50)], [sp("/a", "x1", 200), sp("/c", "x2", 10)]);
    expect(merged.map((p) => p.path)).toEqual(["/a", "/b", "/c"]); // /a: max(100,200)=200
    const a = merged[0]!;
    expect(a.name).toBe("a");
    expect(a.agents.claude).toMatchObject({ lastSessionId: "c1" });
    expect(a.agents.codex).toMatchObject({ lastSessionId: "x1" });
    expect(merged[1]!.agents.codex).toBeUndefined();
    expect(merged[2]!.agents.claude).toBeUndefined();
  });

  it("keeps the newest entry when one store reports duplicate paths", () => {
    const merged = mergeProjects([sp("/a", "newer", 200), sp("/a", "older", 100)], []);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.agents.claude).toMatchObject({ lastSessionId: "newer", lastActive: 200 });
  });
});
