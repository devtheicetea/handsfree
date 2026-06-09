import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultClaudeHome } from "./projects.js";

/**
 * Best-effort wait for Claude to write `<sessionId>.jsonl` under one of the
 * project dirs. Claude typically writes it within ~1s; we poll every 100ms up
 * to a 5s margin. On timeout we return anyway (best-effort) rather than throw —
 * a slightly-slow or relocated session file should not kill an otherwise-good
 * session; resume correctness is a later concern.
 */
export async function awaitSessionFile(
  sessionId: string,
  claudeHome = defaultClaudeHome(),
  timeoutMs = 5000,
): Promise<void> {
  const projectsRoot = join(claudeHome, "projects");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(projectsRoot)) {
      for (const entry of readdirSync(projectsRoot)) {
        const dir = join(projectsRoot, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, `${sessionId}.jsonl`))) return;
      }
    }
    await new Promise((r) => setTimeout(r, 100)); // poll interval
  }
}
