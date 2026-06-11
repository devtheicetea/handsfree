import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { Pushable } from "../pushable.js";
import { JsonRpcConnection, type Json } from "./jsonrpc.js";
import type { AgentBackend, AgentEvent, BackendStartOpts } from "./types.js";

// ---------------------------------------------------------------------------
// Wire constants — the ONLY place app-server method names / enum values live.
// Verified against a captured transcript of the pinned CLI (see the plan's
// Task 12); if the transcript disagrees, fix THESE, not the call sites.
// ---------------------------------------------------------------------------
const SANDBOX_MODE = "workspaceWrite";
const APPROVAL_POLICY = "onRequest";
const M = {
  initialize: "initialize",
  initialized: "initialized",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  turnStart: "turn/start",
  turnInterrupt: "turn/interrupt",
} as const;
const N = {
  agentDelta: "item/agentMessage/delta",
  itemStarted: "item/started",
  turnStarted: "turn/started",
  turnCompleted: "turn/completed",
} as const;
const APPROVAL = {
  exec: "item/commandExecution/requestApproval",
  fileChange: "item/fileChange/requestApproval",
} as const;
const FILE_CHANGE_ITEM_TYPE = "fileChange";

export class CodexUnavailableError extends Error {}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export interface CodexBackendDeps {
  /** Config override; null/undefined = `codex` on PATH. */
  codexPath?: string | null;
  spawnFn?: SpawnFn;
  log?: (msg: string) => void;
}

/** Preflight used by the server on open_session: the binary runs and prints a version. */
export function checkCodexAvailable(codexPath: string | null, spawnFn: SpawnFn = spawn): Promise<string> {
  const cmd = codexPath ?? "codex";
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnFn(cmd, ["--version"]); }
    catch (err) { reject(new CodexUnavailableError(`cannot run ${cmd}: ${String(err)}`)); return; }
    let out = "";
    child.stdout.on("data", (c) => { out += String(c); });
    child.on("error", (err) => reject(new CodexUnavailableError(`cannot run ${cmd}: ${String(err)}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new CodexUnavailableError(`${cmd} --version exited with ${code}`));
    });
  });
}

/**
 * Use-once Codex backend: owns one `codex app-server` child process per session
 * and adapts its JSON-RPC stream to AgentEvents. The bridge stays the
 * authoritative permission gate: every approval request is answered via
 * opts.evaluate with a pseudo-tool name (spec §4).
 */
export class CodexBackend implements AgentBackend {
  private readonly codexPath: string | null;
  private readonly spawnFn: SpawnFn;
  private readonly log: (msg: string) => void;
  private readonly events = new Pushable<AgentEvent>();
  private rpc: JsonRpcConnection | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private started = false;
  private stopping = false;
  private crashError: Error | null = null;
  private projectPath = "";
  /** Prompts sent before the thread is ready; flushed right after session_id. */
  private pendingPrompts: string[] = [];
  /** fileChange items seen, by item id — input for the safelist path check. */
  private readonly fileChanges = new Map<string, Json>();

  constructor(deps: CodexBackendDeps = {}) {
    this.codexPath = deps.codexPath ?? null;
    this.spawnFn = deps.spawnFn ?? (spawn as SpawnFn);
    this.log = deps.log ?? (() => {});
  }

  async *start(opts: BackendStartOpts): AsyncGenerator<AgentEvent, void> {
    if (this.started) throw new Error("backend already started");
    this.started = true;
    this.projectPath = opts.projectPath;
    const cmd = this.codexPath ?? "codex";
    const child = this.spawnFn(cmd, ["app-server"]);
    this.child = child;
    child.on("error", (err) => this.crash(new Error(`codex app-server: ${String(err)}`)));
    child.on("exit", (code) => {
      if (!this.stopping) this.crash(new Error(`codex app-server exited with code ${code}`));
    });
    const rpc = new JsonRpcConnection(child.stdout, child.stdin, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params, opts),
    }, this.log);
    this.rpc = rpc;

    let id: string;
    try {
      await rpc.request(M.initialize, { clientInfo: { name: "handsfree-bridge", title: "Handsfree", version: "0.2.0" } });
      rpc.notify(M.initialized);
      const threadParams: Json = { cwd: opts.projectPath, sandbox: SANDBOX_MODE, approvalPolicy: APPROVAL_POLICY };
      const res = opts.resume
        ? await rpc.request(M.threadResume, { threadId: opts.resume, ...threadParams })
        : await rpc.request(M.threadStart, threadParams);
      const got = (res.thread as { id?: string } | undefined)?.id ?? opts.resume;
      if (!got) throw new Error("codex: thread/start returned no thread id");
      id = got;
    } catch (err) {
      // stop() during startup rejects the in-flight request — that's a clean
      // shutdown, not a crash (spec §5). A real child death during startup is
      // reported with the structured exit reason, not the jsonrpc wrapper.
      if (this.stopping) return;
      throw this.crashError ?? err;
    }
    this.threadId = id;
    yield { kind: "session_id", id };

    for (const text of this.pendingPrompts.splice(0)) this.sendTurn(text);
    yield* this.events;
    if (this.crashError && !this.stopping) throw this.crashError;
  }

  private crash(err: Error): void {
    if (this.crashError || this.stopping) return;
    this.crashError = err;
    this.rpc?.end(err.message);
    this.events.end(); // start()'s `yield*` finishes, then throws crashError
  }

  private onNotification(method: string, params: Json): void {
    if (this.stopping || this.crashError) return;
    if (method === N.agentDelta) {
      const delta = params.delta;
      if (typeof delta === "string" && delta) this.events.push({ kind: "text_delta", text: delta });
    } else if (method === N.turnStarted) {
      this.turnId = (params.turn as { id?: string } | undefined)?.id ?? null;
    } else if (method === N.turnCompleted) {
      this.fileChanges.clear();
      this.events.push({ kind: "turn_done" });
    } else if (method === N.itemStarted) {
      const item = params.item as { id?: string; type?: string } | undefined;
      if (item?.id && item.type === FILE_CHANGE_ITEM_TYPE) this.fileChanges.set(item.id, item as Json);
    }
  }

  private async onRequest(method: string, params: Json, opts: BackendStartOpts): Promise<Json> {
    if (method === APPROVAL.exec) {
      const input = { command: params.command, cwd: params.cwd, reason: params.reason } as Record<string, unknown>;
      const r = await opts.evaluate("CodexExec", input);
      // Only accept/decline are ever sent: session-grants are the bridge's concern (PermissionPolicy allow_session), never codex's acceptForSession.
      return { decision: r.behavior === "allow" ? "accept" : "decline" };
    }
    if (method === APPROVAL.fileChange) {
      const itemId = typeof params.itemId === "string" ? params.itemId : "";
      const item = this.fileChanges.get(itemId);
      // Inside-project patches use the safelisted pseudo-tool; boundary-crossing
      // or unknown items use a distinct name that is never safelisted (spec §4).
      const tool = item && this.allInsideProject(item) ? "CodexApplyPatch" : "CodexApplyPatchOutside";
      const r = await opts.evaluate(tool, { itemId, changes: (item as { changes?: unknown } | undefined)?.changes ?? null });
      return { decision: r.behavior === "allow" ? "accept" : "decline" };
    }
    this.log(`codex: unexpected server request ${method} — declining`);
    return { decision: "decline" };
  }

  // Paths come from codex's own file-change reports (codex runs sandboxed); symlink escape inside the project is accepted, this is not a hardened boundary.
  private allInsideProject(item: Json): boolean {
    const changes = (item as { changes?: Array<{ path?: unknown }> }).changes;
    if (!Array.isArray(changes) || changes.length === 0) return false; // unknown -> conservative: ask
    const root = this.projectPath.endsWith("/") ? this.projectPath.slice(0, -1) : this.projectPath;
    return changes.every((c) => {
      if (typeof c?.path !== "string") return false;
      const abs = isAbsolute(c.path) ? c.path : resolvePath(root, c.path);
      return abs === root || abs.startsWith(root + "/");
    });
  }

  private sendTurn(text: string): void {
    try {
      void this.rpc!.request(M.turnStart, { threadId: this.threadId, input: [{ type: "text", text }] }).catch(() => {
        // a failed turn/start surfaces via the child's exit/crash path
      });
    } catch {
      // synchronous write failure (e.g. EPIPE race while the child dies):
      // the exit/error handler crashes the stream; nothing to do here
    }
  }

  prompt(text: string): void {
    if (!this.rpc || !this.threadId) { this.pendingPrompts.push(text); return; }
    this.sendTurn(text);
  }

  async interrupt(): Promise<void> {
    if (!this.rpc || !this.threadId || !this.turnId) return;
    await this.rpc.request(M.turnInterrupt, { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.rpc?.end("stopped");
    this.events.end();
    this.child?.kill();
  }
}
