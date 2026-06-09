import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { ProjectInfo } from "./protocol.js";

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

function cwdFromSessionFile(file: string): string | null {
  try {
    const firstLine = readFileSync(file, "utf8").split("\n").find((l) => l.trim().length > 0);
    if (!firstLine) return null;
    const obj = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof obj.cwd === "string" ? obj.cwd : null;
  } catch {
    return null;
  }
}

export function listProjects(claudeHome = defaultClaudeHome()): ProjectInfo[] {
  const projectsRoot = join(claudeHome, "projects");
  if (!existsSync(projectsRoot)) return [];
  const out: ProjectInfo[] = [];
  for (const entry of readdirSync(projectsRoot)) {
    const dir = join(projectsRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const sessions = sessionFilesIn(dir);
    const newest = sessions[0];
    if (!newest) continue;
    const cwd = cwdFromSessionFile(newest.file) ?? entry;
    out.push({
      path: cwd,
      name: basename(cwd),
      lastSessionId: newest.sessionId,
      lastActive: newest.mtimeMs,
    });
  }
  return out.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
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
