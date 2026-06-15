import * as readline from "node:readline";
import { renderEvent, keyToDecision } from "./render.js";
import type { Connection } from "./connection.js";
import type { BridgeToClient } from "../protocol.js";

export interface ReplDeps {
  conn: Connection;
  clientId: string;
  sessionKey: () => string | null;   // resolved after session_started
  out?: NodeJS.WriteStream;
}

/** Drive the readline loop and render incoming events. Returns the incoming-event handler. */
export function startRepl(deps: ReplDeps): (m: BridgeToClient) => void {
  const out = deps.out ?? process.stdout;
  const rl = readline.createInterface({ input: process.stdin, output: out, prompt: "› " });
  let pendingPermission: string | null = null;

  rl.on("line", (line) => {
    const key = deps.sessionKey();
    if (pendingPermission) {
      const decision = keyToDecision(line.trim());
      if (decision) { deps.conn.send({ type: "permission_response", sessionKey: key!, id: pendingPermission, decision } as any); pendingPermission = null; }
      return;
    }
    if (key && line.trim()) deps.conn.send({ type: "prompt", sessionKey: key, text: line } as any);
    rl.prompt();
  });

  rl.on("SIGINT", () => {
    const key = deps.sessionKey();
    if (key) deps.conn.send({ type: "abort", sessionKey: key } as any);
    else { deps.conn.close(); process.exit(0); }
  });
  rl.on("close", () => { deps.conn.close(); process.exit(0); });

  return (m: BridgeToClient) => {
    const action = renderEvent(m, deps.clientId);
    if (action.write) out.write(action.write);
    if (action.permissionPrompt) { out.write(action.permissionPrompt); pendingPermission = action.permissionId!; }
    if (action.clearPermission && pendingPermission === action.clearPermission) pendingPermission = null;
    if (action.reprompt) rl.prompt();
  };
}
