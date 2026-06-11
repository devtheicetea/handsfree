import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionWatcher, type WatcherEvent } from "../src/watcher.js";

const codexMeta = (id: string, cwd: string) =>
  JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id, cwd, cli_version: "0.139.0" } }) + "\n";
const codexUser = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } }) + "\n";
const codexAssistant = (text: string) =>
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } }) + "\n";
const claudeUser = (cwd: string, text: string) =>
  JSON.stringify({ cwd, type: "user", message: { role: "user", content: text } }) + "\n";

/** Collects watcher events; wait() polls until a predicate holds (fs.watch is async). */
function collector() {
  const events: WatcherEvent[] = [];
  const onEvent = (e: WatcherEvent) => events.push(e);
  const wait = async (pred: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return pred();
  };
  return { events, onEvent, wait };
}

describe("SessionWatcher", () => {
  let codexHome: string;
  let claudeHome: string;
  let watcher: SessionWatcher | null = null;
  const codexDay = () => join(codexHome, "sessions", "2026", "06", "11");

  beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), "watch-codex-"));
    claudeHome = mkdtempSync(join(tmpdir(), "watch-claude-"));
    mkdirSync(codexDay(), { recursive: true });
    mkdirSync(join(claudeHome, "projects", "-p"), { recursive: true });
  });
  afterEach(() => {
    watcher?.stop();
    watcher = null;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  });

  function start(opts: { owns?: (agent: string, id: string) => boolean } = {}) {
    const c = collector();
    watcher = new SessionWatcher({
      claudeHome,
      codexHome,
      ownsSession: (opts.owns ?? (() => false)) as (agent: "claude" | "codex", id: string) => boolean,
      onEvent: c.onEvent,
      debounceMs: 50,
    });
    watcher.start();
    return c;
  }

  it("emits parsed items for codex appends, with session resolution and offsets (no re-emit of old content)", async () => {
    const f = join(codexDay(), "rollout-2026-06-11T10-00-00-thr_w1.jsonl");
    writeFileSync(f, codexMeta("thr_w1", "/Users/dev/proj") + codexUser("already there"));
    const c = start();
    await new Promise((r) => setTimeout(r, 200)); // baseline settles
    appendFileSync(f, codexAssistant("fresh reply"));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events).toHaveLength(1); // baseline content NOT emitted
    const e = c.events[0]!;
    expect(e).toMatchObject({ agent: "codex", projectPath: "/Users/dev/proj", sessionId: "thr_w1", owned: false });
    expect(e.items).toEqual([{ role: "assistant", text: "fresh reply", tools: [] }]);
    expect(e.lastActive).toBeGreaterThan(0);
  });

  it("emits for claude session file appends (cwd from line, sessionId from filename)", async () => {
    const f = join(claudeHome, "projects", "-p", "sid-w2.jsonl");
    writeFileSync(f, claudeUser("/p", "old"));
    const c = start();
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(f, claudeUser("/p", "new from laptop"));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events[0]).toMatchObject({ agent: "claude", projectPath: "/p", sessionId: "sid-w2" });
    expect(c.events[0]!.items).toEqual([{ role: "user", text: "new from laptop", tools: [] }]);
  });

  it("tags events for bridge-owned sessions", async () => {
    const f = join(codexDay(), "rollout-2026-06-11T10-00-00-thr_own.jsonl");
    writeFileSync(f, codexMeta("thr_own", "/p"));
    const c = start({ owns: (agent, id) => agent === "codex" && id === "thr_own" });
    await new Promise((r) => setTimeout(r, 200));
    appendFileSync(f, codexAssistant("my own output"));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events[0]!.owned).toBe(true);
  });

  it("handles a brand-new file appearing after start", async () => {
    const c = start();
    await new Promise((r) => setTimeout(r, 200));
    const f = join(codexDay(), "rollout-2026-06-11T11-00-00-thr_new.jsonl");
    writeFileSync(f, codexMeta("thr_new", "/p2") + codexUser("hello"));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events[0]).toMatchObject({ sessionId: "thr_new", projectPath: "/p2" });
    expect(c.events[0]!.items).toEqual([{ role: "user", text: "hello", tools: [] }]);
  });

  it("buffers partial lines until the newline arrives", async () => {
    const f = join(codexDay(), "rollout-2026-06-11T10-00-00-thr_p.jsonl");
    writeFileSync(f, codexMeta("thr_p", "/p"));
    const c = start();
    await new Promise((r) => setTimeout(r, 200));
    const line = codexUser("split across writes");
    appendFileSync(f, line.slice(0, 25)); // no newline yet
    await new Promise((r) => setTimeout(r, 300));
    expect(c.events).toHaveLength(0); // nothing parseable yet
    appendFileSync(f, line.slice(25));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events[0]!.items).toEqual([{ role: "user", text: "split across writes", tools: [] }]);
  });

  it("re-baselines on truncation without emitting", async () => {
    const f = join(codexDay(), "rollout-2026-06-11T10-00-00-thr_t.jsonl");
    writeFileSync(f, codexMeta("thr_t", "/p") + codexUser("a") + codexUser("b"));
    const c = start();
    await new Promise((r) => setTimeout(r, 200));
    // Compaction rewrites the file smaller but VALID (meta line intact):
    writeFileSync(f, codexMeta("thr_t", "/p"));
    await new Promise((r) => setTimeout(r, 300));
    expect(c.events).toHaveLength(0); // shrink re-baselines silently
    appendFileSync(f, codexAssistant("after rewrite"));
    expect(await c.wait(() => c.events.length >= 1)).toBe(true);
    expect(c.events[c.events.length - 1]!.items).toEqual([{ role: "assistant", text: "after rewrite", tools: [] }]);
  });

  it("skips unresolvable files silently", async () => {
    const c = start();
    await new Promise((r) => setTimeout(r, 200));
    const f = join(codexDay(), "rollout-2026-06-11T10-00-00-bad.jsonl");
    writeFileSync(f, "not json at all\n");
    appendFileSync(f, "still not json\n");
    await new Promise((r) => setTimeout(r, 400));
    expect(c.events).toHaveLength(0);
  });
});
