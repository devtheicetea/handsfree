import type { PermissionResult } from "../permissions.js";

export type AgentName = "claude" | "codex";

/** Normalized stream every backend emits; Session consumes it agnostic of agent. */
export type AgentEvent =
  | { kind: "session_id"; id: string }   // real session/thread id, once known
  | { kind: "text_delta"; text: string } // streamed assistant text
  | { kind: "turn_done" }                 // the in-flight turn finished
  | { kind: "turn_failed"; message: string }; // turn ended in error; session stays alive

export interface BackendStartOpts {
  projectPath: string;
  /** Session/thread id to resume, or undefined for a new session. */
  resume: string | undefined;
  /** The bridge's authoritative permission gate (PermissionPolicy.evaluate). */
  evaluate: (tool: string, input: Record<string, unknown>) => Promise<PermissionResult>;
}

/**
 * One backend instance per session, use-once (like Session itself).
 * start(): yields events until the session ends. Throws on crash; returns
 * cleanly on deliberate stop(). prompt() may be called as soon as start()
 * has been invoked (backends queue if not yet ready).
 */
export interface AgentBackend {
  start(opts: BackendStartOpts): AsyncIterable<AgentEvent>;
  prompt(text: string): void;
  /** Barge-in: end the in-flight turn, keep the session alive. */
  interrupt(): Promise<void>;
  stop(): Promise<void>;
}
