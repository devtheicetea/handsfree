import { listClaudeProjects, historyForProject, resolveResume, defaultClaudeHome } from "../projects.js";
import type { HistoryItem } from "../sessionHistory.js";
import type { SessionStore, StoreProject } from "./types.js";

export class ClaudeStore implements SessionStore {
  constructor(private readonly claudeHome = defaultClaudeHome()) {}

  listProjects(): StoreProject[] {
    return listClaudeProjects(this.claudeHome);
  }

  resolveResume(projectPath: string, resume: "latest" | "new" | string): string | undefined {
    return resolveResume(this.claudeHome, projectPath, resume);
  }

  history(projectPath: string, resume: string, limit: number): HistoryItem[] {
    return historyForProject(this.claudeHome, projectPath, resume, limit);
  }
}
