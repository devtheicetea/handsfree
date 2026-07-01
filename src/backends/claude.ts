import { query as realQuery, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Pushable } from "../pushable.js";
import { awaitSessionFile } from "../sessionFile.js";
import { formatAnswers, type Question } from "../questions.js";
import { debugLog } from "../debug.js";
import type { AgentBackend, AgentEvent, BackendStartOpts, ImageAttachment } from "./types.js";

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: {
    cwd?: string;
    resume?: string;
    model?: string;
    permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
    settingSources?: ("user" | "project" | "local")[];
    includePartialMessages?: boolean;
    appendSystemPrompt?: string;
    disallowedTools?: string[];
    mcpServers?: Record<string, unknown>;
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

/** MCP server + tool names, joined into the fully-qualified id the SDK exposes. */
const QUESTION_SERVER = "handsfree";
const QUESTION_TOOL = "ask_user_question";
const QUESTION_TOOL_NAME = `mcp__${QUESTION_SERVER}__${QUESTION_TOOL}`;

const QUESTION_PROMPT =
  "When you need the user to make a design or implementation decision between a few distinct options, " +
  "call the `" + QUESTION_TOOL_NAME + "` tool with the question(s) and 2-4 options each, instead of " +
  "only asking in prose. The user picks on their phone and your tool result is their selection.";

/** In-process MCP server exposing one tool: a multiple-choice question the user
 *  answers on their phone. The handler awaits askUser and returns the selection. */
function buildQuestionServer(askUser: (questions: Question[]) => Promise<string[]>) {
  return createSdkMcpServer({
    name: QUESTION_SERVER,
    tools: [
      tool(
        QUESTION_TOOL,
        "Ask the user a multiple-choice decision question and wait for their answer. Use whenever you need " +
          "the user to choose between distinct design/implementation options (the AskUserQuestion equivalent here).",
        {
          questions: z.array(z.object({
            question: z.string().describe("The full question, ending in a question mark."),
            header: z.string().optional().describe("Very short label/chip, max 12 chars."),
            options: z.array(z.object({
              label: z.string().describe("Short choice text (1-5 words)."),
              description: z.string().optional().describe("What this choice means or implies."),
              preview: z.string().optional(),
            })).min(2).max(4),
            multiSelect: z.boolean().optional().describe("Allow selecting multiple options."),
          })).min(1).max(4),
        },
        async (args) => {
          const questions = args.questions as Question[];
          const selections = await askUser(questions);
          return { content: [{ type: "text" as const, text: formatAnswers(questions, selections) }] };
        },
      ),
    ],
  });
}

export interface ClaudeBackendDeps {
  queryFn?: QueryFn;
  waitForSessionFile?: (sessionId: string) => Promise<void>;
  /** Model id/alias for the session; undefined/null = SDK default. */
  model?: string | null;
}

/** Use-once Claude Agent SDK backend; owns one query() for the session's lifetime. */
export class ClaudeBackend implements AgentBackend {
  private readonly queryFn: QueryFn;
  private readonly waitForSessionFile: (sessionId: string) => Promise<void>;
  private readonly model: string | null;
  private readonly prompts = new Pushable<SDKUserMessage>();
  private readonly abort = new AbortController();
  private queryObj: { interrupt?: () => Promise<void> } | null = null;
  private started = false;

  constructor(deps: ClaudeBackendDeps = {}) {
    this.queryFn = deps.queryFn ?? (realQuery as unknown as QueryFn);
    this.waitForSessionFile = deps.waitForSessionFile ?? ((id) => awaitSessionFile(id));
    this.model = deps.model ?? null;
  }

  async *start(opts: BackendStartOpts): AsyncGenerator<AgentEvent, void> {
    if (this.started) throw new Error("backend already started");
    this.started = true;
    // When the bridge exposes askUser, register an in-process MCP tool the model
    // can call to put a multiple-choice decision in front of the user (the SDK
    // equivalent of the CLI's AskUserQuestion). The handler owns the tool result.
    const questionServer = opts.askUser ? buildQuestionServer(opts.askUser) : null;
    const q = this.queryFn({
      prompt: this.prompts,
      options: {
        cwd: opts.projectPath,
        resume: opts.resume,
        ...(this.model ? { model: this.model } : {}),
        ...(questionServer ? {
          mcpServers: { [QUESTION_SERVER]: questionServer },
          appendSystemPrompt: QUESTION_PROMPT,
          disallowedTools: ["AskUserQuestion"],
        } : {}),
        permissionMode: "default",
        // Bridge is the authoritative permission gate (Phase 1.5 spec §1): load
        // only project settings (keeps CLAUDE.md) and drop the user's global
        // ~/.claude allow rules so evaluate() governs every tool decision.
        settingSources: ["project"],
        includePartialMessages: true,
        abortController: this.abort,
        canUseTool: async (toolName, input) => {
          // Our own question tool IS the user interaction — never gate it behind a
          // separate "run this tool?" permission, or the user gets two prompts.
          // Match the basename too, defensively, in case the server prefix shifts.
          if (toolName === QUESTION_TOOL_NAME || toolName.endsWith(`__${QUESTION_TOOL}`)) {
            return { behavior: "allow", updatedInput: input };
          }
          // The Agent SDK requires an `allow` result to carry `updatedInput`;
          // echo the (unchanged) input back so allowed tools don't fail schema
          // validation. Deny results pass through untouched.
          const r = await opts.evaluate(toolName, input);
          return r.behavior === "allow" ? { behavior: "allow", updatedInput: input } : r;
        },
      },
    });
    this.queryObj = q;
    try {
      for await (const msg of q) {
        const subtype = (msg as { subtype?: string }).subtype;
        if (msg.type === "system" && subtype === "init") {
          // init only arrives AFTER the first user message; Session deliberately
          // does not gate session_started on it (deadlock — see session.ts).
          const id = (msg as { session_id: string }).session_id;
          await this.waitForSessionFile(id);
          yield { kind: "session_id", id };
        } else if (msg.type === "system" && subtype === "task_started") {
          // A blocking tool (Bash/Task) was run with run_in_background: it returns
          // immediately and the turn continues, but the task keeps running and
          // settles later via task_notification. SDKTaskStartedMessage.
          const m = msg as { task_id: string; description?: string };
          debugLog("sdk.task_started", { taskId: m.task_id, desc: m.description ?? "" });
          yield { kind: "task_started", taskId: m.task_id, description: m.description ?? "" };
        } else if (msg.type === "system" && subtype === "task_notification") {
          // The background task settled. SDKTaskNotificationMessage.
          const m = msg as { task_id: string; status?: string; summary?: string };
          debugLog("sdk.task_notification", { taskId: m.task_id, status: m.status ?? "completed" });
          yield { kind: "task_settled", taskId: m.task_id, status: m.status ?? "completed", summary: m.summary ?? "" };
        } else if (msg.type === "stream_event") {
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
            yield { kind: "text_delta", text: ev.delta.text };
          }
        } else if (msg.type === "user") {
          // A background task's completion is ALSO injected as a `<task-notification>` user turn
          // carrying <task-id>. The SDK `task_notification` system message fires for Bash
          // background tasks but appears NOT to for background AGENTS (Task tool) — settle off
          // this too. Logged so the next repro confirms the id matches the task_started.
          const content = (msg as { message?: { content?: unknown } }).message?.content;
          let text = "";
          if (typeof content === "string") text = content;
          else if (Array.isArray(content)) {
            for (const b of content as Array<{ type?: string; text?: string }>) if (b?.type === "text" && b.text) text += b.text + "\n";
          }
          const tn = text.match(/<task-notification>[\s\S]*?<task-id>\s*([^<\s]+)\s*<\/task-id>/i);
          if (tn) {
            debugLog("sdk.task_notification_user", { taskId: tn[1] });
            yield { kind: "task_settled", taskId: tn[1]!, status: "completed", summary: "" };
          }
        } else if (msg.type === "result") {
          yield { kind: "turn_done" };
        } else {
          // Instrumentation for the stuck-background-agent bug: surface any message carrying a
          // task_id or an unhandled `system` subtype, so a repro reveals exactly how a background
          // AGENT signals completion vs a background Bash command.
          const a = msg as { type?: string; subtype?: string; task_id?: string };
          if (a.task_id || a.type === "system") debugLog("sdk.unhandled", { type: a.type, subtype: a.subtype ?? null, taskId: a.task_id ?? null });
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
