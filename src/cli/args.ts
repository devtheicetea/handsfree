import type { AgentName } from "../backends/types.js";

export interface CliArgs {
  projectPath: string;
  agent: AgentName;
  resume: "latest" | "new" | string;
  host: string;
  port: number;
  token: string | undefined;
}

export function parseArgs(argv: string[], cwd: string, env: NodeJS.ProcessEnv): CliArgs {
  let resume: CliArgs["resume"] = "latest";
  let agent: AgentName = "claude";
  let host = "127.0.0.1";
  let port = env.HANDSFREE_PORT ? Number(env.HANDSFREE_PORT) : 8744;
  let token = env.HANDSFREE_TOKEN;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--new") resume = "new";
    else if (a === "--codex") agent = "codex";
    else if (a === "--session") resume = argv[++i]!;
    else if (a === "--host") host = argv[++i]!;
    else if (a === "--port") port = Number(argv[++i]);
    else if (a === "--token") token = argv[++i]!;
  }
  return { projectPath: cwd, agent, resume, host, port, token };
}
