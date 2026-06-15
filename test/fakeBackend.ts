import { Pushable } from "../src/pushable.js";
import type { AgentBackend, AgentEvent, BackendStartOpts } from "../src/backends/types.js";

/** Scripted backend: echoes each prompt as one delta + turn_done; records calls. */
export class FakeBackend implements AgentBackend {
  readonly events = new Pushable<AgentEvent>();
  prompts: string[] = [];
  interrupts = 0;
  startOpts: BackendStartOpts | null = null;
  crash: Error | null = null; // set before start() to simulate a crashing backend
  /** When set, the next prompt() emits a turn_failed with this message instead of echoing. */
  failNext: string | null = null;
  /** When true, prompt() emits a delta but NO turn_done — an in-flight, mid-stream turn. */
  streamOnly = false;

  /** Manually push a text_delta event (for tests that need fine-grained turn control). */
  emitTextDelta(text: string): void {
    this.events.push({ kind: "text_delta", text });
  }

  /** Manually push a turn_done event (for tests that need fine-grained turn control). */
  emitTurnDone(): void {
    this.events.push({ kind: "turn_done" });
  }

  async *start(opts: BackendStartOpts): AsyncGenerator<AgentEvent, void> {
    this.startOpts = opts;
    if (this.crash) throw this.crash;
    this.events.push({ kind: "session_id", id: "sess-9" });
    yield* this.events;
  }
  prompt(text: string): void {
    this.prompts.push(text);
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      this.events.push({ kind: "turn_failed", message });
      return;
    }
    this.events.push({ kind: "text_delta", text: `echo:${text}` });
    if (this.streamOnly) return;   // leave the turn in-flight (no turn_done)
    this.events.push({ kind: "turn_done" });
  }
  async interrupt(): Promise<void> { this.interrupts++; }
  async stop(): Promise<void> { this.events.end(); }
}
