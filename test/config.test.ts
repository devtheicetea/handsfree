import { describe, it, expect } from "vitest";
import { loadConfig, DEFAULT_SAFELIST } from "../src/config.js";

describe("loadConfig", () => {
  it("uses defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8744);
    expect(c.bindAddress).toBe("0.0.0.0");
    expect(c.token).toBeNull();
    expect(c.safelist).toEqual(DEFAULT_SAFELIST);
  });

  it("reads overrides from env", () => {
    const c = loadConfig({
      HANDSFREE_PORT: "9000",
      HANDSFREE_BIND: "100.64.0.1",
      HANDSFREE_TOKEN: "secret",
      HANDSFREE_SAFELIST: "Read,Glob",
    });
    expect(c.port).toBe(9000);
    expect(c.bindAddress).toBe("100.64.0.1");
    expect(c.token).toBe("secret");
    expect(c.safelist).toEqual(["Read", "Glob"]);
  });

  it("throws on a non-numeric port", () => {
    expect(() => loadConfig({ HANDSFREE_PORT: "abc" })).toThrow();
  });

  it("throws on an out-of-range port", () => {
    expect(() => loadConfig({ HANDSFREE_PORT: "70000" })).toThrow();
  });

  it("reads HANDSFREE_CODEX_PATH, defaulting to null (use PATH)", () => {
    expect(loadConfig({}).codexPath).toBeNull();
    expect(loadConfig({ HANDSFREE_CODEX_PATH: "/opt/codex" }).codexPath).toBe("/opt/codex");
  });

  it("safelists CodexApplyPatch by default so in-project codex patches auto-allow", () => {
    expect(loadConfig({}).safelist).toContain("CodexApplyPatch");
  });
});
