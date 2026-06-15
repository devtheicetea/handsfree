import type { BridgeToClient } from "../protocol.js";

/**
 * Pure mapping from a bridge event to a semantic UI action. No ANSI, no I/O —
 * the repl interprets these against the terminal (spinner, prompt, styling), so
 * this stays trivially testable. `me` is this client's id, used to skip the echo
 * of our own user_message.
 */
export type RenderAction =
  | { kind: "none" }
  | { kind: "stream"; text: string }                                   // an agent reply token
  | { kind: "turnEnd" }                                                // the agent finished its turn
  | { kind: "status"; state: "thinking" | "idle" | "error" }
  | { kind: "message"; role: "user" | "system"; text: string; from?: string }
  | { kind: "permission"; id: string; tool: string; detail: string }
  | { kind: "permissionResolved"; id: string }
  | { kind: "error"; code: string; message: string };

export function renderEvent(msg: BridgeToClient, me: string): RenderAction {
  switch (msg.type) {
    case "response":
      if (msg.done) return { kind: "turnEnd" };
      return msg.text ? { kind: "stream", text: msg.text } : { kind: "none" };
    case "user_message":
      if (msg.origin === me) return { kind: "none" };          // our own prompt — already shown locally
      return { kind: "message", role: "user", text: msg.text, from: msg.origin };
    case "permission_request":
      return { kind: "permission", id: msg.id, tool: msg.tool, detail: msg.detail };
    case "permission_resolved":
      return { kind: "permissionResolved", id: msg.id };
    case "status":
      return { kind: "status", state: msg.state };
    case "error":
      return { kind: "error", code: msg.code, message: msg.message };
    default:
      return { kind: "none" };
  }
}

/** Map a single keypress to a permission decision, or null to ignore. */
export function keyToDecision(key: string): "allow" | "allow_session" | "deny" | null {
  const k = key.toLowerCase();
  if (k === "a") return "allow";
  if (k === "s") return "allow_session";
  if (k === "d") return "deny";
  return null;
}
