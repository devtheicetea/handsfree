import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModeStore } from "../src/modeStore.js";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "hf-modes-")), "modes.json");

describe("ModeStore", () => {
  it("persists per agent+session and reloads from disk", () => {
    const path = tmpFile();
    const a = new ModeStore(path);
    expect(a.get("claude", "s1")).toBeUndefined();
    a.set("claude", "s1", "auto");
    a.set("codex", "s1", "ask_all");        // same id, different agent — distinct keys
    const b = new ModeStore(path);          // a fresh instance reads the file back
    expect(b.get("claude", "s1")).toBe("auto");
    expect(b.get("codex", "s1")).toBe("ask_all");
    expect(b.get("claude", "nope")).toBeUndefined();
  });

  it("creates the file/dir on first write when missing", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hf-modes-")), "nested", "modes.json");
    const s = new ModeStore(path);
    expect(s.get("claude", "x")).toBeUndefined();
    s.set("claude", "x", "auto");
    expect(new ModeStore(path).get("claude", "x")).toBe("auto");
  });
});
