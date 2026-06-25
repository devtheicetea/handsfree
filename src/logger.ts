import { appendFileSync } from "node:fs";

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  close(): void;
}

export interface LoggerOptions {
  /** If set, every formatted JSON line is also passed here (e.g. console.log in
   *  debug mode) so logs surface in the bridge's terminal, not just the file. */
  echo?: (line: string) => void;
}

export function createLogger(filePath: string, opts: LoggerOptions = {}): Logger {
  const write = (level: string, msg: string, extra?: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
    appendFileSync(filePath, line + "\n");
    opts.echo?.(line);
  };
  return {
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
    close: () => {},
  };
}
