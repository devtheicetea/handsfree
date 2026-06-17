/**
 * Lightweight stdout debug logging for the live message flow. Every line carries the
 * session FOLDER (project path) and SESSION ID so you can follow one session across
 * prompts, agent output, permissions, and broadcasts in the Node terminal.
 * On by default; set HANDSFREE_DEBUG=0 to silence.
 */
export function debugLog(event: string, fields: Record<string, unknown>): void {
  if (process.env.HANDSFREE_DEBUG === "0") return;
  const parts = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.log(`[hf:${event}] ${parts}`);
}

/** Collapse whitespace and cap length, for logging message text without flooding. */
export function preview(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
