import type { HistoryItem } from "../sessionHistory.js";

/** Per-agent view of one project's most recent session. */
export interface StoreProject {
  path: string;
  lastSessionId: string | null;
  lastActive: number | null;
  lastMessage: HistoryItem | null;
  lastTitle: string | null;   // title of the latest session (AI-derived; custom rename applied later)
}

/** One discoverable session for a project (newest-first in listings). */
export interface SessionMeta {
  sessionId: string;        // the real on-disk session id (the resume target)
  lastActive: number;       // mtime ms
  title: string;            // ai-title -> first user prompt -> "Untitled"
  preview: HistoryItem | null;
}

/** Discovery / resume-resolution / history for one agent's on-disk sessions. */
export interface SessionStore {
  listProjects(): StoreProject[];
  listSessions(projectPath: string): SessionMeta[];
  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined;
  /** The last `limit` turns of a session, plus `hasMore` = whether older turns exist before
   *  that window (drives the client's "load earlier" pagination). */
  history(projectPath: string, resume: string, limit: number): { items: HistoryItem[]; hasMore: boolean };
  /** Permanently delete a session's on-disk file (by id). Returns true if removed. */
  deleteSession(projectPath: string, sessionId: string): boolean;
}

/** Shared preview shaping: previews are capped the same for every agent. */
export function truncatePreview(item: HistoryItem | null, max = 140): HistoryItem | null {
  if (!item) return null;
  return { ...item, text: item.text.length > max ? item.text.slice(0, max) + "…" : item.text };
}
