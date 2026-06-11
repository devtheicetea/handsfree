import { Pushable } from "../src/pushable.js";
import type { AgentBackend, AgentEvent, BackendStartOpts } from "../src/backends/types.js";

/** Scripted backend: echoes each prompt as one delta + turn_done; records calls. */
export class FakeBackend implements AgentBackend {
  readonly events = new Pushable<AgentEvent>();
  prompts: string[] = [];
  interrupts = 0;
  startOpts: BackendStartOpts | null = null;
  crash: Error | null = null; // set before start() to simulate a crashing backend

  async *start(opts: BackendStartOpts): AsyncGenerator<AgentEvent, void> {
    this.startOpts = opts;
    if (this.crash) throw this.crash;
    this.events.push({ kind: "session_id", id: "sess-9" });
    yield* this.events;
  }
  prompt(text: string): void {
    this.prompts.push(text);
    this.events.push({ kind: "text_delta", text: `echo:${text}` });
    this.events.push({ kind: "turn_done" });
  }
  async interrupt(): Promise<void> { this.interrupts++; }
  async stop(): Promise<void> { this.events.end(); }
}
