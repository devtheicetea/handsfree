import { WebSocket } from "ws";
import { createInterface } from "node:readline";

const url = process.env.HANDSFREE_URL ?? "ws://127.0.0.1:8744";
const token = process.env.HANDSFREE_TOKEN;
const ws = new WebSocket(url);
const rl = createInterface({ input: process.stdin, output: process.stdout });

ws.on("open", () => {
  ws.send(JSON.stringify(token ? { type: "hello", token } : { type: "hello" }));
});

ws.on("message", (data) => {
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case "hello_ok":
      ws.send(JSON.stringify({ type: "list_projects" }));
      break;
    case "projects":
      console.log("\nProjects:");
      msg.projects.forEach((p: { path: string }, i: number) => console.log(`  [${i}] ${p.path}`));
      rl.question("Pick project index: ", (idx) => {
        const proj = msg.projects[Number(idx)];
        ws.send(JSON.stringify({ type: "open_session", projectPath: proj.path, resume: "latest" }));
      });
      break;
    case "session_started":
      console.log(`\nSession ${msg.sessionId} ready (mode: ${msg.mode}). Type prompts:`);
      promptLoop();
      break;
    case "response":
      if (msg.text) process.stdout.write(msg.text);
      if (msg.done) process.stdout.write("\n> ");
      break;
    case "permission_request":
      rl.question(`\n[permission] ${msg.tool} — allow/allow_session/deny? `, (ans) => {
        const decision = ["allow", "allow_session", "deny"].includes(ans) ? ans : "deny";
        ws.send(JSON.stringify({ type: "permission_response", id: msg.id, decision }));
      });
      break;
    case "status":
      if (msg.state === "thinking") process.stdout.write("…");
      break;
    case "error":
      console.error(`\n[error ${msg.code}] ${msg.message}`);
      break;
  }
});

function promptLoop() {
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "/quit") { ws.close(); process.exit(0); }
    if (text === "/auto") { ws.send(JSON.stringify({ type: "set_mode", mode: "auto" })); return; }
    if (text === "/ask") { ws.send(JSON.stringify({ type: "set_mode", mode: "ask_all" })); return; }
    if (text === "/abort") { ws.send(JSON.stringify({ type: "abort" })); return; }
    if (text.length > 0) ws.send(JSON.stringify({ type: "prompt", text }));
  });
}

ws.on("close", () => { console.log("\nconnection closed"); process.exit(0); });
