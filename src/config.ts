export const DEFAULT_SAFELIST = ["Read", "Grep", "Glob", "LS", "TodoWrite"] as const;

export interface Config {
  port: number;
  bindAddress: string;
  token: string | null;
  safelist: string[];
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
  };
}
