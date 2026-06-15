import type { Theme } from "./theme.js";

/**
 * Streaming, line-oriented Markdown styling for the terminal. We render at line
 * granularity (not token) so it stays a pure forward write — no cursor rewinds,
 * no wrapping math — which is robust while the reply streams in. Block elements
 * (headings, lists, quotes, fenced code, rules) are detected per line; inline
 * emphasis (**bold**, *italic*, `code`) is applied once the line is complete.
 */
export interface MarkdownStream {
  write(chunk: string): void;
  flush(): void;
}

/** Style one complete line given the current fenced-code state. Pure + tested. */
export function styleLine(line: string, t: Theme, inFence: boolean): { out: string; inFence: boolean } {
  const fence = line.match(/^\s*```(.*)$/);
  if (fence) {
    const lang = fence[1]!.trim();
    return inFence
      ? { out: t.dim("  └─"), inFence: false }
      : { out: t.dim(`  ┌─ ${lang || "code"}`), inFence: true };
  }
  if (inFence) return { out: t.gray("  │ " + line), inFence: true };

  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) return { out: t.bold(t.cyan(heading[2]!)), inFence: false };

  if (/^\s*([-*_])\1\1+\s*$/.test(line)) return { out: t.dim("─".repeat(40)), inFence: false };

  const quote = line.match(/^\s*>\s?(.*)$/);
  if (quote) return { out: t.dim("▏ " + inline(quote[1]!, t)), inFence: false };

  const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bullet) return { out: bullet[1]! + t.cyan("•") + " " + inline(bullet[2]!, t), inFence: false };

  const numbered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (numbered) return { out: numbered[1]! + t.cyan(numbered[2]! + ".") + " " + inline(numbered[3]!, t), inFence: false };

  return { out: inline(line, t), inFence: false };
}

/** Inline emphasis on a finished line. Code first so its content isn't re-styled. */
export function inline(s: string, t: Theme): string {
  s = s.replace(/`([^`]+)`/g, (_m, c) => t.yellow(c));
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, c) => t.bold(c));
  s = s.replace(/__([^_]+)__/g, (_m, c) => t.bold(c));
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, (_m, p, c) => p + t.italic(c));
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, (_m, p, c) => p + t.italic(c));
  return s;
}

export function makeMarkdownStream(out: { write(s: string): void }, t: Theme): MarkdownStream {
  let buf = "";
  let inFence = false;
  const emit = (line: string) => {
    const r = styleLine(line, t, inFence);
    inFence = r.inFence;
    out.write(r.out + "\n");
  };
  return {
    write(chunk: string) {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) !== -1) {
        emit(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    },
    flush() {
      if (buf.length) { emit(buf); buf = ""; }
      inFence = false;
    },
  };
}
