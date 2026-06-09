import { z } from "zod";

// ---------- client -> bridge ----------
export const helloSchema = z.object({ type: z.literal("hello"), token: z.string().optional() });
export const listProjectsSchema = z.object({ type: z.literal("list_projects") });
export const openSessionSchema = z.object({
  type: z.literal("open_session"),
  projectPath: z.string().min(1),
  resume: z.union([z.literal("latest"), z.literal("new"), z.string().min(1)]),
});
export const promptSchema = z.object({ type: z.literal("prompt"), text: z.string().min(1) });
export const permissionResponseSchema = z.object({
  type: z.literal("permission_response"),
  id: z.string().min(1),
  decision: z.enum(["allow", "allow_session", "deny"]),
});
export const setModeSchema = z.object({
  type: z.literal("set_mode"),
  mode: z.enum(["safelist", "ask_all", "auto"]),
});
export const abortSchema = z.object({ type: z.literal("abort") });

export const clientMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  listProjectsSchema,
  openSessionSchema,
  promptSchema,
  permissionResponseSchema,
  setModeSchema,
  abortSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type PermissionModeName = z.infer<typeof setModeSchema>["mode"];

// ---------- bridge -> client ----------
export type ProjectInfo = {
  path: string;
  name: string;
  lastSessionId: string | null;
  lastActive: number | null;
};

export type BridgeToClient =
  | { type: "hello_ok"; version: string }
  | { type: "projects"; projects: ProjectInfo[] }
  // sessionId is "" for a brand-new session; the real id is only known after the
  // first turn (learned from the SDK init event), so treat "" as "id unknown".
  | { type: "session_started"; sessionId: string; projectPath: string; mode: PermissionModeName }
  | { type: "status"; state: "thinking" | "idle" | "error" }
  | { type: "response"; text: string; done: boolean }
  | { type: "permission_request"; id: string; tool: string; input: unknown; detail: string }
  | { type: "error"; code: string; message: string };

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
