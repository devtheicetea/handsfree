/**
 * Tiny zero-dependency ANSI styling. Every style is a no-op when `enabled` is
 * false, so the same render code produces clean plain text for non-TTY output
 * (pipes, CI, NO_COLOR) and styled text for a real terminal.
 */
export interface Theme {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  italic(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  blue(s: string): string;
  cyan(s: string): string;
  magenta(s: string): string;
  gray(s: string): string;
}

export function makeTheme(enabled: boolean): Theme {
  const w = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
  return {
    enabled,
    bold: w(1, 22),
    dim: w(2, 22),
    italic: w(3, 23),
    red: w(31, 39),
    green: w(32, 39),
    yellow: w(33, 39),
    blue: w(34, 39),
    cyan: w(36, 39),
    magenta: w(35, 39),
    gray: w(90, 39),
  };
}

/** Color is on only for a real terminal that hasn't opted out via NO_COLOR / TERM=dumb. */
export function colorEnabled(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return stream.isTTY === true && env.NO_COLOR == null && env.TERM !== "dumb";
}

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Replace the user's $HOME prefix with ~ for a compact path in the status bar. */
export function tildify(path: string, home = process.env.HOME ?? ""): string {
  return home && path.startsWith(home) ? "~" + path.slice(home.length) : path;
}
