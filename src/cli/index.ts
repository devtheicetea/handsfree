#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parseArgs } from "./args.js";
import { connect, loadClientId } from "./connection.js";
import { startRepl } from "./repl.js";
import type { BridgeToClient } from "../protocol.js";

const args = parseArgs(process.argv.slice(2), process.cwd(), process.env);
const clientId = loadClientId();
let sessionKey: string | null = null;
const nonce = randomUUID();

let handle: (m: BridgeToClient) => void = () => {};

const conn = connect({
  host: args.host, port: args.port, token: args.token, clientId,
  onHelloOk: () => {
    conn.send({ type: "open_session", projectPath: args.projectPath, agent: args.agent, resume: args.resume, nonce } as any);
  },
  onEvent: (m) => {
    // Claim our session from its session_started (matched by our nonce).
    if (m.type === "session_started" && (m as { nonce?: string }).nonce === nonce) {
      sessionKey = (m as { sessionKey: string }).sessionKey;
      return;
    }
    // The bridge fans out ALL live sessions to every client; follow only ours.
    // Errors are the exception: a no_session/bad_message/internal error is tagged
    // with a stale or foreign sessionKey (e.g. a prompt to a key that died on
    // restart), so filtering by key would silently swallow it — always show them.
    const key = (m as { sessionKey?: string }).sessionKey;
    if (m.type !== "error" && key && key !== sessionKey) return;
    if (m.type === "history") {
      for (const it of (m as { items: { role?: string; text?: string }[] }).items) process.stdout.write(formatHistory(it));
      return;
    }
    handle(m);
  },
  onClose: () => {},
});

handle = startRepl({ conn, clientId, sessionKey: () => sessionKey });
process.stdout.write(`Handsfree — ${args.agent} @ ${args.projectPath}\n`);

function formatHistory(it: { role?: string; text?: string }): string {
  const who = it.role === "user" ? "you" : "agent";
  return `${who}: ${it.text ?? ""}\n`;
}
