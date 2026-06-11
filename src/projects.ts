import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ProjectInfo } from "./protocol.js";
import { lastTurn, parseHistory, type HistoryItem } from "./sessionHistory.js";

export function defaultClaudeHome(): string {
  return join(homedir(), ".claude");
}

interface SessionFile {
  sessionId: string;
  file: string;
  mtimeMs: number;
}

function sessionFilesIn(dir: string): SessionFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const file = join(dir, f);
      return { sessionId: basename(f, ".jsonl"), file, mtimeMs: statSync(file).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function readSafe(file: string): string | null {
  try { return readFileSync(file, "utf8"); } catch { return null; }
}

function cwdFromText(text: string): string | null {
  // Claude session files start with metadata entries (last-prompt, mode,
  // permission-mode) that have no `cwd`; the cwd appears on later message lines.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as { cwd?: unknown };
      if (typeof obj.cwd === "string" && obj.cwd.length > 0) return obj.cwd;
    } catch { /* non-JSON line; keep scanning */ }
  }
  return null;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function previewFrom(text: string | null): HistoryItem | null {
  if (text === null) return null;
  const last = lastTurn(text);
  return last ? { role: last.role, text: truncate(last.text, 140), tools: last.tools } : null;
}

interface ScannedDir {
  sessions: SessionFile[];
  newest: SessionFile;
  newestText: string;
  cwd: string;
}

/** Read a project dir's newest session once; returns null if it has no readable session. */
function scanProjectDir(projectsRoot: string, entry: string): ScannedDir | null {
  const dir = join(projectsRoot, entry);
  if (!statSync(dir).isDirectory()) return null;
  const sessions = sessionFilesIn(dir);
  const newest = sessions[0];
  if (!newest) return null;
  const newestText = readSafe(newest.file);
  if (newestText === null) return null;
  return { sessions, newest, newestText, cwd: cwdFromText(newestText) || entry };
}

export function listProjects(claudeHome = defaultClaudeHome()): ProjectInfo[] {
  const projectsRoot = join(claudeHome, "projects");
  if (!existsSync(projectsRoot)) return [];
  const out: ProjectInfo[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const s = scanProjectDir(projectsRoot, entry);
    if (!s) continue;
    out.push({
      path: s.cwd,
      name: basename(s.cwd),
      lastSessionId: s.newest.sessionId,
      lastActive: s.newest.mtimeMs,
      lastMessage: previewFrom(s.newestText),
    });
  }
  return out.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
}

/**
 * Parse the last `limit` conversation turns for the session being resumed.
 * Returns [] for `resume === "new"`, an unknown project, or an unreadable file.
 */
export function historyForProject(
  claudeHome: string,
  projectPath: string,
  resume: string,
  limit: number,
): HistoryItem[] {
  if (resume === "new") return [];
  const projectsRoot = join(claudeHome, "projects");
  if (!existsSync(projectsRoot)) return [];
  for (const entry of readdirSync(projectsRoot)) {
    const s = scanProjectDir(projectsRoot, entry);
    if (!s) continue;
    if (s.cwd !== projectPath) continue;
    // Matched project. Use the resumed session's file when a specific id is given.
    let text = s.newestText;
    if (resume !== "latest") {
      const match = s.sessions.find((x) => x.sessionId === resume);
      if (match) text = readSafe(match.file) ?? s.newestText;
    }
    return parseHistory(text, limit);
  }
  return [];
}

export function resolveResume(
  claudeHome: string,
  projectPath: string,
  resume: "latest" | "new" | string,
): string | undefined {
  if (resume === "new") return undefined;
  if (resume === "latest") {
    const match = listProjects(claudeHome).find((p) => p.path === projectPath);
    return match?.lastSessionId ?? undefined;
  }
  return resume;
}
