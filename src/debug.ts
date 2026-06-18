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
  console.log(`${localTimestamp()} [hf:${event}] ${parts}`);
}

/** Local-timezone `YYYY-MM-DD HH:MM:SS` stamp prefixed to each debug line. */
function localTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Collapse whitespace and cap length, for logging message text without flooding. */
export function preview(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
