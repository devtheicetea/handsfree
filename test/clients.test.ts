import { describe, it, expect } from "vitest";
import { ClientRegistry } from "../src/clients.js";

// Minimal fake socket: identity only.
const sock = () => ({}) as any;

describe("ClientRegistry", () => {
  it("registers a client and returns no prior socket for a new id", () => {
    const r = new ClientRegistry();
    expect(r.register("a", sock())).toBeNull();
  });

  it("replaces the socket for the same clientId and returns the prior socket", () => {
    const r = new ClientRegistry();
    const s1 = sock(), s2 = sock();
    r.register("a", s1);
    r.subscribe(s1, "k1");
    const prior = r.register("a", s2);
    expect(prior).toBe(s1);
    expect(r.socketsForSession("k1")).toEqual([s2]);
  });

  it("fans out only to subscribers of a session", () => {
    const r = new ClientRegistry();
    const s1 = sock(), s2 = sock();
    r.register("a", s1); r.register("b", s2);
    r.subscribe(s1, "k1");
    expect(r.socketsForSession("k1")).toEqual([s1]);
    r.subscribe(s2, "k1");
    expect(new Set(r.socketsForSession("k1"))).toEqual(new Set([s1, s2]));
  });

  it("mirror subscription is single-slot (replaces) and clears", () => {
    const r = new ClientRegistry();
    const s1 = sock();
    r.register("a", s1);
    r.subscribeMirror(s1, "claude:sess1");
    expect(r.socketsForMirror("claude:sess1")).toEqual([s1]);
    r.subscribeMirror(s1, "claude:sess2");
    expect(r.socketsForMirror("claude:sess1")).toEqual([]);
    expect(r.socketsForMirror("claude:sess2")).toEqual([s1]);
    r.unsubscribeMirror(s1);
    expect(r.socketsForMirror("claude:sess2")).toEqual([]);
  });

  it("remove drops the client and all its subscriptions", () => {
    const r = new ClientRegistry();
    const s1 = sock();
    r.register("a", s1); r.subscribe(s1, "k1");
    r.remove(s1);
    expect(r.socketsForSession("k1")).toEqual([]);
    expect(r.get("a")).toBeUndefined();
  });
});
