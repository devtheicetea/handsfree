import { describe, it, expect } from "vitest";
import { renderEvent } from "../../src/cli/render.js";

describe("renderEvent", () => {
  it("prints streamed response text without a trailing newline until done", () => {
    expect(renderEvent({ type: "response", sessionKey: "k", turn: 1, text: "hel", done: false } as any, "me")).toEqual({ write: "hel" });
    expect(renderEvent({ type: "response", sessionKey: "k", turn: 1, text: "", done: true } as any, "me")).toEqual({ write: "\n", reprompt: true });
  });
  it("labels a user_message from another device but ignores my own origin", () => {
    expect(renderEvent({ type: "user_message", sessionKey: "k", turn: 1, text: "hi", origin: "phone" } as any, "me"))
      .toEqual({ write: "\n[phone] hi\n" });
    expect(renderEvent({ type: "user_message", sessionKey: "k", turn: 1, text: "hi", origin: "me" } as any, "me"))
      .toEqual({});
  });
  it("formats a permission request and clears on permission_resolved", () => {
    const ask = renderEvent({ type: "permission_request", sessionKey: "k", id: "p1", tool: "Bash", input: {}, detail: "Bash ls" } as any, "me");
    expect(ask.permissionPrompt).toMatch(/Bash ls/);
    expect(ask.permissionId).toBe("p1");
    expect(renderEvent({ type: "permission_resolved", sessionKey: "k", id: "p1" } as any, "me"))
      .toEqual({ write: "\n(answered on another device)\n", clearPermission: "p1" });
  });
});
