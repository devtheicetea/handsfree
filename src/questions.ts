import { randomUUID } from "node:crypto";

/** One selectable choice for a question. */
export interface QuestionOption { label: string; description?: string; preview?: string; }

/** A single decision question with 2-4 options (mirrors the CLI's AskUserQuestion). */
export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

/** A pending ask, surfaced to the client and awaiting the user's selection. */
export interface QuestionRequest { id: string; questions: Question[]; }

interface Pending { resolve: (selections: string[]) => void; questions: Question[]; }

/**
 * Per-session registry of in-flight `ask_user_question` calls. Parallels
 * PermissionPolicy: the SDK tool handler calls `ask()` and awaits; the client
 * answers via `resolve()`. `selections[i]` is the user's answer to `questions[i]`
 * (comma-joined for multi-select; freeform "Other" text passes through as-is).
 */
export class QuestionRegistry {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly onAsk: (req: QuestionRequest) => void,
              private readonly onResolved: (id: string) => void = () => {}) {}

  /** Surface a question and wait for the user's selection(s). */
  ask(questions: Question[]): Promise<string[]> {
    const id = randomUUID();
    const promise = new Promise<string[]>((resolve) => {
      this.pending.set(id, { resolve, questions });
    });
    this.onAsk({ id, questions });
    return promise;
  }

  /** Questions still awaiting an answer — replayed to a client on reattach. */
  pendingRequests(): QuestionRequest[] {
    return [...this.pending].map(([id, p]) => ({ id, questions: p.questions }));
  }

  resolve(id: string, selections: string[]): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    this.onResolved(id);
    p.resolve(selections);
  }

  /** Cancel every pending question (turn aborted) — resolve empty so the tool
   *  returns a "dismissed" result rather than hanging the turn forever. */
  abortAll(): void {
    const snapshot = [...this.pending];
    this.pending.clear();
    for (const [id, p] of snapshot) { p.resolve([]); this.onResolved(id); }
  }
}

/** Render the user's selections into the tool-result text the model reads back. */
export function formatAnswers(questions: Question[], selections: string[]): string {
  if (selections.length === 0 || selections.every((s) => !s.trim())) {
    return "The user dismissed the question without selecting an answer. Continue using your best judgment, or ask again in plain text.";
  }
  return questions
    .map((q, i) => `Q: ${q.question}\nA: ${selections[i]?.trim() || "(no answer)"}`)
    .join("\n\n");
}
