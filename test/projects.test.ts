import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listClaudeProjects, resolveResume, historyForProject } from "../src/projects.js";
import { ClaudeStore } from "../src/stores/claude.js";

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
  // Pin distinct mtimes so "newest first" is deterministic — on fast CI
  // filesystems both writes can land in the same coarse mtime tick otherwise.
  utimesSync(join(projDir, "aaaa-1111.jsonl"), new Date(1_000), new Date(1_000));
  utimesSync(join(projDir, "bbbb-2222.jsonl"), new Date(2_000), new Date(2_000));
});

afterEach(() => rmSync(claudeHome, { recursive: true, force: true }));

describe("listClaudeProjects", () => {
  it("returns one project with the newest session id and decoded path", () => {
    const projects = listClaudeProjects(claudeHome);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.path).toBe("/Users/me/app");
    expect(projects[0]!.lastSessionId).toBe("bbbb-2222");
    expect(projects[0]!.lastActive).toBeTypeOf("number");
  });
});

describe("listClaudeProjects with metadata-first session files", () => {
  it("finds cwd on a later line when the first lines are metadata", () => {
    // Real Claude session files start with metadata entries (last-prompt, mode,
    // permission-mode) that have no `cwd`; the cwd appears on later message lines.
    const home = mkdtempSync(join(tmpdir(), "claude-home2-"));
    const dir = join(home, "projects", "-Users-me-proj");
    mkdirSync(dir, { recursive: true });
    const lines =
      [
        JSON.stringify({ type: "last-prompt", value: "hi" }),
        JSON.stringify({ type: "mode" }),
        JSON.stringify({ type: "permission-mode" }),
        JSON.stringify({ type: "user", cwd: "/Users/me/proj", sessionId: "cccc" }),
      ].join("\n") + "\n";
    writeFileSync(join(dir, "cccc.jsonl"), lines);
    const projects = listClaudeProjects(home);
    expect(projects).toHaveLength(1);
    expect(projects[0]!.path).toBe("/Users/me/proj");
    rmSync(home, { recursive: true, force: true });
  });
});

describe("listClaudeProjects lastMessage preview", () => {
  it("attaches the truncated last turn as lastMessage", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-lm-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "hello there" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi back" }] } }),
    ].join("\n") + "\n");
    const projects = listClaudeProjects(home);
    expect(projects[0]!.lastMessage).toEqual({ role: "assistant", text: "hi back", tools: [] });
    rmSync(home, { recursive: true, force: true });
  });

  it("uses null lastMessage for an empty session file", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-empty-"));
    const dir = join(home, "projects", "-Users-me-x");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ cwd: "/Users/me/x", type: "mode", value: "x" }) + "\n");
    const projects = listClaudeProjects(home);
    expect(projects[0]!.lastMessage).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("historyForProject", () => {
  it("returns parsed turns for the matching project, [] for resume=new", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-h-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "ping" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "pong" }] } }),
    ].join("\n") + "\n");
    expect(historyForProject(home, "/Users/me/app", "latest", 25)).toEqual([
      { role: "user", text: "ping", tools: [] },
      { role: "assistant", text: "pong", tools: [] },
    ]);
    expect(historyForProject(home, "/Users/me/app", "new", 25)).toEqual([]);
    expect(historyForProject(home, "/Users/me/nope", "latest", 25)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("historyForProject specific-session-id branch", () => {
  it("returns the named session's turns, and falls back to newest for a missing id", () => {
    const home = mkdtempSync(join(tmpdir(), "claude-home-sid-"));
    const dir = join(home, "projects", "-Users-me-app");
    mkdirSync(dir, { recursive: true });
    // Write s1 first (older mtime), then s2 (newer mtime).
    writeFileSync(join(dir, "s1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "from-s1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply-s1" }] } }),
    ].join("\n") + "\n");
    writeFileSync(join(dir, "s2.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "from-s2" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "reply-s2" }] } }),
    ].join("\n") + "\n");
    // Pin distinct mtimes so the newest-session fallback is deterministic on
    // fast CI filesystems (both writes can otherwise share one mtime tick).
    utimesSync(join(dir, "s1.jsonl"), new Date(1_000), new Date(1_000));
    utimesSync(join(dir, "s2.jsonl"), new Date(2_000), new Date(2_000));

    // s2 was written last so it has a later mtime — it is the "newest" session.
    // Requesting s1 explicitly should return s1's turns, not s2's.
    expect(historyForProject(home, "/Users/me/app", "s1", 25)).toEqual([
      { role: "user", text: "from-s1", tools: [] },
      { role: "assistant", text: "reply-s1", tools: [] },
    ]);

    // A missing session id should fall back to the newest (s2).
    expect(historyForProject(home, "/Users/me/app", "missing-id", 25)).toEqual([
      { role: "user", text: "from-s2", tools: [] },
      { role: "assistant", text: "reply-s2", tools: [] },
    ]);

    rmSync(home, { recursive: true, force: true });
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

describe("ClaudeStore", () => {
  it("exposes the same projects as listClaudeProjects, as StoreProject", () => {
    const store = new ClaudeStore(claudeHome);
    const fromStore = store.listProjects();
    const direct = listClaudeProjects(claudeHome);
    expect(fromStore.map((p) => p.path)).toEqual(direct.map((p) => p.path));
    expect(fromStore[0]).not.toHaveProperty("name"); // StoreProject has no name
    expect(store.resolveResume(direct[0]!.path, "latest")).toBe(direct[0]!.lastSessionId);
  });

  it("history() returns the same items as historyForProject()", () => {
    // Build a separate temp claudeHome with conversation turns so history is non-trivial.
    const home2 = mkdtempSync(join(tmpdir(), "claude-store-h-"));
    const dir2 = join(home2, "projects", "-Users-me-app");
    mkdirSync(dir2, { recursive: true });
    writeFileSync(join(dir2, "sess1.jsonl"), [
      JSON.stringify({ cwd: "/Users/me/app", type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "world" }] } }),
    ].join("\n") + "\n");
    const store2 = new ClaudeStore(home2);
    const fromStore = store2.history("/Users/me/app", "latest", 25);
    const direct = historyForProject(home2, "/Users/me/app", "latest", 25);
    expect(fromStore).toEqual(direct);
    expect(fromStore).toEqual([
      { role: "user", text: "hello", tools: [] },
      { role: "assistant", text: "world", tools: [] },
    ]);
    rmSync(home2, { recursive: true, force: true });
  });
});
