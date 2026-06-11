import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexStore, parseCodexHistory } from "../src/stores/codex.js";

const meta = (id: string, cwd: string) =>
  JSON.stringify({ timestamp: "2026-06-11T10:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-06-11T10:00:00.000Z", cwd, originator: "codex_cli_rs", cli_version: "0.99.0" } });
const userMsg = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const assistantMsg = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
const fnCall = (name: string) =>
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "function_call", name, arguments: "{}", call_id: "c1" } });

const SAMPLE = [
  meta("thr_abc", "/Users/dev/proj"),
  userMsg("<environment_context>injected, not the user</environment_context>"),
  userMsg("add a test"),
  fnCall("shell"),
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "ok" } }),
  assistantMsg("Added the test."),
  JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "token_count" } }),
  userMsg("now run it"),
  assistantMsg("It passes."),
].join("\n") + "\n";

describe("parseCodexHistory", () => {
  it("extracts user/assistant turns, attaches tool names, skips injected context and noise", () => {
    expect(parseCodexHistory(SAMPLE, 25)).toEqual([
      { role: "user", text: "add a test", tools: [] },
      { role: "assistant", text: "Added the test.", tools: ["shell"] },
      { role: "user", text: "now run it", tools: [] },
      { role: "assistant", text: "It passes.", tools: [] },
    ]);
  });

  it("applies the limit from the end and survives garbage lines", () => {
    const noisy = "not json\n" + SAMPLE;
    expect(parseCodexHistory(noisy, 1)).toEqual([{ role: "assistant", text: "It passes.", tools: [] }]);
    expect(parseCodexHistory("", 5)).toEqual([]);
  });

  it("parses a REAL captured rollout file (canary for format drift)", () => {
    const text = readFileSync(new URL("./fixtures/codex/rollout-real.jsonl", import.meta.url), "utf8");
    const items = parseCodexHistory(text, 25);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.role === "assistant" && i.text.length > 0)).toBe(true);
    expect(items.every((i) => !i.text.startsWith("<environment_context>"))).toBe(true);
  });
});

describe("CodexStore", () => {
  let home: string;
  const dayDir = () => join(home, "sessions", "2026", "06", "11");
  const writeRollout = (name: string, content: string, mtime: Date) => {
    const f = join(dayDir(), name);
    writeFileSync(f, content);
    utimesSync(f, mtime, mtime);
    return f;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "codex-home-"));
    mkdirSync(dayDir(), { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("lists one StoreProject per cwd with the newest thread and a truncated preview", () => {
    writeRollout("rollout-2026-06-11T09-00-00-thr_old.jsonl",
      [meta("thr_old", "/Users/dev/proj"), userMsg("old"), assistantMsg("old answer")].join("\n"), new Date("2026-06-11T09:00:00Z"));
    writeRollout("rollout-2026-06-11T10-00-00-thr_abc.jsonl", SAMPLE, new Date("2026-06-11T10:00:00Z"));
    writeRollout("rollout-2026-06-11T10-30-00-thr_other.jsonl",
      [meta("thr_other", "/Users/dev/other"), userMsg("hi"), assistantMsg("x".repeat(200))].join("\n"), new Date("2026-06-11T10:30:00Z"));

    const projects = new CodexStore(home).listProjects();
    expect(projects.map((p) => p.path)).toEqual(["/Users/dev/other", "/Users/dev/proj"]); // newest first
    const proj = projects.find((p) => p.path === "/Users/dev/proj")!;
    expect(proj.lastSessionId).toBe("thr_abc");
    expect(proj.lastMessage).toMatchObject({ role: "assistant", text: "It passes." });
    const other = projects.find((p) => p.path === "/Users/dev/other")!;
    expect(other.lastMessage!.text.length).toBeLessThanOrEqual(141); // 140 + ellipsis
  });

  it("skips unparseable files silently", () => {
    writeRollout("rollout-2026-06-11T10-00-00-bad.jsonl", "garbage, no meta\n", new Date());
    expect(new CodexStore(home).listProjects()).toEqual([]);
  });

  it("resolveResume: new -> undefined, latest -> newest thread for the path, id -> id", () => {
    writeRollout("rollout-2026-06-11T10-00-00-thr_abc.jsonl", SAMPLE, new Date("2026-06-11T10:00:00Z"));
    const store = new CodexStore(home);
    expect(store.resolveResume("/Users/dev/proj", "new")).toBeUndefined();
    expect(store.resolveResume("/Users/dev/proj", "latest")).toBe("thr_abc");
    expect(store.resolveResume("/Users/dev/proj", "thr_xyz")).toBe("thr_xyz");
    expect(store.resolveResume("/nope", "latest")).toBeUndefined();
  });

  it("history: by specific thread id, by latest, [] for new/unknown", () => {
    writeRollout("rollout-2026-06-11T10-00-00-thr_abc.jsonl", SAMPLE, new Date("2026-06-11T10:00:00Z"));
    const store = new CodexStore(home);
    expect(store.history("/Users/dev/proj", "latest", 25)).toHaveLength(4);
    expect(store.history("/Users/dev/proj", "thr_abc", 1)).toEqual([{ role: "assistant", text: "It passes.", tools: [] }]);
    expect(store.history("/Users/dev/proj", "new", 25)).toEqual([]);
    expect(store.history("/unknown", "latest", 25)).toEqual([]);
  });

  it("returns [] / empty when the codex home does not exist at all", () => {
    const store = new CodexStore(join(home, "missing"));
    expect(store.listProjects()).toEqual([]);
    expect(store.history("/x", "latest", 5)).toEqual([]);
  });
});
