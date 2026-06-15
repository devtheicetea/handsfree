import type { BridgeToClient } from "../protocol.js";

export interface RenderAction {
  write?: string;             // text to write to stdout
  reprompt?: boolean;         // turn finished — show the input prompt again
  permissionPrompt?: string;  // a permission line to show + await a keypress
  permissionId?: string;      // the id to answer
  clearPermission?: string;   // a permission resolved elsewhere — stop awaiting it
}

/** Pure mapping from an inbound bridge event to a terminal action. `me` is this
 *  client's clientId (to ignore our own user_message echo). */
export function renderEvent(msg: BridgeToClient, me: string): RenderAction {
  switch (msg.type) {
    case "response":
      if (msg.done) return { write: "\n", reprompt: true };
      return msg.text ? { write: msg.text } : {};
    case "user_message":
      if (msg.origin === me) return {};
      return { write: `\n[${msg.origin}] ${msg.text}\n` };
    case "permission_request":
      return { permissionPrompt: `\n⚠ ${msg.detail}  [a]llow / [s]ession / [d]eny: `, permissionId: msg.id };
    case "permission_resolved":
      return { write: "\n(answered on another device)\n", clearPermission: msg.id };
    case "status":
      return msg.state === "thinking" ? { write: "" } : {};
    case "error":
      return { write: `\n[error:${msg.code}] ${msg.message}\n`, reprompt: true };
    default:
      return {};
  }
}

/** Map a single keypress to a decision, or null to ignore. */
export function keyToDecision(key: string): "allow" | "allow_session" | "deny" | null {
  const k = key.toLowerCase();
  if (k === "a") return "allow";
  if (k === "s") return "allow_session";
  if (k === "d") return "deny";
  return null;
}
