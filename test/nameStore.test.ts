import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NameStore } from "../src/nameStore.js";

const tmpFile = () => join(mkdtempSync(join(tmpdir(), "hf-names-")), "session-names.json");

describe("NameStore", () => {
  it("persists per agent+session and reloads from disk (survives restart)", () => {
    const path = tmpFile();
    const a = new NameStore(path);
    expect(a.get("claude", "s1")).toBeUndefined();
    a.set("claude", "s1", "Refactor auth");
    a.set("codex", "s1", "Codex notes");      // same id, different agent — distinct keys
    const b = new NameStore(path);            // a fresh instance reads the file back
    expect(b.get("claude", "s1")).toBe("Refactor auth");
    expect(b.get("codex", "s1")).toBe("Codex notes");
    expect(b.get("claude", "nope")).toBeUndefined();
  });

  it("trims whitespace and clears the name on empty", () => {
    const path = tmpFile();
    const a = new NameStore(path);
    a.set("claude", "s1", "  spaced  ");
    expect(a.get("claude", "s1")).toBe("spaced");
    a.set("claude", "s1", "   ");             // empty/whitespace clears it
    expect(a.get("claude", "s1")).toBeUndefined();
    expect(new NameStore(path).get("claude", "s1")).toBeUndefined();
  });
});
