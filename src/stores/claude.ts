import { listClaudeProjects, historyForProject, resolveResume, defaultClaudeHome, listSessionsFor, deleteClaudeSession } from "../projects.js";
import type { HistoryItem } from "../sessionHistory.js";
import type { SessionStore, SessionMeta, StoreProject } from "./types.js";

export class ClaudeStore implements SessionStore {
  constructor(private readonly claudeHome = defaultClaudeHome()) {}

  listProjects(): StoreProject[] {
    return listClaudeProjects(this.claudeHome);
  }

  listSessions(projectPath: string): SessionMeta[] {
    return listSessionsFor(this.claudeHome, projectPath);
  }

  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined {
    return resolveResume(this.claudeHome, projectPath, resume);
  }

  history(projectPath: string, resume: string, limit: number): { items: HistoryItem[]; hasMore: boolean } {
    return historyForProject(this.claudeHome, projectPath, resume, limit);
  }

  deleteSession(_projectPath: string, sessionId: string): boolean {
    return deleteClaudeSession(this.claudeHome, sessionId);
  }
}
