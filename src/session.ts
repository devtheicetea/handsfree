import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "./pushable.js";
import type { PermissionPolicy } from "./permissions.js";
import type { BridgeToClient } from "./protocol.js";
import { awaitSessionFile } from "./sessionFile.js";

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: {
    cwd?: string;
    resume?: string;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    settingSources?: ("user" | "project" | "local")[];
    includePartialMessages?: boolean;
    canUseTool?: (
      toolName: string,
      input: Record<string, unknown>,
      options: { signal: AbortSignal; toolUseID: string },
    ) => Promise<unknown>;
    abortController?: AbortController;
  };
}) => AsyncGenerator<SDKMessage, void> & { setPermissionMode?: (m: string) => Promise<void> };

export interface SessionDeps {
  queryFn?: QueryFn;
  waitForSessionFile?: (sessionId: string) => Promise<void>;
}

export interface StartParams {
  projectPath: string;
  resume: string | undefined;
  policy: PermissionPolicy;
  emit: (msg: BridgeToClient) => void;
}

/**
 * Owns one Claude Agent SDK query() for the lifetime of a single session.
 * Use-once: after stop()/abort/crash, create a new Session for the next
 * open_session rather than restarting this instance.
 */
export class Session {
  private readonly queryFn: QueryFn;
  private readonly waitForSessionFile: (sessionId: string) => Promise<void>;
  private prompts: Pushable<SDKUserMessage> | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private emit: ((msg: BridgeToClient) => void) | null = null;
  /** Real session id, learned from the SDK init event (after the first turn). */
  private sessionId: string | null = null;

  private active = false;
  private projectPath = "";
  private policy: PermissionPolicy | null = null;
  private currentStatus: "thinking" | "idle" | "error" = "idle";
  private turnBuffer: string[] = [];

  constructor(deps: SessionDeps = {}) {
    this.queryFn = deps.queryFn ?? (realQuery as unknown as QueryFn);
    this.waitForSessionFile = deps.waitForSessionFile ?? ((id) => awaitSessionFile(id));
  }

  /** Single emit path: tracks status + buffers the in-flight turn for reattach. */
  private send(msg: BridgeToClient): void {
    if (msg.type === "status") this.currentStatus = msg.state;
    if (msg.type === "response") {
      if (msg.done) this.turnBuffer = [];
      else if (msg.text) this.turnBuffer.push(msg.text);
    }
    this.emit?.(msg);
  }

  async start(params: StartParams): Promise<void> {
    if (this.loop) throw new Error("session already started; call stop() first");
    const { projectPath, resume, policy, emit } = params;
    this.emit = emit;
    this.projectPath = projectPath;
    this.policy = policy;
    this.active = true;
    this.turnBuffer = [];
    this.currentStatus = "idle";
    this.prompts = new Pushable<SDKUserMessage>();
    this.abort = new AbortController();

    const q = this.queryFn({
      prompt: this.prompts,
      options: {
        cwd: projectPath,
        resume,
        permissionMode: "default",
        // Bridge is the authoritative permission gate (Phase 1.5 spec §1): load
        // only project settings (keeps CLAUDE.md) and drop the user's global
        // ~/.claude allow rules so canUseTool governs every tool decision.
        settingSources: ["project"],
        includePartialMessages: true,
        abortController: this.abort,
        canUseTool: async (toolName, input) => policy.evaluate(toolName, input),
      },
    });

    this.loop = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            // The SDK only emits init AFTER the first user message. We do NOT gate
            // session_started on this (that would deadlock — the client waits for
            // session_started before prompting). We just record the real id here.
            const id = (msg as { session_id: string }).session_id;
            await this.waitForSessionFile(id);
            this.sessionId = id;
          } else if (msg.type === "stream_event") {
            const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
            if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
              this.send({ type: "response", text: ev.delta.text, done: false });
            }
          } else if (msg.type === "result") {
            this.send({ type: "response", text: "", done: true });
            this.send({ type: "status", state: "idle" });
          }
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name !== "AbortError") {
          this.send({ type: "status", state: "error" });
          this.send({ type: "error", code: "session_crashed", message: String(err) });
        }
      } finally {
        this.active = false;
      }
    })();

    // Signal readiness immediately so the client can send its first prompt. For a
    // resumed session we know the id up front; for a new session the real id is
    // learned from the init event after the first turn (sessionId stays "" here).
    this.send({ type: "session_started", sessionId: resume ?? "", projectPath, mode: policy.getMode() });
  }

  prompt(text: string): void {
    if (!this.prompts || !this.emit) throw new Error("session not started");
    this.turnBuffer = [];
    this.send({ type: "status", state: "thinking" });
    this.prompts.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
  }

  /** True while the SDK query loop is alive (between start() and stop()/crash). */
  isActive(): boolean {
    return this.active;
  }

  /** Rebind the emit sink to a reconnected client and replay current state. */
  reattach(emit: (msg: BridgeToClient) => void): void {
    this.emit = emit;
    emit({
      type: "session_started",
      sessionId: this.sessionId ?? "",
      projectPath: this.projectPath,
      mode: this.policy?.getMode() ?? "safelist",
    });
    for (const text of this.turnBuffer) emit({ type: "response", text, done: false });
    emit({ type: "status", state: this.currentStatus });
  }

  /**
   * Abort the in-flight turn. This aborts the underlying SDK query, so the
   * session loop ends; to continue, open a new session (optionally resuming
   * the same sessionId). Abort-and-continue within one live query is Phase 1.5.
   */
  abortTurn(): void {
    this.abort?.abort();
  }

  async stop(): Promise<void> {
    this.prompts?.end();
    this.abort?.abort();
    if (this.loop) await this.loop.catch(() => {});
  }
}
