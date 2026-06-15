import { describe, it, expect } from "vitest";
import { styleLine, inline, makeMarkdownStream } from "../../src/cli/markdown.js";
import { makeTheme } from "../../src/cli/theme.js";

const t = makeTheme(false);   // no color: assert structure, not ANSI

describe("styleLine", () => {
  it("renders headings as their text", () => {
    expect(styleLine("## Hello", t, false)).toEqual({ out: "Hello", inFence: false });
  });
  it("renders bullets and numbered lists with markers", () => {
    expect(styleLine("- item", t, false).out).toBe("• item");
    expect(styleLine("  * nested", t, false).out).toBe("  • nested");
    expect(styleLine("3. third", t, false).out).toBe("3. third");
  });
  it("renders a horizontal rule and blockquote", () => {
    expect(styleLine("---", t, false).out).toBe("─".repeat(40));
    expect(styleLine("> quoted", t, false).out).toBe("▏ quoted");
  });
  it("toggles fenced code state and passes code lines through verbatim", () => {
    const open = styleLine("```ts", t, false);
    expect(open.inFence).toBe(true);
    expect(open.out).toContain("ts");
    const body = styleLine("const x = 1", t, false);  // not in fence here (pure call)
    expect(body.out).toBe("const x = 1");
    const inside = styleLine("const x = 1", t, true);
    expect(inside).toEqual({ out: "  │ const x = 1", inFence: true });
    const close = styleLine("```", t, true);
    expect(close.inFence).toBe(false);
  });
});

describe("inline", () => {
  it("strips emphasis markers (text preserved with color off)", () => {
    expect(inline("a **bold** b", t)).toBe("a bold b");
    expect(inline("use `code` here", t)).toBe("use code here");
    expect(inline("an *italic* word", t)).toBe("an italic word");
  });
});

describe("makeMarkdownStream", () => {
  it("emits styled lines as newlines arrive and flushes the trailing partial", () => {
    const chunks: string[] = [];
    const md = makeMarkdownStream({ write: (s) => chunks.push(s) }, t);
    md.write("# Title\n- one");      // "- one" has no newline yet
    expect(chunks).toEqual(["Title\n"]);
    md.write("\n");                   // completes "- one"
    expect(chunks).toEqual(["Title\n", "• one\n"]);
    md.write("tail no newline");
    md.flush();
    expect(chunks[chunks.length - 1]).toBe("tail no newline\n");
  });

  it("keeps fenced code verbatim across writes", () => {
    const chunks: string[] = [];
    const md = makeMarkdownStream({ write: (s) => chunks.push(s) }, t);
    md.write("```\n**not bold**\n```\n");
    expect(chunks).toEqual(["  ┌─ code\n", "  │ **not bold**\n", "  └─\n"]);
  });
});
