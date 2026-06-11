import type { HistoryItem } from "../sessionHistory.js";

/** Per-agent view of one project's most recent session. */
export interface StoreProject {
  path: string;
  lastSessionId: string | null;
  lastActive: number | null;
  lastMessage: HistoryItem | null;
}

/** Discovery / resume-resolution / history for one agent's on-disk sessions. */
export interface SessionStore {
  listProjects(): StoreProject[];
  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined;
  history(projectPath: string, resume: string, limit: number): HistoryItem[];
}

/** Shared preview shaping: previews are capped the same for every agent. */
export function truncatePreview(item: HistoryItem | null, max = 140): HistoryItem | null {
  if (!item) return null;
  return { ...item, text: item.text.length > max ? item.text.slice(0, max) + "…" : item.text };
}
