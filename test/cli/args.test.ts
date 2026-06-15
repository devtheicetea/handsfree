import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli/args.js";

describe("parseArgs", () => {
  it("defaults to claude + resume latest in CWD", () => {
    const a = parseArgs([], "/proj", { HANDSFREE_PORT: "8744" });
    expect(a).toMatchObject({ projectPath: "/proj", agent: "claude", resume: "latest", host: "127.0.0.1", port: 8744 });
  });
  it("--new selects a fresh session, --codex selects codex", () => {
    const a = parseArgs(["--new", "--codex"], "/proj", {});
    expect(a.resume).toBe("new"); expect(a.agent).toBe("codex");
  });
  it("--session sets an explicit resume id", () => {
    expect(parseArgs(["--session", "abc"], "/p", {}).resume).toBe("abc");
  });
  it("flags override env for host/port/token", () => {
    const a = parseArgs(["--host", "h", "--port", "9000", "--token", "t"], "/p", { HANDSFREE_PORT: "8744", HANDSFREE_TOKEN: "env" });
    expect(a).toMatchObject({ host: "h", port: 9000, token: "t" });
  });
  it("reads token from env when no flag", () => {
    expect(parseArgs([], "/p", { HANDSFREE_TOKEN: "envtok" }).token).toBe("envtok");
  });
});
