export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
  tools: string[];
  /** Number of images the user attached to this turn. The image bytes are NOT shipped
   *  (they'd bloat the snapshot); the client renders this many placeholders so a
   *  laptop-attached image is at least visible as "an image was here". */
  images?: number;
}

// Claude session files interleave metadata and tool plumbing with the conversation.
// These top-level entry `type`s are not conversation and are skipped wholesale.
const SKIP_TYPES = new Set(["last-prompt", "mode", "permission-mode", "attachment", "file-history-snapshot"]);

// minimal shape — only the fields the parser reads
interface ContentBlock { type?: string; text?: string; name?: string }
interface RawEntry { type?: string; promptSource?: string; message?: { role?: string; content?: unknown } }

/** Count image attachment blocks in a message's content (Anthropic stores each attached
 *  image as a `{type:"image", source:{…}}` block alongside the text block). */
function countImages(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const b of content as ContentBlock[]) if (b?.type === "image") n++;
  return n;
}

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

/** Claude Code injects a slash-command invocation as a user-role turn:
 *  `<command-name>/voice</command-name><command-message>…</command-message><command-args>…</command-args>`.
 *  Convert it to a tidy "/voice" so the chat shows the command, not raw XML. Returns null when the
 *  turn isn't a command invocation. Anchored to the START of the text so an (assistant) turn that
 *  merely mentions "<command-name>" in prose is never rewritten. */
function slashCommandName(head: string): string | null {
  const m = head.match(/^<command-name>\s*([^<]+?)\s*<\/command-name>/);
  if (!m) return null;
  const name = m[1]!.trim().replace(/^\/+/, "");
  return name ? "/" + name : null;
}

/**
 * Parse ALL conversation turns from a Claude Code session `.jsonl`.
 * User turns are real typed messages; assistant turns coalesce consecutive
 * assistant entries' text plus the (deduped) names of any tools they used.
 */
function parseAll(jsonlText: string): HistoryItem[] {
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
      const content = o.message?.content;
      const ut = userText(content);
      const imgs = countImages(content);
      // tool_result with no text AND no image -> part of the assistant turn. A turn with
      // image block(s) is a real user attachment (even with no text), so don't skip it.
      if (ut === null && imgs === 0) continue;
      // Harness-injected plumbing (task notifications, system reminders) is fed to
      // the model as a user turn — NOT something the person typed. It's tagged
      // promptSource "system" OR "sdk" inconsistently (the latter is identical to a
      // real prompt), so the reliable tell is the wrapper tag in the content: a real
      // prompt never starts with one. Skip so the raw XML never renders as a bubble.
      // flush() first so the two real turns it sits between stay separate.
      const head = (ut ?? "").trimStart();
      // Model-only plumbing fed as a user turn — NEVER something the person typed. Skip so the
      // raw XML never renders as a bubble: task notifications, system reminders, and the
      // local-command caveat ("Caveat: …DO NOT respond…") that Claude Code injects before a
      // slash command runs. flush() first so the two real turns it sits between stay separate.
      if (o.promptSource === "system"
          || head.startsWith("<task-notification>")
          || head.startsWith("<system-reminder>")
          || head.startsWith("<local-command-caveat>")) {
        flush();
        continue;
      }
      flush();
      // A slash-command invocation (`<command-name>/voice</command-name>…`) shows as a tidy "/voice".
      const slash = slashCommandName(head);
      items.push({ role: "user", text: slash ?? (ut ?? ""), tools: [], ...(imgs > 0 ? { images: imgs } : {}) });
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
  return items;
}

/** The last `limit` conversation turns (the tail of the session). */
export function parseHistory(jsonlText: string, limit: number): HistoryItem[] {
  return parseAll(jsonlText).slice(-limit);
}

/**
 * The last `limit` turns PLUS whether older turns exist before this window — the signal
 * the client uses to offer "load earlier" pagination. Shipped to the client as an optional
 * `hasMore` field so pre-pagination clients simply ignore it (backward-compatible).
 */
export function parseHistoryWindow(jsonlText: string, limit: number): { items: HistoryItem[]; hasMore: boolean } {
  const all = parseAll(jsonlText);
  return { items: all.slice(-limit), hasMore: all.length > limit };
}

/** The most recent turn, or null for an empty/unparseable session. */
export function lastTurn(jsonlText: string): HistoryItem | null {
  const items = parseHistory(jsonlText, 1);
  return items.length ? items[items.length - 1]! : null;
}

/**
 * Wall-clock ms of the session's most recent *real* turn (a timestamped user or
 * assistant entry), or null if none is parseable.
 *
 * Why not the file mtime: the SDK appends metadata records — ai-title, mode,
 * permission-mode, last-prompt, file-history-snapshot — that carry NO `timestamp`
 * yet still bump the file's modified time. A reattach / title-generation can write
 * one hours after the last message, so mtime overstates recency ("15m ago" when the
 * last real turn was hours back). Reading the last timestamped turn fixes that.
 */
export function lastTurnMs(jsonlText: string): number | null {
  let best: number | null = null;
  for (const raw of jsonlText.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let o: { type?: string; timestamp?: unknown };
    try { o = JSON.parse(trimmed) as { type?: string; timestamp?: unknown }; } catch { continue; }
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (typeof o.timestamp !== "string") continue;
    const ms = Date.parse(o.timestamp);
    if (!Number.isNaN(ms) && (best === null || ms > best)) best = ms;
  }
  return best;
}
