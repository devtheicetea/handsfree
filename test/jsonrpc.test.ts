import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import { JsonRpcConnection, type Json } from "../src/backends/jsonrpc.js";

function lines(stream: PassThrough): Json[] {
  const out: Json[] = [];
  stream.on("data", (c) => {
    for (const l of String(c).split("\n")) if (l.trim()) out.push(JSON.parse(l));
  });
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("JsonRpcConnection", () => {
  it("correlates a request with its response by id (no jsonrpc header on the wire)", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const written = lines(output);
    const rpc = new JsonRpcConnection(input, output, {});
    const p = rpc.request("thread/start", { cwd: "/p" });
    await tick();
    expect(written[0]).toMatchObject({ id: 1, method: "thread/start", params: { cwd: "/p" } });
    expect(written[0]).not.toHaveProperty("jsonrpc");
    input.write(JSON.stringify({ id: 1, result: { thread: { id: "thr_1" } } }) + "\n");
    await expect(p).resolves.toEqual({ thread: { id: "thr_1" } });
  });

  it("rejects a request when the server answers with an error", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const rpc = new JsonRpcConnection(input, output, {});
    const p = rpc.request("thread/resume", { threadId: "nope" });
    input.write(JSON.stringify({ id: 1, error: { code: -1, message: "no such thread" } }) + "\n");
    await expect(p).rejects.toThrow("no such thread");
  });

  it("dispatches notifications and handles partial/multi-line chunks", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const seen: Array<[string, Json]> = [];
    new JsonRpcConnection(input, output, { onNotification: (m, p) => seen.push([m, p]) });
    const a = JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "he" } });
    const b = JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "y" } });
    input.write(a.slice(0, 10));                       // partial line buffered
    input.write(a.slice(10) + "\n" + b + "\n");        // completes a, then whole b
    await tick();
    expect(seen).toEqual([
      ["item/agentMessage/delta", { delta: "he" }],
      ["item/agentMessage/delta", { delta: "y" }],
    ]);
  });

  it("answers server->client requests via onRequest", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const written = lines(output);
    new JsonRpcConnection(input, output, {
      onRequest: async (method) => ({ decision: method.includes("commandExecution") ? "accept" : "decline" }),
    });
    input.write(JSON.stringify({ id: 7, method: "item/commandExecution/requestApproval", params: {} }) + "\n");
    await tick();
    expect(written[0]).toEqual({ id: 7, result: { decision: "accept" } });
  });

  it("replies with an error when onRequest rejects", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const written = lines(output);
    new JsonRpcConnection(input, output, { onRequest: async () => { throw new Error("boom"); } });
    input.write(JSON.stringify({ id: 3, method: "x/y", params: {} }) + "\n");
    await tick();
    expect(written[0]).toMatchObject({ id: 3, error: { message: expect.stringContaining("boom") } });
  });

  it("rejects all pending requests when the input stream ends", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const rpc = new JsonRpcConnection(input, output, {});
    const p = rpc.request("initialize", {});
    input.end();
    await expect(p).rejects.toThrow(/jsonrpc/);
    await expect(rpc.request("x", {})).rejects.toThrow(/closed/); // closed conn refuses new requests
  });

  it("logs and drops unknown-id responses and unparseable lines", async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const log = vi.fn();
    new JsonRpcConnection(input, output, {}, log);
    input.write(JSON.stringify({ id: 99, result: {} }) + "\n");
    input.write("not json\n");
    await tick();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
