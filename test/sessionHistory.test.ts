import { describe, it, expect } from "vitest";
import { parseHistory, lastTurn, lastTurnMs } from "../src/sessionHistory.js";

const line = (o: unknown) => JSON.stringify(o);

describe("parseHistory", () => {
  it("keeps user text and assistant text, skipping metadata and thinking", () => {
    const jsonl = [
      line({ type: "last-prompt", value: "hi" }),
      line({ type: "mode", value: "x" }),
      line({ type: "user", message: { role: "user", content: "what is 2+2?" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "It is 4." }] } }),
    ].join("\n");
    const items = parseHistory(jsonl, 25);
    expect(items).toEqual([
      { role: "user", text: "what is 2+2?", tools: [] },
      { role: "assistant", text: "It is 4.", tools: [] },
    ]);
  });

  it("groups an assistant turn's text + tool_use, skipping tool_result user entries", () => {
    const jsonl = [
      line({ type: "user", message: { role: "user", content: [{ type: "text", text: "edit the file" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "On it." }, { type: "tool_use", name: "Edit", input: {} }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "done" }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    ].join("\n");
    const items = parseHistory(jsonl, 25);
    expect(items).toEqual([
      { role: "user", text: "edit the file", tools: [] },
      { role: "assistant", text: "On it.\nDone.", tools: ["Edit", "Bash"] },
    ]);
  });

  it("caps to the last `limit` turns", () => {
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(line({ type: "user", message: { role: "user", content: `q${i}` } }));
      lines.push(line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: `a${i}` }] } }));
    }
    const items = parseHistory(lines.join("\n"), 3);
    expect(items).toHaveLength(3);
    expect(items[items.length - 1]).toEqual({ role: "assistant", text: "a9", tools: [] });
  });

  it("returns [] on empty or garbage input", () => {
    expect(parseHistory("", 25)).toEqual([]);
    expect(parseHistory("not json\n{bad", 25)).toEqual([]);
  });

  it("treats a user message with mixed text+tool_result blocks as a real message, extracting text", () => {
    const jsonl = line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "here" }, { type: "tool_result", content: "x" }],
      },
    });
    expect(parseHistory(jsonl, 25)).toEqual([{ role: "user", text: "here", tools: [] }]);
  });

  it("skips harness-injected task notifications / system reminders by content, regardless of promptSource", () => {
    const jsonl = [
      line({ type: "user", promptSource: "sdk", message: { role: "user", content: "real question" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn one" }] } }),
      // promptSource:"sdk" — identical to a real prompt; only the wrapper tag tells them apart.
      line({ type: "user", promptSource: "sdk", message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "turn two" }] } }),
      // also the promptSource:"system" variant and a system reminder
      line({ type: "user", promptSource: "system", message: { role: "user", content: "<task-notification>x</task-notification>" } }),
      line({ type: "user", promptSource: "sdk", message: { role: "user", content: "  <system-reminder>be brief</system-reminder>" } }),
    ].join("\n");
    expect(parseHistory(jsonl, 25)).toEqual([
      { role: "user", text: "real question", tools: [] },
      { role: "assistant", text: "turn one", tools: [] },
      { role: "assistant", text: "turn two", tools: [] },   // two stays its own bubble (flush kept them separate)
    ]);
  });

  it("renders a slash-command invocation as '/x' and drops the local-command caveat", () => {
    const jsonl = [
      line({ type: "user", message: { role: "user", content: "before" } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      // the caveat block Claude Code injects before a local command — model instruction, dropped
      line({ type: "user", message: { role: "user", content: "<local-command-caveat>Caveat: …DO NOT respond…</local-command-caveat>" } }),
      // the command invocation itself — shown tidily as "/voice", not raw XML
      line({ type: "user", message: { role: "user", content: "<command-name>/voice</command-name>\n  <command-message>voice</command-message>\n  <command-args></command-args>" } }),
    ].join("\n");
    expect(parseHistory(jsonl, 25)).toEqual([
      { role: "user", text: "before", tools: [] },
      { role: "assistant", text: "ok", tools: [] },
      { role: "user", text: "/voice", tools: [] },
    ]);
  });

  it("does NOT rewrite an assistant turn that merely mentions <command-name> in prose", () => {
    const jsonl = [
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The <command-name>/voice</command-name> markup leaks." }] } }),
    ].join("\n");
    expect(parseHistory(jsonl, 25)).toEqual([
      { role: "assistant", text: "The <command-name>/voice</command-name> markup leaks.", tools: [] },
    ]);
  });

  it("counts image attachment blocks (text + image)", () => {
    const jsonl = line({
      type: "user",
      message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } },
        { type: "text", text: "look at this" },
      ] },
    });
    expect(parseHistory(jsonl, 25)).toEqual([{ role: "user", text: "look at this", tools: [], images: 1 }]);
  });

  it("keeps an image-only user turn (no text) instead of skipping it", () => {
    const jsonl = line({
      type: "user",
      message: { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC" } },
      ] },
    });
    expect(parseHistory(jsonl, 25)).toEqual([{ role: "user", text: "", tools: [], images: 2 }]);
  });

  it("omits the images field when there are none", () => {
    const jsonl = line({ type: "user", message: { role: "user", content: "just text" } });
    expect(parseHistory(jsonl, 25)).toEqual([{ role: "user", text: "just text", tools: [] }]);
  });

  it("lastTurn returns the final item or null", () => {
    const jsonl = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } });
    expect(lastTurn(jsonl)).toEqual({ role: "assistant", text: "", tools: ["Read"] });
    expect(lastTurn("")).toBeNull();
  });
});

describe("lastTurnMs", () => {
  const T1 = "2026-06-29T10:00:00.000Z";
  const T2 = "2026-06-29T10:05:00.000Z";

  it("returns the most recent real turn's timestamp", () => {
    const jsonl = [
      line({ type: "user", timestamp: T1, message: { role: "user", content: "hi" } }),
      line({ type: "assistant", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "yo" }] } }),
    ].join("\n");
    expect(lastTurnMs(jsonl)).toBe(Date.parse(T2));
  });

  it("ignores trailing metadata records that have no timestamp (the mtime bug)", () => {
    const jsonl = [
      line({ type: "user", timestamp: T1, message: { role: "user", content: "hi" } }),
      line({ type: "assistant", timestamp: T2, message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
      // Written on reattach / title-gen hours later — no timestamp, bumps mtime only.
      line({ type: "ai-title", aiTitle: "Paywall" }),
      line({ type: "mode", mode: "safelist" }),
      line({ type: "permission-mode" }),
      line({ type: "file-history-snapshot" }),
    ].join("\n");
    expect(lastTurnMs(jsonl)).toBe(Date.parse(T2));
  });

  it("returns null when there is no timestamped turn (caller falls back to mtime)", () => {
    expect(lastTurnMs("")).toBeNull();
    expect(lastTurnMs(line({ type: "mode", mode: "safelist" }))).toBeNull();
    // user/assistant without a timestamp -> null (don't invent a time)
    expect(lastTurnMs(line({ type: "assistant", message: { role: "assistant", content: [] } }))).toBeNull();
  });
});
