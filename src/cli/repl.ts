import * as readline from "node:readline";
import { renderEvent, keyToDecision, type RenderAction } from "./render.js";
import { makeTheme, colorEnabled, tildify, SPINNER_FRAMES } from "./theme.js";
import { makeMarkdownStream, type MarkdownStream } from "./markdown.js";
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

const DECISIONS = [
  { key: "a", decision: "allow" as const, label: "allow" },
  { key: "s", decision: "allow_session" as const, label: "allow for session" },
  { key: "d", decision: "deny" as const, label: "deny" },
];

/**
 * Styled, status-aware CLI front end. readline stays in raw mode the whole time
 * so arrow keys / history / line editing always work; the spinner / streamed
 * reply own the bottom of the screen until a turn ends. Agent replies are
 * Markdown-rendered as they stream. Permission requests grab the keyboard for
 * single-key / arrow selection. Ctrl-C is state-aware (abort turn, deny, exit).
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
  let permIndex = 0;
  let spin: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let typing = false;                 // user is composing while the agent works
  let md: MarkdownStream | null = null;
  let savedKeypress: ((...a: unknown[]) => void)[] = [];

  const shortName = (from?: string) => (from ? from.slice(0, 8) : "you");
  const inTurn = () => state === "thinking" || state === "streaming";
  const promptStr = () => t.cyan("❯") + " " + t.bold("you") + t.dim(" · ");

  // ---- spinner (bottom line, TTY only) ---------------------------------------
  const clearLive = () => {
    if (!isTTY) return;
    readline.cursorTo(out, 0);
    readline.clearLine(out, 0);
  };
  const spinnerLabel = () => `${deps.agent} is working…`;
  const drawSpinner = () => {
    clearLive();
    out.write("  " + t.cyan(SPINNER_FRAMES[frame]!) + " " + t.dim(spinnerLabel()));
  };
  const startSpinner = () => {
    if (!isTTY) { out.write(t.dim(`  … ${spinnerLabel()}`) + "\n"); return; }
    stopSpinner();
    typing = false;
    drawSpinner();
    spin = setInterval(() => {
      // Pause animation while the user is composing a (queued) message so the
      // 80ms redraw doesn't clobber their input line.
      const composing = ((rl as unknown as { line?: string }).line ?? "").length > 0;
      if (composing) {
        if (!typing) { typing = true; clearLive(); rl.setPrompt(promptStr()); rl.prompt(true); }
        return;
      }
      if (typing) { typing = false; out.write("\n"); }   // input was submitted/cleared
      frame = (frame + 1) % SPINNER_FRAMES.length;
      drawSpinner();
    }, 80);
  };
  const stopSpinner = () => {
    if (spin) { clearInterval(spin); spin = null; }
    if (!typing) clearLive();
  };

  const printAbove = (s: string) => {
    const wasThinking = state === "thinking";
    if (wasThinking) stopSpinner();
    out.write(s);
    if (wasThinking) startSpinner();
  };

  // ---- raw key capture (permission selection) --------------------------------
  // readline keeps its own 'keypress' listener for line editing; swap it out
  // while a permission is open so single keys reach us, then restore it.
  const grabKeys = (onKey: (str: string, key: readline.Key) => void): boolean => {
    if (!isTTY) return false;
    savedKeypress = input.listeners("keypress") as typeof savedKeypress;
    for (const l of savedKeypress) input.off("keypress", l);
    input.on("keypress", onKey as (...a: unknown[]) => void);
    return true;
  };
  const releaseKeys = (onKey: (str: string, key: readline.Key) => void) => {
    if (!isTTY) return;
    input.off("keypress", onKey as (...a: unknown[]) => void);
    for (const l of savedKeypress) input.on("keypress", l);
    savedKeypress = [];
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
  const showPrompt = () => { rl.setPrompt(promptStr()); rl.prompt(); };

  // ---- state transitions ------------------------------------------------------
  const enterThinking = () => {
    if (state === "streaming") return;
    state = "thinking";
    startSpinner();
  };
  const enterStreaming = () => {
    if (state === "streaming") return;
    stopSpinner();
    state = "streaming";
    out.write("\n" + t.green("●") + " " + t.bold(deps.agent) + "\n");
    md = makeMarkdownStream(out, t);
  };
  const endTurn = () => {
    stopSpinner();
    if (md) { md.flush(); md = null; }
    state = "idle";
    out.write("\n");
    showPrompt();
  };

  // ---- permission UI ----------------------------------------------------------
  const drawPermSelector = () => {
    const opts = DECISIONS.map((d, i) =>
      i === permIndex
        ? t.cyan(t.bold(`▸ [${d.key}] ${d.label}`))
        : t.dim(`  [${d.key}] ${d.label}`),
    ).join("   ");
    clearLive();
    out.write("  " + opts + (isTTY ? "" : "  (press a / s / d)\n"));
  };
  const enterPermission = (a: Extract<RenderAction, { kind: "permission" }>) => {
    stopSpinner();
    state = "permission";
    pendingPermission = { id: a.id };
    permIndex = 0;
    out.write("\n" + t.yellow("⚠ permission request") + "\n");
    out.write("  " + t.dim("wants to use") + "  " + t.bold(a.tool) + "\n");
    if (a.detail && a.detail !== a.tool) out.write("  " + t.gray(a.detail) + "\n");
    drawPermSelector();
    if (!grabKeys(permKey)) { rl.setPrompt(t.yellow("▸") + " "); rl.prompt(); }  // non-TTY: line input
  };
  const answerPermission = (decision: "allow" | "allow_session" | "deny") => {
    const k = deps.sessionKey();
    const id = pendingPermission?.id;
    pendingPermission = null;
    releaseKeys(permKey);
    clearLive();
    out.write("  " + t.dim("→ " + decision) + "\n");
    if (k && id) deps.conn.send({ type: "permission_response", sessionKey: k, id, decision } as any);
    state = "idle";
    enterThinking();
  };
  function permKey(str: string, key: readline.Key) {
    if (key?.ctrl && key.name === "c") return answerPermission("deny");
    if (key?.name === "left") { permIndex = (permIndex + DECISIONS.length - 1) % DECISIONS.length; return drawPermSelector(); }
    if (key?.name === "right") { permIndex = (permIndex + 1) % DECISIONS.length; return drawPermSelector(); }
    if (key?.name === "return") return answerPermission(DECISIONS[permIndex]!.decision);
    const d = keyToDecision(str ?? "");
    if (d) answerPermission(d);
  }

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
        md?.write(a.text);
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
          releaseKeys(permKey);
          clearLive();
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
    if (state === "permission") {       // non-TTY fallback (TTY uses grabbed keys)
      const d = keyToDecision(line.trim());
      if (d) answerPermission(d); else rl.prompt();
      return;
    }
    const k = deps.sessionKey();
    const text = line;
    if (k && text.trim()) {
      if (!isTTY) out.write(text + "\n");
      deps.conn.send({ type: "prompt", sessionKey: k, text } as any);
      if (state === "idle") enterThinking();
      else typing = false;             // queued mid-turn; let the spinner resume
    } else if (state === "idle") {
      showPrompt();
    }
  });

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
