import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../src/logger.js";

const path = join(tmpdir(), `handsfree-log-${process.pid}.log`);
afterEach(() => { if (existsSync(path)) rmSync(path); });

describe("createLogger", () => {
  it("writes JSON lines to the given file", () => {
    const log = createLogger(path);
    log.info("hello", { a: 1 });
    log.close();
    const contents = readFileSync(path, "utf8").trim().split("\n");
    expect(contents).toHaveLength(1);
    const entry = JSON.parse(contents[0]!);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello");
    expect(entry.a).toBe(1);
    expect(typeof entry.ts).toBe("string");
  });
});
