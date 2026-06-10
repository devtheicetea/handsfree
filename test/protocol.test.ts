import { describe, it, expect } from "vitest";
import { parseClientMessage, type BridgeToClient } from "../src/protocol.js";

describe("Phase 3 tagged client messages", () => {
  it("parses prompt with projectPath", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", projectPath: "/p", text: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ type: "prompt", projectPath: "/p", text: "hi" });
  });
  it("rejects prompt without projectPath", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", text: "hi" }));
    expect(r.ok).toBe(false);
  });
  it("parses abort/set_mode/permission_response with projectPath", () => {
    expect(parseClientMessage(JSON.stringify({ type: "abort", projectPath: "/p" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "set_mode", projectPath: "/p", mode: "safelist" })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ type: "permission_response", projectPath: "/p", id: "x", decision: "allow" })).ok).toBe(true);
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid prompt message", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", projectPath: "/p", text: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: "prompt", projectPath: "/p", text: "hi" });
  });

  it("accepts open_session with resume literal", () => {
    const r = parseClientMessage(
      JSON.stringify({ type: "open_session", projectPath: "/x", resume: "latest" }),
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
    const msg: BridgeToClient = { type: "response", projectPath: "/p", turn: 1, text: "hello", done: false };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});
