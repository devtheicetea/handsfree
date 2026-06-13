import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Pushable } from "../pushable.js";
import { awaitSessionFile } from "../sessionFile.js";
import type { AgentBackend, AgentEvent, BackendStartOpts, ImageAttachment } from "./types.js";

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
}) => AsyncGenerator<SDKMessage, void> & {
  setPermissionMode?: (m: string) => Promise<void>;
  interrupt?: () => Promise<void>;
};

export interface ClaudeBackendDeps {
  queryFn?: QueryFn;
  waitForSessionFile?: (sessionId: string) => Promise<void>;
}

/** Use-once Claude Agent SDK backend; owns one query() for the session's lifetime. */
export class ClaudeBackend implements AgentBackend {
  private readonly queryFn: QueryFn;
  private readonly waitForSessionFile: (sessionId: string) => Promise<void>;
  private readonly prompts = new Pushable<SDKUserMessage>();
  private readonly abort = new AbortController();
  private queryObj: { interrupt?: () => Promise<void> } | null = null;
  private started = false;

  constructor(deps: ClaudeBackendDeps = {}) {
    this.queryFn = deps.queryFn ?? (realQuery as unknown as QueryFn);
    this.waitForSessionFile = deps.waitForSessionFile ?? ((id) => awaitSessionFile(id));
  }

  async *start(opts: BackendStartOpts): AsyncGenerator<AgentEvent, void> {
    if (this.started) throw new Error("backend already started");
    this.started = true;
    const q = this.queryFn({
      prompt: this.prompts,
      options: {
        cwd: opts.projectPath,
        resume: opts.resume,
        permissionMode: "default",
        // Bridge is the authoritative permission gate (Phase 1.5 spec §1): load
        // only project settings (keeps CLAUDE.md) and drop the user's global
        // ~/.claude allow rules so evaluate() governs every tool decision.
        settingSources: ["project"],
        includePartialMessages: true,
        abortController: this.abort,
        canUseTool: async (toolName, input) => opts.evaluate(toolName, input),
      },
    });
    this.queryObj = q;
    try {
      for await (const msg of q) {
        if (msg.type === "system" && (msg as { subtype?: string }).subtype === "init") {
          // init only arrives AFTER the first user message; Session deliberately
          // does not gate session_started on it (deadlock — see session.ts).
          const id = (msg as { session_id: string }).session_id;
          await this.waitForSessionFile(id);
          yield { kind: "session_id", id };
        } else if (msg.type === "stream_event") {
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            yield { kind: "text_delta", text: ev.delta.text };
          }
        } else if (msg.type === "result") {
          yield { kind: "turn_done" };
        }
      }
    } catch (err) {
      // A deliberate abort (stop()) is NOT a crash. The SDK can throw a plain
      // Error("Operation aborted") whose name is "Error", not "AbortError", so
      // detect the abort via the signal — not the error name.
      const aborted = this.abort.signal.aborted;
      const name = err instanceof Error ? err.name : "";
      if (!aborted && name !== "AbortError") throw err;
    }
  }

  prompt(text: string, attachments?: ImageAttachment[]): void {
    // With images, content becomes an array of blocks (images first, then the
    // text); without, it stays a plain string. media_type is constrained by the
    // SDK to a small union — we only ever send downscaled JPEG/PNG from the app.
    const content: SDKUserMessage["message"]["content"] = attachments?.length
      ? ([
          ...attachments.map((a) => ({ type: "image", source: { type: "base64", media_type: a.mime, data: a.dataBase64 } })),
          ...(text.trim() ? [{ type: "text", text }] : []),
        ] as unknown as SDKUserMessage["message"]["content"])
      : text;
    this.prompts.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    await this.queryObj?.interrupt?.().catch(() => {});
  }

  async stop(): Promise<void> {
    this.prompts.end();
    this.abort.abort();
    this.queryObj = null;
  }
}
