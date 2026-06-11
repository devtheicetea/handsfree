import { z } from "zod";
import type { HistoryItem } from "./sessionHistory.js";
import type { AgentName } from "./backends/types.js";
import type { SessionMeta } from "./stores/types.js";

export const agentSchema = z.enum(["claude", "codex"]).default("claude");

// ---------- client -> bridge ----------
export const helloSchema = z.object({ type: z.literal("hello"), token: z.string().optional() });
export const listProjectsSchema = z.object({ type: z.literal("list_projects") });
export const listSessionsSchema = z.object({ type: z.literal("list_sessions"), projectPath: z.string().min(1), agent: agentSchema });
export const openSessionSchema = z.object({
  type: z.literal("open_session"),
  projectPath: z.string().min(1),
  resume: z.union([z.literal("latest"), z.literal("new"), z.string().min(1)]),
  agent: agentSchema,
  nonce: z.string().min(1).optional(),
});
// Session-scoped messages: v0.3.0 routes by sessionKey; legacy routing used projectPath+agent.
// Both forms are accepted so old tests and new tests can coexist during the migration.
export const promptSchema = z.union([
  z.object({ type: z.literal("prompt"), sessionKey: z.string().min(1), text: z.string().min(1) }),
  z.object({ type: z.literal("prompt"), projectPath: z.string().min(1), text: z.string().min(1), agent: agentSchema }),
]);
export const permissionResponseSchema = z.union([
  z.object({ type: z.literal("permission_response"), sessionKey: z.string().min(1), id: z.string().min(1), decision: z.enum(["allow", "allow_session", "deny"]) }),
  z.object({ type: z.literal("permission_response"), projectPath: z.string().min(1), id: z.string().min(1), decision: z.enum(["allow", "allow_session", "deny"]), agent: agentSchema }),
]);
export const setModeSchema = z.union([
  z.object({ type: z.literal("set_mode"), sessionKey: z.string().min(1), mode: z.enum(["safelist", "ask_all", "auto"]) }),
  z.object({ type: z.literal("set_mode"), projectPath: z.string().min(1), mode: z.enum(["safelist", "ask_all", "auto"]), agent: agentSchema }),
]);
export const abortSchema = z.union([
  z.object({ type: z.literal("abort"), sessionKey: z.string().min(1) }),
  z.object({ type: z.literal("abort"), projectPath: z.string().min(1), agent: agentSchema }),
]);

// clientMessageSchema uses z.union (not discriminatedUnion) because the session-scoped
// schemas are themselves z.union shapes and cannot be nested into a discriminatedUnion.
export const clientMessageSchema = z.union([
  helloSchema,
  listProjectsSchema,
  listSessionsSchema,
  openSessionSchema,
  promptSchema,
  permissionResponseSchema,
  setModeSchema,
  abortSchema,
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
  | { type: "hello_ok"; version: string }
  | { type: "projects"; projects: ProjectInfo[] }
  | { type: "sessions"; projectPath: string; agent: AgentName; sessions: SessionMeta[] }
  | { type: "session_started"; nonce: string; sessionKey: string; projectPath: string; agent: AgentName; resumeId: string; mode: PermissionModeName }
  | { type: "status"; sessionKey: string; state: "thinking" | "idle" | "error" }
  | { type: "response"; sessionKey: string; turn: number; text: string; done: boolean }
  | { type: "permission_request"; sessionKey: string; id: string; tool: string; input: unknown; detail: string }
  | { type: "history"; sessionKey: string; items: HistoryItem[] }
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
