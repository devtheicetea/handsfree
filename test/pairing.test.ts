import { describe, it, expect } from "vitest";
import { resolveHost, buildPairURL, type HostDeps } from "../src/pairing.js";
import { printPairing } from "../src/pairing.js";

const deps = (ts: string | null, lan: string | null): HostDeps => ({
  tailscaleIP: () => ts,
  lanIP: () => lan,
});

describe("resolveHost", () => {
  it("prefers HANDSFREE_HOST override", () => {
    expect(resolveHost({ HANDSFREE_HOST: "myhost" }, deps("100.1.2.3", "192.168.0.5"))).toBe("myhost");
  });
  it("falls back to tailscale, then LAN, then localhost", () => {
    expect(resolveHost({}, deps("100.1.2.3", "192.168.0.5"))).toBe("100.1.2.3");
    expect(resolveHost({}, deps(null, "192.168.0.5"))).toBe("192.168.0.5");
    expect(resolveHost({}, deps(null, null))).toBe("localhost");
  });
  it("ignores a blank override", () => {
    expect(resolveHost({ HANDSFREE_HOST: "  " }, deps("100.1.2.3", null))).toBe("100.1.2.3");
  });
});

describe("buildPairURL", () => {
  it("includes the token (encoded) when present", () => {
    expect(buildPairURL("100.1.2.3", 8744, "a b&c")).toBe(
      "handsfree://connect?host=100.1.2.3&port=8744&token=a%20b%26c");
  });
  it("omits the token when null or empty", () => {
    expect(buildPairURL("100.1.2.3", 8744, null)).toBe("handsfree://connect?host=100.1.2.3&port=8744");
    expect(buildPairURL("100.1.2.3", 8744, "")).toBe("handsfree://connect?host=100.1.2.3&port=8744");
  });
});

describe("printPairing", () => {
  it("emits the connect URL line, resolving the host from deps", () => {
    let out = "";
    const savedHost = process.env.HANDSFREE_HOST;
    delete process.env.HANDSFREE_HOST;
    printPairing(
      { port: 8744, token: null, bindAddress: "0.0.0.0", safelist: [] },
      { tailscaleIP: () => "100.9.8.7", lanIP: () => null },
      (s) => { out += s; },
    );
    if (savedHost !== undefined) process.env.HANDSFREE_HOST = savedHost;
    expect(out).toContain("handsfree://connect?host=100.9.8.7&port=8744");
  });
});
