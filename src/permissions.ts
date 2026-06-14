import { randomUUID } from "node:crypto";
import type { PermissionModeName } from "./protocol.js";

export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type AskRequest = { id: string; tool: string; input: unknown };
export type Decision = "allow" | "allow_session" | "deny";

interface Pending {
  resolve: (r: PermissionResult) => void;
  tool: string;
  input: unknown;
}

export class PermissionPolicy {
  private mode: PermissionModeName = "safelist";
  private readonly safelist: Set<string>;
  private readonly granted = new Set<string>();
  private readonly pending = new Map<string, Pending>();

  constructor(safelist: string[], private readonly onAsk: (req: AskRequest) => void) {
    this.safelist = new Set(safelist);
  }

  getMode(): PermissionModeName {
    return this.mode;
  }

  setMode(mode: PermissionModeName): void {
    this.mode = mode;
  }

  evaluate(tool: string, input: unknown): Promise<PermissionResult> {
    if (this.mode === "auto") return Promise.resolve({ behavior: "allow" });
    if (this.granted.has(tool)) return Promise.resolve({ behavior: "allow" });
    if (this.mode === "safelist" && this.safelist.has(tool)) {
      return Promise.resolve({ behavior: "allow" });
    }
    const id = randomUUID();
    const promise = new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { resolve, tool, input });
    });
    this.onAsk({ id, tool, input });
    return promise;
  }

  /** Requests still awaiting a decision — replayed to a client on reattach. */
  pendingRequests(): AskRequest[] {
    return [...this.pending].map(([id, p]) => ({ id, tool: p.tool, input: p.input }));
  }

  resolve(id: string, decision: Decision): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (decision === "deny") {
      p.resolve({ behavior: "deny", message: "Denied by user" });
      return;
    }
    if (decision === "allow_session") this.granted.add(p.tool);
    p.resolve({ behavior: "allow" });
  }

  abortAll(): void {
    for (const [, p] of this.pending) p.resolve({ behavior: "deny", message: "Aborted" });
    this.pending.clear();
  }
}
