import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listProjects, resolveResume } from "../src/projects.js";

let claudeHome: string;

beforeEach(() => {
  claudeHome = mkdtempSync(join(tmpdir(), "claude-home-"));
  const projDir = join(claudeHome, "projects", "-Users-me-app");
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, "aaaa-1111.jsonl"),
    JSON.stringify({ cwd: "/Users/me/app", sessionId: "aaaa-1111" }) + "\n",
  );
  writeFileSync(
    join(projDir, "bbbb-2222.jsonl"),
    JSON.stringify({ cwd: "/Users/me/app", sessionId: "bbbb-2222" }) + "\n",
  );
});

afterEach(() => rmSync(claudeHome, { recursive: true, force: true }));

describe("listProjects", () => {
  it("returns one project with the newest session id and decoded path", () => {
    const projects = listProjects(claudeHome);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.path).toBe("/Users/me/app");
    expect(projects[0]!.name).toBe("app");
    expect(projects[0]!.lastSessionId).toBe("bbbb-2222");
    expect(projects[0]!.lastActive).toBeTypeOf("number");
  });
});

describe("resolveResume", () => {
  it("resolves 'latest' to the newest session id", () => {
    expect(resolveResume(claudeHome, "/Users/me/app", "latest")).toBe("bbbb-2222");
  });
  it("resolves 'new' to undefined", () => {
    expect(resolveResume(claudeHome, "/Users/me/app", "new")).toBeUndefined();
  });
  it("passes through an explicit id", () => {
    expect(resolveResume(claudeHome, "/Users/me/app", "aaaa-1111")).toBe("aaaa-1111");
  });
});
