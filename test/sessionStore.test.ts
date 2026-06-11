import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { titleFrom, listSessionsFor } from "../src/projects.js";

const line = (o: unknown) => JSON.stringify(o);

describe("titleFrom", () => {
  it("prefers an ai-title entry", () => {
    const jsonl = [
      line({ type: "ai-title", value: "Fix the parser" }),
      line({ type: "user", message: { role: "user", content: "do the thing" } }),
    ].join("\n");
    expect(titleFrom(jsonl)).toBe("Fix the parser");
  });
  it("falls back to the first user prompt (truncated)", () => {
    const long = "x".repeat(100);
    const jsonl = line({ type: "user", message: { role: "user", content: long } });
    expect(titleFrom(jsonl)).toBe(long.slice(0, 60) + "…");
  });
  it("returns 'Untitled' when there is nothing", () => {
    expect(titleFrom(line({ type: "mode", value: "x" }))).toBe("Untitled");
  });
});

describe("listSessionsFor", () => {
  it("returns one SessionMeta per session file, newest first, titled + previewed", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-ls-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), [
      line({ cwd: "/Users/me/app", type: "ai-title", value: "First" }),
      line({ type: "user", message: { role: "user", content: "hi" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "s2.jsonl"), [
      line({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "second session prompt" } }),
    ].join("\n") + "\n");
    const sessions = listSessionsFor(home, "/Users/me/app");
    expect(sessions.map((s) => s.sessionId)).toEqual(["s2", "s1"]);
    const s1 = sessions.find((s) => s.sessionId === "s1")!;
    expect(s1.title).toBe("First");
    expect(s1.preview?.text).toBe("yo");
    const s2 = sessions.find((s) => s.sessionId === "s2")!;
    expect(s2.title).toBe("second session prompt");
    rmSync(home, { recursive: true, force: true });
  });
  it("returns [] for an unknown project", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-ls2-"));
    mkdirSync(join(home, "projects"), { recursive: true });
    expect(listSessionsFor(home, "/nope")).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});
