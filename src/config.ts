export const DEFAULT_SAFELIST = ["Read", "Grep", "Glob", "LS", "TodoWrite", "CodexApplyPatch"] as const;

export interface Config {
  port: number;
  bindAddress: string;
  token: string | null;
  safelist: string[];
  /** Path to the codex binary; null = resolve `codex` from PATH. */
  codexPath: string | null;
  /** Model for Claude sessions (e.g. "sonnet"/"opus" or a full id); null = SDK default. */
  model?: string | null;
  /** Run mode. "prod" (default) keeps the console quiet; "debug" turns on the
   *  verbose per-message debug logging. The master switch for debug behaviors. */
  env: "prod" | "debug";
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = env.HANDSFREE_PORT ? Number(env.HANDSFREE_PORT) : 8744;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid HANDSFREE_PORT: ${env.HANDSFREE_PORT}`);
  }
  const safelist = env.HANDSFREE_SAFELIST
    ? env.HANDSFREE_SAFELIST.split(",").map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_SAFELIST];
  return {
    port,
    bindAddress: env.HANDSFREE_BIND ?? "0.0.0.0",
    token: env.HANDSFREE_TOKEN ?? null,
    safelist,
    codexPath: env.HANDSFREE_CODEX_PATH?.trim() || null,
    model: env.HANDSFREE_MODEL?.trim() || null,
    env: env.HANDSFREE_ENV?.trim().toLowerCase() === "debug" ? "debug" : "prod",
  };
}
