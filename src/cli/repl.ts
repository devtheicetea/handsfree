import * as readline from "node:readline";
import { renderEvent, keyToDecision, type RenderAction } from "./render.js";
import { makeTheme, colorEnabled, tildify, SPINNER_FRAMES } from "./theme.js";
import type { Connection } from "./connection.js";
import type { BridgeToClient } from "../protocol.js";

export type ConnState = "connecting" | "connected" | "reconnecting";

export interface ReplDeps {
  conn: Connection;
  clientId: string;
  sessionKey: () => string | null;   // resolved after session_started
  agent: string;
  projectPath: string;
  out?: NodeJS.WriteStream;
  input?: NodeJS.ReadStream;
}

export interface Repl {
  /** Feed a bridge event into the UI. */
  handle(m: BridgeToClient): void;
  setConnection(s: ConnState): void;
  setMode(mode: string): void;
  printHistory(items: { role?: string; text?: string }[]): void;
}

type UiState = "idle" | "thinking" | "streaming" | "permission";

/**
 * Styled, status-aware CLI front end. readline stays active (raw mode) the whole
 * time so arrow keys / history / line editing always work; we just don't re-draw
 * the prompt while the agent is working, and the spinner / streamed reply own the
 * bottom of the screen until the turn ends. Ctrl-C is routed through readline's
 * SIGINT event: abort the turn when one is running, exit when idle.
 */
export function startRepl(deps: ReplDeps): Repl {
  const out = deps.out ?? process.stdout;
  const input = deps.input ?? process.stdin;
  const isTTY = out.isTTY === true && input.isTTY === true;
  const t = makeTheme(colorEnabled(out));

  const rl = readline.createInterface({ input, output: out });

  let state: UiState = "idle";
  let mode = "safelist";
  let conn: ConnState = "connecting";
  let pendingPermission: { id: string } | null = null;
  let spin: ReturnType<typeof setInterval> | null = null;
  let frame = 0;

  const shortName = (from?: string) => (from ? from.slice(0, 8) : "you");
  const inTurn = () => state === "thinking" || state === "streaming";

  // ---- spinner (bottom line, TTY only) ---------------------------------------
  const clearLive = () => {
    if (!isTTY) return;
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
  };
  const spinnerLabel = () => `${deps.agent} is working…`;
  const startSpinner = () => {
    if (!isTTY) { out.write(t.dim(`  … ${spinnerLabel()}`) + "\n"); return; }
    stopSpinner();
    out.write("  " + t.cyan(SPINNER_FRAMES[0]!) + " " + t.dim(spinnerLabel()));
    spin = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      clearLive();
      out.write("  " + t.cyan(SPINNER_FRAMES[frame]!) + " " + t.dim(spinnerLabel()));
    }, 80);
  };
  const stopSpinner = () => {
    if (spin) { clearInterval(spin); spin = null; }
    clearLive();
  };

  // Re-show the spinner around a discrete print so it isn't clobbered.
  const printAbove = (s: string) => {
    const wasThinking = state === "thinking";
    if (wasThinking) stopSpinner();
    out.write(s);
    if (wasThinking) startSpinner();
  };

  // ---- status bar / prompt ----------------------------------------------------
  const connMark = () =>
    conn === "connected" ? t.green("●") : conn === "reconnecting" ? t.yellow("◐") : t.dim("○");
  const modeMark = () =>
    mode === "auto" ? t.red(mode) : mode === "ask_all" ? t.yellow(mode) : t.green(mode);
  const statusBar = () => {
    const sep = t.dim(" · ");
    return (
      t.bold("handsfree") + sep + t.cyan(deps.agent) + sep + t.gray(tildify(deps.projectPath)) +
      sep + modeMark() + sep + connMark() + " " + t.dim(conn)
    );
  };
  // The "you ·" label lives in the prompt so readline's own echo renders the
  // labeled input line — re-printing it ourselves would double it.
  const showPrompt = () => {
    rl.setPrompt(t.cyan("❯") + " " + t.bold("you") + t.dim(" · "));
    rl.prompt();
  };

  // ---- state transitions ------------------------------------------------------
  const enterThinking = () => {
    if (state === "streaming") return;     // already producing output
    state = "thinking";
    startSpinner();
  };
  const enterStreaming = () => {
    if (state === "streaming") return;
    stopSpinner();
    state = "streaming";
    out.write("\n" + t.green("●") + " " + t.bold(deps.agent) + "\n");
  };
  const endTurn = () => {
    stopSpinner();
    if (state === "streaming") out.write("\n");
    state = "idle";
    out.write("\n");
    showPrompt();
  };

  // ---- permission UI ----------------------------------------------------------
  const enterPermission = (a: Extract<RenderAction, { kind: "permission" }>) => {
    stopSpinner();
    state = "permission";
    pendingPermission = { id: a.id };
    out.write("\n" + t.yellow("⚠ permission request") + "\n");
    out.write("  " + t.dim("wants to use") + "  " + t.bold(a.tool) + "\n");
    if (a.detail && a.detail !== a.tool) out.write("  " + t.gray(a.detail) + "\n");
    out.write(
      "  " + t.cyan(t.bold("[a]")) + " allow   " +
      t.cyan(t.bold("[s]")) + " allow for session   " +
      t.cyan(t.bold("[d]")) + " deny\n",
    );
    rl.setPrompt(t.yellow("▸") + " ");
    rl.prompt();
  };
  const answerPermission = (decision: "allow" | "allow_session" | "deny") => {
    const k = deps.sessionKey();
    const id = pendingPermission?.id;
    pendingPermission = null;
    out.write("  " + t.dim("→ " + decision) + "\n");
    if (k && id) deps.conn.send({ type: "permission_response", sessionKey: k, id, decision } as any);
    state = "idle";
    enterThinking();                   // the agent continues
  };

  // ---- apply a render action --------------------------------------------------
  const apply = (a: RenderAction) => {
    switch (a.kind) {
      case "none":
        return;
      case "status":
        if (a.state === "thinking") enterThinking();
        return;
      case "stream":
        enterStreaming();
        out.write(a.text);
        return;
      case "turnEnd":
        if (inTurn()) endTurn();
        return;
      case "message":
        printAbove("\n" + t.cyan("❯") + " " + t.bold(shortName(a.from)) + t.dim(" · ") + a.text + "\n");
        return;
      case "permission":
        enterPermission(a);
        return;
      case "permissionResolved":
        if (pendingPermission?.id === a.id) {
          pendingPermission = null;
          out.write("  " + t.dim("→ answered on another device") + "\n");
          state = "idle";
          enterThinking();
        }
        return;
      case "error":
        printAbove("\n" + t.red("✖ " + a.code) + " " + a.message + "\n");
        if (inTurn()) endTurn();
        return;
    }
  };

  // ---- input ------------------------------------------------------------------
  rl.on("line", (line) => {
    if (state === "permission") {
      const d = keyToDecision(line.trim());
      if (d) answerPermission(d);
      else rl.prompt();                // unrecognized — keep waiting
      return;
    }
    const k = deps.sessionKey();
    const text = line;
    if (k && text.trim()) {
      if (!isTTY) out.write(text + "\n");   // non-TTY: input isn't echoed; complete the line
      deps.conn.send({ type: "prompt", sessionKey: k, text } as any);
      if (state === "idle") enterThinking();
      // Mid-turn input is queued by the bridge — keep the current state.
    } else if (state === "idle") {
      showPrompt();
    }
  });

  // Ctrl-C: abort a running turn (stay alive), deny a pending permission, else exit.
  rl.on("SIGINT", () => {
    if (inTurn()) {
      const k = deps.sessionKey();
      if (k) deps.conn.send({ type: "abort", sessionKey: k } as any);
      return;
    }
    if (state === "permission") { answerPermission("deny"); return; }
    deps.conn.close();
    process.exit(0);
  });
  rl.on("close", () => { deps.conn.close(); process.exit(0); });

  // ---- startup ----------------------------------------------------------------
  out.write("\n" + statusBar() + "\n\n");
  showPrompt();

  return {
    handle: (m) => apply(renderEvent(m, deps.clientId)),
    setConnection: (s) => {
      if (s === conn) return;
      conn = s;
      printAbove(t.dim("  " + statusBar()) + "\n");
    },
    setMode: (m) => { mode = m; },
    printHistory: (items) => {
      for (const it of items) {
        const who = it.role === "user" ? t.bold("you") : t.bold(deps.agent);
        const mark = it.role === "user" ? t.cyan("❯") : t.green("●");
        out.write(mark + " " + who + t.dim(" · ") + (it.text ?? "") + "\n");
      }
      out.write("\n");
      showPrompt();
    },
  };
}
