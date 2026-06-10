import { Session } from "./session.js";
import { PermissionPolicy } from "./permissions.js";
import { resolveResume as defaultResolveResume, defaultClaudeHome } from "./projects.js";
import type { BridgeToClient, ClientMessage } from "./protocol.js";

interface ProjectSession {
  session: Session;
  policy: PermissionPolicy;
  resumeId: string | null;
}

export interface SessionManagerDeps {
  safelist: string[];
  makeSession?: () => Session;
  claudeHome?: string;
  resolveResume?: (claudeHome: string, projectPath: string, resume: string) => string | undefined;
}

/**
 * Owns one live Session per project. All sessions stay alive (none stopped on
 * switch); every session's output is tagged with its projectPath before reaching
 * the client. Input messages (prompt/abort/set_mode/permission_response) are
 * routed to the named project.
 */
export class SessionManager {
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly safelist: string[];
  private readonly makeSession: () => Session;
  private readonly claudeHome: string;
  private readonly resolveResume: (claudeHome: string, projectPath: string, resume: string) => string | undefined;

  constructor(deps: SessionManagerDeps) {
    this.safelist = deps.safelist;
    this.makeSession = deps.makeSession ?? (() => new Session());
    this.claudeHome = deps.claudeHome ?? defaultClaudeHome();
    this.resolveResume = deps.resolveResume ?? defaultResolveResume;
  }

  /** Wrap a session's emit so every message is tagged with its project. */
  private tagged(projectPath: string, emit: (m: BridgeToClient) => void) {
    return (m: BridgeToClient) => emit({ ...m, projectPath } as BridgeToClient);
  }

  async open(projectPath: string, resume: string, emit: (m: BridgeToClient) => void): Promise<void> {
    const existing = this.sessions.get(projectPath);
    if (existing && existing.session.isActive()) {
      existing.session.reattach(this.tagged(projectPath, emit));
      return;
    }
    const resumeId = this.resolveResume(this.claudeHome, projectPath, resume) ?? null;
    const policy = new PermissionPolicy(this.safelist, (req) =>
      this.tagged(projectPath, emit)({
        type: "permission_request",
        id: req.id, tool: req.tool, input: req.input,
        detail: req.input && typeof req.input === "object"
          ? `${req.tool} ${JSON.stringify(req.input).slice(0, 180)}` : req.tool,
      } as BridgeToClient),
    );
    const session = this.makeSession();
    this.sessions.set(projectPath, { session, policy, resumeId });
    await session.start({
      projectPath,
      resume: resumeId ?? undefined,
      policy,
      emit: this.tagged(projectPath, emit),
    });
  }

  /** Replay every live session's current state to a (re)connected client. */
  reattachAll(emit: (m: BridgeToClient) => void): void {
    for (const [projectPath, ps] of this.sessions) {
      if (ps.session.isActive()) ps.session.reattach(this.tagged(projectPath, emit));
    }
  }

  /** Route a per-project client message to its session/policy. Returns false if unknown. */
  route(msg: Extract<ClientMessage, { projectPath: string }>): boolean {
    const ps = this.sessions.get(msg.projectPath);
    if (!ps) return false;
    switch (msg.type) {
      case "prompt": ps.session.prompt(msg.text); return true;
      case "abort": ps.session.abortTurn(); ps.policy.abortAll(); return true;
      case "set_mode": ps.policy.setMode(msg.mode); return true;
      case "permission_response": ps.policy.resolve(msg.id, msg.decision); return true;
      default: return false;
    }
  }

  has(projectPath: string): boolean {
    return this.sessions.get(projectPath)?.session.isActive() ?? false;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((ps) => ps.session.stop()));
    this.sessions.clear();
  }
}
