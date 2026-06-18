import { describe, it, expect, vi } from "vitest";
import { QuestionRegistry, formatAnswers, type Question } from "../src/questions.js";

const q: Question[] = [
  { question: "Which database?", header: "DB", options: [
    { label: "Postgres", description: "Relational" },
    { label: "SQLite", description: "Embedded" },
  ] },
];

describe("QuestionRegistry", () => {
  it("ask surfaces a request and resolves with the user's selections", async () => {
    const onAsk = vi.fn();
    const reg = new QuestionRegistry(onAsk);
    const pending = reg.ask(q);
    expect(onAsk).toHaveBeenCalledTimes(1);
    const req = onAsk.mock.calls[0]![0] as { id: string; questions: Question[] };
    expect(req.questions).toEqual(q);
    reg.resolve(req.id, ["Postgres"]);
    expect(await pending).toEqual(["Postgres"]);
  });

  it("pendingRequests lists unanswered asks and clears on resolve", () => {
    const reg = new QuestionRegistry(() => {});
    void reg.ask(q);
    const pending = reg.pendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.questions).toEqual(q);
    reg.resolve(pending[0]!.id, ["SQLite"]);
    expect(reg.pendingRequests()).toHaveLength(0);
  });

  it("notifies onResolved exactly once, and not for unknown ids", () => {
    const resolved: string[] = [];
    const reg = new QuestionRegistry(() => {}, (id) => resolved.push(id));
    void reg.ask(q);
    const id = reg.pendingRequests()[0]!.id;
    reg.resolve(id, ["Postgres"]);
    reg.resolve(id, ["SQLite"]);     // no-op
    reg.resolve("nope", ["x"]);       // unknown
    expect(resolved).toEqual([id]);
  });

  it("abortAll resolves pending asks with empty selections", async () => {
    const resolved: string[] = [];
    const reg = new QuestionRegistry(() => {}, (id) => resolved.push(id));
    const pending = reg.ask(q);
    const id = reg.pendingRequests()[0]!.id;
    reg.abortAll();
    expect(await pending).toEqual([]);
    expect(resolved).toEqual([id]);
  });
});

describe("formatAnswers", () => {
  it("renders each question with its answer", () => {
    const text = formatAnswers(q, ["Postgres"]);
    expect(text).toContain("Q: Which database?");
    expect(text).toContain("A: Postgres");
  });

  it("pairs multiple questions to their selections in order", () => {
    const two: Question[] = [
      { question: "A?", options: [{ label: "a1" }, { label: "a2" }] },
      { question: "B?", options: [{ label: "b1" }, { label: "b2" }] },
    ];
    const text = formatAnswers(two, ["a2", "b1"]);
    expect(text).toBe("Q: A?\nA: a2\n\nQ: B?\nA: b1");
  });

  it("reports a dismissal when there are no selections", () => {
    expect(formatAnswers(q, [])).toMatch(/dismissed/i);
    expect(formatAnswers(q, ["  "])).toMatch(/dismissed/i);
  });
});
