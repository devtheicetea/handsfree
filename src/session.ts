import type { AgentBackend, ImageAttachment } from "./backends/types.js";
import type { PermissionPolicy } from "./permissions.js";
import type { Question } from "./questions.js";
import type { BridgeToClient } from "./protocol.js";
import { debugLog, preview } from "./debug.js";

export interface StartParams {
  projectPath: string;
  resume: string | undefined;
  policy: PermissionPolicy;
  /** Surface a multiple-choice question to the client; resolves with selections. */
  askUser?: (questions: Question[]) => Promise<string[]>;
  /** Fired once the backend's real session id is learned (for mode persistence). */
  onSessionId?: (id: string) => void;
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
  private busy = false;
  private pendingPrompts: { text: string; attachments?: ImageAttachment[] }[] = [];
  /** Background tasks launched this session that haven't settled yet (taskId ->
   *  human-readable description). A turn can finish while one of these is still
   *  running; tracked so a future status-logic change can report "still working"
   *  instead of flipping to idle the moment the turn ends. NOT yet wired into the
   *  emitted status (deferred — see backlog #12). */
  private readonly pendingTasks = new Map<string, string>();

  constructor(backend: AgentBackend) {
    this.backend = backend;
  }

  /** Single emit path: tracks status + buffers the in-flight turn for replay. */
  private send(msg: BridgeToClient): void {
    if (msg.type === "status") this.currentStatus = msg.state;
    if (msg.type === "response" && !msg.done && msg.text) this.turnBuffer.push(msg.text);
    const base = { folder: this.projectPath, session: this.sessionId ?? "" };
    if (msg.type === "response") debugLog("agent.response", { ...base, turn: msg.turn, done: msg.done, text: preview(msg.text) });
    else if (msg.type === "status") debugLog("agent.status", { ...base, state: msg.state });
    else if (msg.type === "error") debugLog("agent.error", { ...base, code: msg.code });
    this.emit?.(msg);
  }

  async start(params: StartParams): Promise<void> {
    if (this.loop) throw new Error("session already started; call stop() first");
    const { projectPath, resume, policy, askUser, onSessionId, emit } = params;
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
          askUser,
        });
        for await (const ev of events) {
          if (ev.kind === "session_id") {
            this.sessionId = ev.id;
            onSessionId?.(ev.id);
          } else if (ev.kind === "text_delta") {
            this.send({ type: "response", turn: this.turnNo, text: ev.text, done: false } as any);
          } else if (ev.kind === "turn_done") {
            this.send({ type: "response", turn: this.turnNo, text: "", done: true } as any);
            this.send({ type: "status", state: "idle" } as any);
            this.dequeueNext();
          } else if (ev.kind === "turn_failed") {
            // The turn errored (auth/quota/etc.) but the session stays alive.
            this.send({ type: "error", code: "turn_failed", message: ev.message } as any);
            this.send({ type: "response", turn: this.turnNo, text: "", done: true } as any);
            this.send({ type: "status", state: "idle" } as any);
            this.dequeueNext();
          } else if (ev.kind === "task_started") {
            this.pendingTasks.set(ev.taskId, ev.description);
            debugLog("task.started", { folder: this.projectPath, session: this.sessionId ?? "", taskId: ev.taskId, desc: ev.description, pending: this.pendingTasks.size });
          } else if (ev.kind === "task_settled") {
            this.pendingTasks.delete(ev.taskId);
            debugLog("task.settled", { folder: this.projectPath, session: this.sessionId ?? "", taskId: ev.taskId, status: ev.status, pending: this.pendingTasks.size });
          }
        }
      } catch (err) {
        // Backends end cleanly on deliberate stop; a throw here is a real crash.
        this.send({ type: "status", state: "error" } as any);
        this.send({ type: "error", code: "session_crashed", message: String(err) });
      } finally {
        this.active = false;
        this.busy = false;
        this.pendingPrompts = [];
      }
    })();

  }

  prompt(text: string, attachments?: ImageAttachment[]): void {
    if (!this.emit) throw new Error("session not started");
    if (this.busy) { this.pendingPrompts.push({ text, attachments }); return; }
    this.runPrompt(text, attachments);
  }

  private runPrompt(text: string, attachments?: ImageAttachment[]): void {
    this.busy = true;
    this.turnNo += 1;
    this.turnBuffer = [];
    this.send({ type: "status", state: "thinking" } as any);
    this.backend.prompt(text, attachments);
  }

  private dequeueNext(): void {
    this.busy = false;
    const next = this.pendingPrompts.shift();
    // runPrompt resets turnBuffer at the start of a new turn, so a late
    // subscriber that calls replayTo will see the new (empty) buffer rather
    // than the finished turn replayed as if it were in-flight.
    if (next) this.runPrompt(next.text, next.attachments);
  }

  /** Current turn number (best-effort, for user_message ordering). */
  get currentTurn(): number { return this.turnNo; }

  /** True while the backend event loop is alive (between start() and stop()/crash). */
  isActive(): boolean {
    return this.active;
  }

  /** The project path this session is running in (for idempotent re-open). */
  get project(): string {
    return this.projectPath;
  }

  /** The backend's real session/thread id once learned (null before the first turn). */
  get backendSessionId(): string | null {
    return this.sessionId;
  }

  /** True while a turn is in flight (its partial reply is replayable via replayTo).
   *  When false, a reconnecting client should be caught up with a history snapshot. */
  get streaming(): boolean {
    return this.currentStatus === "thinking";
  }

  /** True while a background task launched this session is still running. The turn
   *  can finish (turn_done -> idle) before the task settles. NOT yet folded into the
   *  emitted status — the consumer for this is the deferred status-logic change
   *  (backlog #12): report "working" while (streaming || hasPendingTasks). */
  get hasPendingTasks(): boolean { return this.pendingTasks.size > 0; }
  get pendingTaskCount(): number { return this.pendingTasks.size; }

  /** Stop routing output to the client immediately (project switch). */
  detachEmit(): void {
    this.emit = () => {};
  }

  /** Replay the in-flight turn + current status to a one-off sink (a client that
   *  just subscribed). Does NOT change the live emit — the session keeps
   *  broadcasting to all subscribers via its original emit. */
  replayTo(emit: (msg: BridgeToClient) => void): void {
    if (this.currentStatus === "thinking") {
      for (const text of this.turnBuffer) emit({ type: "response", turn: this.turnNo, text, done: false } as any);
    }
    emit({ type: "status", state: this.currentStatus } as any);
  }

  /** Interrupt the in-flight turn (barge-in / stop) WITHOUT ending the session. */
  abortTurn(): void {
    void this.backend.interrupt().catch(() => {});
  }

  async stop(): Promise<void> {
    await this.backend.stop();
    if (this.loop) await this.loop.catch(() => {});
  }
}
