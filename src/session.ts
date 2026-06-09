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

export class Session {
  private readonly queryFn: QueryFn;
  private readonly waitForSessionFile: (sessionId: string) => Promise<void>;
  private prompts: Pushable<SDKUserMessage> | null = null;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private emit: ((msg: BridgeToClient) => void) | null = null;
  /** Real session id, learned from the SDK init event (after the first turn). */
  private sessionId: string | null = null;

  constructor(deps: SessionDeps = {}) {
    this.queryFn = deps.queryFn ?? (realQuery as unknown as QueryFn);
    this.waitForSessionFile = deps.waitForSessionFile ?? ((id) => awaitSessionFile(id));
  }

  async start(params: StartParams): Promise<void> {
    if (this.loop) throw new Error("session already started; call stop() first");
    const { projectPath, resume, policy, emit } = params;
    this.emit = emit;
    this.prompts = new Pushable<SDKUserMessage>();
    this.abort = new AbortController();

    const q = this.queryFn({
      prompt: this.prompts,
      options: {
        cwd: projectPath,
        resume,
        permissionMode: "default",
        abortController: this.abort,
        canUseTool: async (toolName, input) => policy.evaluate(toolName, input),
      },
    });

    this.loop = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
            // The SDK only emits init after the first user message. We do NOT
            // gate session_started on this (that would deadlock — the client
            // waits for session_started before prompting). Instead we record
            // the real session id here for future resume continuity.
            const id = (msg as { session_id: string }).session_id;
            await this.waitForSessionFile(id);
            this.sessionId = id;
          } else if (msg.type === "assistant") {
            const content = (msg as { message: { content: unknown } }).message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
                  emit({ type: "response", text: (block as { text: string }).text, done: false });
                }
              }
            }
          } else if (msg.type === "result") {
            emit({ type: "response", text: "", done: true });
            emit({ type: "status", state: "idle" });
          }
        }
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name !== "AbortError") {
          emit({ type: "status", state: "error" });
          emit({ type: "error", code: "session_crashed", message: String(err) });
        }
      }
    })();

    // Signal readiness immediately so the client can send its first prompt.
    // For a resumed session we know the id up front; for a new session the
    // real id is learned from the init event after the first turn.
    emit({ type: "session_started", sessionId: resume ?? "", projectPath, mode: policy.getMode() });
  }

  prompt(text: string): void {
    if (!this.prompts || !this.emit) throw new Error("session not started");
    this.emit({ type: "status", state: "thinking" });
    this.prompts.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    });
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
