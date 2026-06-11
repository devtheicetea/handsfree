export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  tools: string[];
}

// Claude session files interleave metadata and tool plumbing with the conversation.
// These top-level entry `type`s are not conversation and are skipped wholesale.
const SKIP_TYPES = new Set(["last-prompt", "mode", "permission-mode", "attachment", "file-history-snapshot"]);

interface Block { type?: string; text?: string; name?: string }
interface RawEntry { type?: string; message?: { role?: string; content?: unknown } }

/** Extract a real user message's text, or null if the entry is a tool_result (not a typed message). */
function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content as Block[]) {
      if (b?.type === "text" && typeof b.text === "string") texts.push(b.text);
    }
    return texts.length ? texts.join("\n") : null; // tool_result-only -> null
  }
  return null;
}

/**
 * Parse a Claude Code session `.jsonl` into the last `limit` conversation turns.
 * User turns are real typed messages; assistant turns coalesce consecutive
 * assistant entries' text plus the (deduped) names of any tools they used.
 */
export function parseHistory(jsonlText: string, limit: number): HistoryItem[] {
  const items: HistoryItem[] = [];
  let text: string[] = [];
  let tools: string[] = [];
  let open = false; // an assistant turn is being accumulated

  const flush = () => {
    if (!open) return;
    items.push({ role: "assistant", text: text.join("\n").trim(), tools });
    text = []; tools = []; open = false;
  };

  for (const raw of jsonlText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let o: RawEntry;
    try { o = JSON.parse(trimmed) as RawEntry; } catch { continue; }
    const t = o.type;
    if (!t || SKIP_TYPES.has(t)) continue;

    if (t === "user") {
      const ut = userText(o.message?.content);
      if (ut === null) continue;        // tool_result -> part of the assistant turn
      flush();
      items.push({ role: "user", text: ut, tools: [] });
    } else if (t === "assistant") {
      open = true;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b?.type === "tool_use" && typeof b.name === "string" && !tools.includes(b.name)) tools.push(b.name);
          // thinking and other block types are ignored
        }
      }
    }
  }
  flush();
  return items.slice(-limit);
}

/** The most recent turn, or null for an empty/unparseable session. */
export function lastTurn(jsonlText: string): HistoryItem | null {
  const items = parseHistory(jsonlText, 1);
  return items.length ? items[items.length - 1]! : null;
}
