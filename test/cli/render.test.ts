import { describe, it, expect } from "vitest";
import { renderEvent, keyToDecision } from "../../src/cli/render.js";

describe("renderEvent", () => {
  it("streams response tokens and ends the turn on done", () => {
    expect(renderEvent({ type: "response", sessionKey: "k", turn: 1, text: "hel", done: false } as any, "me"))
      .toEqual({ kind: "stream", text: "hel" });
    expect(renderEvent({ type: "response", sessionKey: "k", turn: 1, text: "", done: false } as any, "me"))
      .toEqual({ kind: "none" });
    expect(renderEvent({ type: "response", sessionKey: "k", turn: 1, text: "", done: true } as any, "me"))
      .toEqual({ kind: "turnEnd" });
  });
  it("labels a user_message from another device but ignores my own origin", () => {
    expect(renderEvent({ type: "user_message", sessionKey: "k", turn: 1, text: "hi", origin: "phone" } as any, "me"))
      .toEqual({ kind: "message", role: "user", text: "hi", from: "phone" });
    expect(renderEvent({ type: "user_message", sessionKey: "k", turn: 1, text: "hi", origin: "me" } as any, "me"))
      .toEqual({ kind: "none" });
  });
  it("maps status to a state action", () => {
    expect(renderEvent({ type: "status", sessionKey: "k", state: "thinking" } as any, "me"))
      .toEqual({ kind: "status", state: "thinking" });
  });
  it("surfaces a permission request and a permission_resolved", () => {
    expect(renderEvent({ type: "permission_request", sessionKey: "k", id: "p1", tool: "Bash", input: {}, detail: "Bash ls" } as any, "me"))
      .toEqual({ kind: "permission", id: "p1", tool: "Bash", detail: "Bash ls" });
    expect(renderEvent({ type: "permission_resolved", sessionKey: "k", id: "p1" } as any, "me"))
      .toEqual({ kind: "permissionResolved", id: "p1" });
  });
  it("surfaces errors", () => {
    expect(renderEvent({ type: "error", code: "no_session", message: "gone" } as any, "me"))
      .toEqual({ kind: "error", code: "no_session", message: "gone" });
  });
});

describe("keyToDecision", () => {
  it("maps [a]llow, [s]ession, [d]eny to decisions (case-insensitive)", () => {
    expect(keyToDecision("a")).toBe("allow");
    expect(keyToDecision("A")).toBe("allow");
    expect(keyToDecision("s")).toBe("allow_session");
    expect(keyToDecision("S")).toBe("allow_session");
    expect(keyToDecision("d")).toBe("deny");
    expect(keyToDecision("D")).toBe("deny");
  });
  it("returns null for unrecognized keys", () => {
    expect(keyToDecision("x")).toBeNull();
    expect(keyToDecision("q")).toBeNull();
    expect(keyToDecision("")).toBeNull();
  });
});
