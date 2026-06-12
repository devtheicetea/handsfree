import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "../src/session.js";
import { ClaudeBackend } from "../src/backends/claude.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { BridgeToClient } from "../src/protocol.js";

const run = process.env.HANDSFREE_E2E === "1" ? describe : describe.skip;

run("real Agent SDK text loop", () => {
  it("streams a response to a simple prompt", async () => {
    // Throwaway project dir so test sessions don't litter the repo's session list.
    const projectDir = mkdtempSync(join(tmpdir(), "claude-itest-"));
    const emitted: BridgeToClient[] = [];
    const policy = new PermissionPolicy(["Read", "Grep", "Glob", "LS"], () => {});
    policy.setMode("auto");
    const session = new Session(new ClaudeBackend());
    await session.start({
      projectPath: projectDir,
      resume: undefined,
      policy,
      emit: (m) => emitted.push(m),
    });
    session.prompt("Reply with exactly the word: pong");
    const start = Date.now();
    while (Date.now() - start < 60000) {
      if (emitted.some((m) => m.type === "response" && m.done)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await session.stop();
    rmSync(projectDir, { recursive: true, force: true });
    const texts = emitted.filter((m) => m.type === "response").map((m) => (m as { text: string }).text).join("");
    expect(texts.toLowerCase()).toContain("pong");
  }, 70000);
});
