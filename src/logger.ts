import { appendFileSync } from "node:fs";

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  close(): void;
}

export function createLogger(filePath: string): Logger {
  const write = (level: string, msg: string, extra?: Record<string, unknown>) => {
    appendFileSync(filePath, JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }) + "\n");
  };
  return {
    info: (m, e) => write("info", m, e),
    warn: (m, e) => write("warn", m, e),
    error: (m, e) => write("error", m, e),
    close: () => {},
  };
}
