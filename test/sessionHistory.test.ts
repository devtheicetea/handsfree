import { describe, it, expect } from "vitest";
import { parseHistory, lastTurn } from "../src/sessionHistory.js";

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

  it("lastTurn returns the final item or null", () => {
    const jsonl = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } });
    expect(lastTurn(jsonl)).toEqual({ role: "assistant", text: "", tools: ["Read"] });
    expect(lastTurn("")).toBeNull();
  });
});
