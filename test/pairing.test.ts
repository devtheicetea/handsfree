import { describe, it, expect } from "vitest";
import { resolveHost, resolveHostInfo, reachabilityNote, buildPairURL, printPairing, type HostDeps } from "../src/pairing.js";

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
    printPairing(
      { port: 8744, token: null, bindAddress: "0.0.0.0", safelist: [], codexPath: null },
      { tailscaleIP: () => "100.9.8.7", lanIP: () => null },
      (s) => { out += s; },
      {}, // empty env -> no HANDSFREE_HOST override
    );
    expect(out).toContain("handsfree://connect?host=100.9.8.7&port=8744");
  });

  it("notes Tailscale reachability when the host is a Tailscale address", () => {
    let out = "";
    printPairing(
      { port: 8744, token: null, bindAddress: "0.0.0.0", safelist: [], codexPath: null },
      { tailscaleIP: () => "100.9.8.7", lanIP: () => "192.168.0.5" },
      (s) => { out += s; },
      {},
    );
    expect(out).toContain("over Tailscale");
    expect(out).toContain("works remotely");
  });

  it("notes LAN-only reachability when there is no Tailscale address", () => {
    let out = "";
    printPairing(
      { port: 8744, token: null, bindAddress: "0.0.0.0", safelist: [], codexPath: null },
      { tailscaleIP: () => null, lanIP: () => "192.168.0.5" },
      (s) => { out += s; },
      {},
    );
    expect(out).toContain("local network");
    expect(out).toContain("same Wi-Fi");
  });
});

describe("resolveHostInfo / reachabilityNote", () => {
  it("tags each source", () => {
    expect(resolveHostInfo({ HANDSFREE_HOST: "myhost" }, deps("100.1.2.3", null)).source).toBe("override");
    expect(resolveHostInfo({}, deps("100.1.2.3", "192.168.0.5")).source).toBe("tailscale");
    expect(resolveHostInfo({}, deps(null, "192.168.0.5")).source).toBe("lan");
    expect(resolveHostInfo({}, deps(null, null)).source).toBe("localhost");
  });
  it("describes Tailscale as remote-capable and LAN as same-network", () => {
    expect(reachabilityNote({ host: "100.1.2.3", source: "tailscale" })).toContain("remotely");
    expect(reachabilityNote({ host: "192.168.0.5", source: "lan" })).toContain("same Wi-Fi");
  });
});
