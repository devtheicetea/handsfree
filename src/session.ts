import type { AgentBackend } from "./backends/types.js";
import type { PermissionPolicy } from "./permissions.js";
import type { BridgeToClient } from "./protocol.js";

export interface StartParams {
  projectPath: string;
  resume: string | undefined;
  policy: PermissionPolicy;
  emit: (msg: BridgeToClient) => void;
}

/**
 * Backend-agnostic session shell. Owns the client-facing state machine (turn
 * numbering, reattach buffer, status) and drives one AgentBackend for its
 * lifetime. Use-once: after stop()/crash, create a new Session.
 */
export class Session {
  private readonly backend: AgentBackend;
  private loop: Promise<void> | null = null;
  private emit: ((msg: BridgeToClient) => void) | null = null;
  /** Real session id, learned from the backend's session_id event. */
  private sessionId: string | null = null;

  private active = false;
  private projectPath = "";
  private policy: PermissionPolicy | null = null;
  private currentStatus: "thinking" | "idle" | "error" = "idle";
  private turnBuffer: string[] = [];
  private turnNo = 0;

  constructor(backend: AgentBackend) {
    this.backend = backend;
  }

  /** Single emit path: tracks status + buffers the in-flight turn for reattach. */
  private send(msg: BridgeToClient): void {
    if (msg.type === "status") this.currentStatus = msg.state;
    if (msg.type === "response" && !msg.done && msg.text) this.turnBuffer.push(msg.text);
    this.emit?.(msg);
  }

  async start(params: StartParams): Promise<void> {
    if (this.loop) throw new Error("session already started; call stop() first");
    const { projectPath, resume, policy, emit } = params;
    this.emit = emit;
    this.projectPath = projectPath;
    this.policy = policy;
    this.active = true;
    this.turnBuffer = [];
    this.currentStatus = "idle";

    this.loop = (async () => {
      try {
        const events = this.backend.start({
          projectPath,
          resume,
          evaluate: (tool, input) => policy.evaluate(tool, input),
        });
        for await (const ev of events) {
          if (ev.kind === "session_id") {
            this.sessionId = ev.id;
          } else if (ev.kind === "text_delta") {
            this.send({ type: "response", turn: this.turnNo, text: ev.text, done: false } as any);
          } else if (ev.kind === "turn_done") {
            this.send({ type: "response", turn: this.turnNo, text: "", done: true } as any);
            this.send({ type: "status", state: "idle" } as any);
          } else if (ev.kind === "turn_failed") {
            // The turn errored (auth/quota/etc.) but the session stays alive.
            this.send({ type: "error", code: "turn_failed", message: ev.message } as any);
            this.send({ type: "response", turn: this.turnNo, text: "", done: true } as any);
            this.send({ type: "status", state: "idle" } as any);
          }
        }
      } catch (err) {
        // Backends end cleanly on deliberate stop; a throw here is a real crash.
        this.send({ type: "status", state: "error" } as any);
        this.send({ type: "error", code: "session_crashed", message: String(err) });
      } finally {
        this.active = false;
      }
    })();

  }

  prompt(text: string): void {
    if (!this.emit) throw new Error("session not started");
    this.turnNo += 1;
    this.turnBuffer = [];
    this.send({ type: "status", state: "thinking" } as any);
    this.backend.prompt(text);
  }

  /** True while the backend event loop is alive (between start() and stop()/crash). */
  isActive(): boolean {
    return this.active;
  }

  /** The project path this session is running in (for idempotent re-open). */
  get project(): string {
    return this.projectPath;
  }

  /** Stop routing output to the client immediately (project switch). */
  detachEmit(): void {
    this.emit = () => {};
  }

  /** Rebind the emit sink to a reconnected client and replay current state.
   *
   * NOTE: do NOT emit session_started here. The SessionManager is the sole
   * owner of session_started: it emits it on open (new session) and on
   * reattach-by-resumeId (returning client). On a reconnect, the app
   * re-opens its visible session to re-bind; background sessions keep
   * routing by their sessionKey-tagged response/status messages — so
   * reattach must not emit session_started.
   */
  reattach(emit: (msg: BridgeToClient) => void): void {
    this.emit = emit;
    for (const text of this.turnBuffer) emit({ type: "response", turn: this.turnNo, text, done: false } as any);
    emit({ type: "status", state: this.currentStatus } as any);
  }

  /** Interrupt the in-flight turn (barge-in) WITHOUT ending the session. */
  abortTurn(): void {
    void this.backend.interrupt().catch(() => {});
  }

  async stop(): Promise<void> {
    await this.backend.stop();
    if (this.loop) await this.loop.catch(() => {});
  }
}
