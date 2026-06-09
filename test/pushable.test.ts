import { describe, it, expect } from "vitest";
import { Pushable } from "../src/pushable.js";

describe("Pushable", () => {
  it("yields pushed values in order then ends", async () => {
    const p = new Pushable<number>();
    p.push(1);
    p.push(2);
    p.end();
    const got: number[] = [];
    for await (const v of p) got.push(v);
    expect(got).toEqual([1, 2]);
  });

  it("delivers a value pushed after iteration starts", async () => {
    const p = new Pushable<string>();
    const collected: string[] = [];
    const consumer = (async () => {
      for await (const v of p) collected.push(v);
    })();
    await new Promise((r) => setTimeout(r, 5));
    p.push("late");
    p.end();
    await consumer;
    expect(collected).toEqual(["late"]);
  });
});
