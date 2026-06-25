export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  tools: string[];
}

// Claude session files interleave metadata and tool plumbing with the conversation.
// These top-level entry `type`s are not conversation and are skipped wholesale.
const SKIP_TYPES = new Set(["last-prompt", "mode", "permission-mode", "attachment", "file-history-snapshot"]);

// minimal shape — only the fields the parser reads
interface ContentBlock { type?: string; text?: string; name?: string }
interface RawEntry { type?: string; promptSource?: string; message?: { role?: string; content?: unknown } }

/** Extract a real user message's text, or null if the entry is a tool_result (not a typed message). */
function userText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content as ContentBlock[]) {
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
  let toolSet = new Set<string>();
  let open = false; // an assistant turn is being accumulated

  const flush = () => {
    if (!open) return;
    items.push({ role: "assistant", text: text.join("\n").trim(), tools: [...toolSet] });
    text = []; toolSet = new Set<string>(); open = false;
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
      // Harness-injected plumbing (task notifications, system reminders) is fed to
      // the model as a user turn — NOT something the person typed. It's tagged
      // promptSource "system" OR "sdk" inconsistently (the latter is identical to a
      // real prompt), so the reliable tell is the wrapper tag in the content: a real
      // prompt never starts with one. Skip so the raw XML never renders as a bubble.
      // flush() first so the two real turns it sits between stay separate.
      const head = ut.trimStart();
      if (o.promptSource === "system" || head.startsWith("<task-notification>") || head.startsWith("<system-reminder>")) {
        flush();
        continue;
      }
      flush();
      items.push({ role: "user", text: ut, tools: [] });
    } else if (t === "assistant") {
      open = true;
      const content = o.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as ContentBlock[]) {
          if (b?.type === "text" && typeof b.text === "string") text.push(b.text);
          else if (b?.type === "tool_use" && typeof b.name === "string") toolSet.add(b.name);
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
