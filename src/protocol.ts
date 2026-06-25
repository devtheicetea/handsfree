import { z } from "zod";
import type { HistoryItem } from "./sessionHistory.js";
import type { AgentName } from "./backends/types.js";
import type { SessionMeta } from "./stores/types.js";
import type { Question } from "./questions.js";

export const agentSchema = z.enum(["claude", "codex"]).default("claude");

// ---------- client -> bridge ----------
export const helloSchema = z.object({ type: z.literal("hello"), token: z.string().optional(), clientId: z.string().optional() });
export const listProjectsSchema = z.object({ type: z.literal("list_projects") });
export const listSessionsSchema = z.object({ type: z.literal("list_sessions"), projectPath: z.string().min(1), agent: agentSchema });
export const openSessionSchema = z.object({
  type: z.literal("open_session"),
  projectPath: z.string().min(1),
  resume: z.union([z.literal("latest"), z.literal("new"), z.string().min(1)]),
  agent: agentSchema,
  nonce: z.string().min(1),
});
// Session-scoped messages: v0.3.0 routes by sessionKey.
// v0.6.0: an optional image attachment list (base64). text may be empty when
// attachments are present (image-only message); the client gates send.
export const imageAttachmentSchema = z.object({ mime: z.string().min(1), dataBase64: z.string().min(1) });
export const promptSchema = z.object({
  type: z.literal("prompt"),
  sessionKey: z.string().min(1),
  text: z.string(),
  attachments: z.array(imageAttachmentSchema).optional(),
});
export const permissionResponseSchema = z.object({
  type: z.literal("permission_response"), sessionKey: z.string().min(1),
  id: z.string().min(1), decision: z.enum(["allow", "allow_session", "deny"]),
});
// The user's answer to an `ask_user_question` tool call: `selections[i]` answers
// `questions[i]` (comma-joined for multi-select; freeform "Other" text passes through).
export const questionResponseSchema = z.object({
  type: z.literal("question_response"), sessionKey: z.string().min(1),
  id: z.string().min(1), selections: z.array(z.string()),
});
export const setModeSchema = z.object({ type: z.literal("set_mode"), sessionKey: z.string().min(1), mode: z.enum(["safelist", "ask_all", "auto"]) });
export const abortSchema = z.object({ type: z.literal("abort"), sessionKey: z.string().min(1) });
// v0.4.0 mirroring: view = history snapshot + live watch (no bridge session).
export const viewSessionSchema = z.object({
  type: z.literal("view_session"), projectPath: z.string().min(1), agent: agentSchema, sessionId: z.string().min(1),
  // When the viewed session is actually a LIVE bridge-owned session, the bridge
  // attaches the client to it (live streaming) and echoes this nonce back in
  // session_started so the client can switch from its optimistic mirror.
  nonce: z.string().optional(),
});
export const unviewSessionSchema = z.object({ type: z.literal("unview_session") });
export const unsubscribeSchema = z.object({ type: z.literal("unsubscribe"), sessionKey: z.string().min(1) });
export const deleteSessionSchema = z.object({ type: z.literal("delete_session"), projectPath: z.string().min(1), agent: agentSchema, sessionId: z.string().min(1) });
export const renameSessionSchema = z.object({ type: z.literal("rename_session"), projectPath: z.string().min(1), agent: agentSchema, sessionId: z.string().min(1), name: z.string() });
// Diagnostic breadcrumb from the client — logged to handsfree-bridge.log so the
// client's reconnect/catch-up decisions land in the same file as the bridge's.
export const diagSchema = z.object({ type: z.literal("diag"), msg: z.string() });

// Keep the active session alive past the disconnect grace: the app HOLDS it (voice mode on, or
// backgrounding with the conversation open) and RELEASES it when the user leaves it. See
// SessionManager.scheduleGracefulStop.
export const holdSessionSchema = z.object({
  type: z.literal("session_hold"),
  sessionKey: z.string().min(1),
  reason: z.enum(["voice", "background"]).optional(),
});
export const releaseSessionSchema = z.object({ type: z.literal("session_release"), sessionKey: z.string().min(1) });

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  listProjectsSchema,
  listSessionsSchema,
  openSessionSchema,
  promptSchema,
  permissionResponseSchema,
  questionResponseSchema,
  setModeSchema,
  abortSchema,
  viewSessionSchema,
  unviewSessionSchema,
  unsubscribeSchema,
  deleteSessionSchema,
  renameSessionSchema,
  diagSchema,
  holdSessionSchema,
  releaseSessionSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type PermissionModeName = z.infer<typeof setModeSchema>["mode"];

// ---------- bridge -> client ----------
export type AgentSessionMeta = {
  lastSessionId: string | null;
  lastActive: number | null;
  lastMessage: HistoryItem | null;
};

export type ProjectInfo = {
  path: string;
  name: string;
  agents: { claude?: AgentSessionMeta; codex?: AgentSessionMeta };
};

export type BridgeToClient =
  | { type: "hello_ok"; version: string; agents: { claude: boolean; codex: boolean } }
  | { type: "projects"; projects: ProjectInfo[] }
  | { type: "sessions"; projectPath: string; agent: AgentName; sessions: SessionMeta[] }
  | { type: "session_started"; nonce: string; sessionKey: string; projectPath: string; agent: AgentName; resumeId: string; mode: PermissionModeName }
  | { type: "status"; sessionKey: string; state: "thinking" | "idle" | "error" }
  // Background-task lifecycle, surfaced so the client can show WHICH task is running
  // ("⚙️ <description>…") and chime on completion. Incremental: started adds, settled
  // removes; reattach re-sends a started for each still-running task (see replayTo).
  | { type: "task_started"; sessionKey: string; id: string; description: string }
  | { type: "task_settled"; sessionKey: string; id: string; status: string }
  | { type: "response"; sessionKey: string; turn: number; text: string; done: boolean }
  | { type: "permission_request"; sessionKey: string; id: string; tool: string; input: unknown; detail: string }
  | { type: "question_request"; sessionKey: string; id: string; questions: Question[] }
  | { type: "question_resolved"; sessionKey: string; id: string }
  | { type: "user_message"; sessionKey: string; turn: number; text: string; attachments?: { mime: string; dataBase64: string }[]; origin: string }
  | { type: "permission_resolved"; sessionKey: string; id: string }
  | { type: "history"; sessionKey: string; items: HistoryItem[] }
  // v0.4.0 mirroring (no sessionKey — these address sessions by (agent, sessionId)):
  | { type: "session_history"; projectPath: string; agent: AgentName; sessionId: string; items: HistoryItem[]; mode?: PermissionModeName }
  | { type: "external_turns"; projectPath: string; agent: AgentName; sessionId: string; items: HistoryItem[] }
  | { type: "session_activity"; projectPath: string; agent: AgentName; sessionId: string; lastActive: number; preview: HistoryItem | null }
  | { type: "error"; sessionKey?: string; code: string; message: string };

// ---------- parsing ----------
export type ParseResult =
  | { ok: true; value: ClientMessage }
  | { ok: false; error: string };

export function parseClientMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  const result = clientMessageSchema.safeParse(json);
  if (!result.success) return { ok: false, error: result.error.message };
  return { ok: true, value: result.data };
}

export function encode(msg: BridgeToClient): string {
  return JSON.stringify(msg);
}
