import { describe, it, expect } from "vitest";
import { parseClientMessage, type BridgeToClient } from "../src/protocol.js";

describe("parseClientMessage", () => {
  it("accepts a valid prompt message", () => {
    const r = parseClientMessage(JSON.stringify({ type: "prompt", text: "hi" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ type: "prompt", text: "hi" });
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
    const msg: BridgeToClient = { type: "response", text: "hello", done: false };
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});
