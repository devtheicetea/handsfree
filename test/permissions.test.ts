import { describe, it, expect, vi } from "vitest";
import { PermissionPolicy } from "../src/permissions.js";

const safelist = ["Read", "Glob"];

describe("PermissionPolicy", () => {
  it("auto mode allows everything without asking", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    p.setMode("auto");
    const r = await p.evaluate("Bash", {});
    expect(r).toEqual({ behavior: "allow" });
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("safelist mode allows a safelisted tool without asking", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    const r = await p.evaluate("Read", {});
    expect(r).toEqual({ behavior: "allow" });
    expect(onAsk).not.toHaveBeenCalled();
  });

  it("safelist mode asks for a non-safelisted tool and resolves allow", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    const pending = p.evaluate("Bash", { command: "ls" });
    expect(onAsk).toHaveBeenCalledTimes(1);
    const askArg = onAsk.mock.calls[0]![0] as { id: string; tool: string };
    expect(askArg.tool).toBe("Bash");
    p.resolve(askArg.id, "allow");
    expect(await pending).toEqual({ behavior: "allow" });
  });

  it("pendingRequests lists unresolved asks (with input) and clears on resolve", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    void p.evaluate("Bash", { command: "ls" });
    const pending = p.pendingRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tool: "Bash", input: { command: "ls" } });
    p.resolve(pending[0]!.id, "allow");
    expect(p.pendingRequests()).toHaveLength(0);
  });

  it("deny resolves to a deny PermissionResult", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    const pending = p.evaluate("Bash", {});
    const id = (onAsk.mock.calls[0]![0] as { id: string }).id;
    p.resolve(id, "deny");
    const r = await pending;
    expect(r.behavior).toBe("deny");
  });

  it("allow_session auto-allows that tool on subsequent calls", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    const first = p.evaluate("Bash", {});
    p.resolve((onAsk.mock.calls[0]![0] as { id: string }).id, "allow_session");
    await first;
    const second = await p.evaluate("Bash", {});
    expect(second).toEqual({ behavior: "allow" });
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("ask_all mode asks even for safelisted tools", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    p.setMode("ask_all");
    p.evaluate("Read", {});
    expect(onAsk).toHaveBeenCalledTimes(1);
  });

  it("abortAll denies all pending requests", async () => {
    const onAsk = vi.fn();
    const p = new PermissionPolicy(safelist, onAsk);
    const pending = p.evaluate("Bash", {});
    p.abortAll();
    expect((await pending).behavior).toBe("deny");
  });

  it("notifies onResolved exactly once when a pending id is resolved, and not for unknown ids", () => {
    const resolved: string[] = [];
    const p = new PermissionPolicy([], () => {}, (id) => resolved.push(id));
    void p.evaluate("Bash", {});                   // creates one pending (mode safelist, Bash not safelisted)
    const id = p.pendingRequests()[0]!.id;
    p.resolve(id, "allow");
    p.resolve(id, "allow");                        // second is a no-op
    p.resolve("nonexistent", "deny");
    expect(resolved).toEqual([id]);
  });

  it("notifies onResolved for each pending id when aborted", () => {
    const resolved: string[] = [];
    const p = new PermissionPolicy([], () => {}, (id) => resolved.push(id));
    void p.evaluate("Bash", {});
    const id = p.pendingRequests()[0]!.id;
    p.abortAll();
    expect(resolved).toEqual([id]);
  });
});
