import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexBackend } from "../src/backends/codex.js";
import type { AgentEvent } from "../src/backends/types.js";

// Real end-to-end turn through `codex app-server`. Needs the devDependency CLI
// and a logged-in codex (`codex login`). Run with:
//   CODEX_INTEGRATION=1 npx vitest run test/integration.codex.test.ts
const enabled = process.env.CODEX_INTEGRATION === "1";

describe.skipIf(!enabled)("codex integration (real app-server)", () => {
  it("streams a real turn: session_id, deltas, turn_done", async () => {
    // Throwaway project dir: running in the repo cwd litters the repo's
    // session list with "pong" test sessions.
    const projectDir = mkdtempSync(join(tmpdir(), "codex-itest-"));
    const backend = new CodexBackend({ codexPath: resolve("node_modules/.bin/codex") });
    const kinds: string[] = [];
    let text = "";
    const run = (async () => {
      for await (const ev of backend.start({
        projectPath: projectDir,
        resume: undefined,
        evaluate: async () => ({ behavior: "deny", message: "no tools in this test" }),
      }) as AsyncIterable<AgentEvent>) {
        kinds.push(ev.kind);
        if (ev.kind === "text_delta") text += ev.text;
        if (ev.kind === "turn_done") break;
      }
    })();
    backend.prompt("Reply with exactly the single word: pong");
    await run;
    await backend.stop();
    rmSync(projectDir, { recursive: true, force: true });
    expect(kinds[0]).toBe("session_id");
    expect(kinds).toContain("text_delta");
    expect(kinds[kinds.length - 1]).toBe("turn_done");
    expect(text.toLowerCase()).toContain("pong");
  }, 120_000);
});
