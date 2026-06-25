import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import qrcode from "qrcode-terminal";
import type { Config } from "./config.js";

export interface HostDeps {
  tailscaleIP: () => string | null;
  lanIP: () => string | null;
}

// Validate octet ranges (0-255), so `tailscale ip -4` garbage like "999.999.999.999" is rejected.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * True for an address in Tailscale's CGNAT range 100.64.0.0/10
 * (100.64.0.0 – 100.127.255.255), which every Tailscale node's IPv4 falls in.
 */
export function isTailscaleCGNAT(addr: string): boolean {
  if (!IPV4.test(addr)) return false;
  const parts = addr.split(".");
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  return a === 100 && b >= 64 && b <= 127;
}

/**
 * Find the host's Tailscale IPv4 directly from its network interfaces, by
 * scanning for a non-internal address in the CGNAT range. This is the fallback
 * for when the `tailscale` CLI isn't on PATH — e.g. the macOS GUI app (App Store
 * or direct download) keeps the CLI inside the app bundle, so `tailscale ip -4`
 * fails with ENOENT even though the tunnel is up.
 */
export function tailscaleIPFromInterfaces(
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | null {
  for (const list of Object.values(ifaces)) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal && isTailscaleCGNAT(ni.address)) return ni.address;
    }
  }
  return null;
}

/**
 * The host's Tailscale IPv4. Tries the `tailscale ip -4` CLI first, then falls
 * back to scanning network interfaces for the CGNAT range so detection still
 * works when the CLI is unavailable. Null if Tailscale isn't running at all.
 */
export function tailscaleIP(): string | null {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 2000 });
    // take the first IPv4 line; tailscale typically returns exactly one
    const first = out.split("\n").map((s) => s.trim()).find(Boolean);
    if (first && IPV4.test(first)) return first;
  } catch {
    // CLI missing (not on PATH) or it errored — fall through to the interface scan.
  }
  return tailscaleIPFromInterfaces();
}

/** The first non-internal IPv4 LAN address, or null. */
export function lanIP(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return null;
}

/** Where the advertised host came from — drives the human-readable reachability note. */
export type HostSource = "override" | "tailscale" | "lan" | "localhost";

export interface ResolvedHost {
  host: string;
  source: HostSource;
}

/** Decide which host to advertise + where it came from: env override → Tailscale → LAN → localhost. */
export function resolveHostInfo(env: NodeJS.ProcessEnv, deps: HostDeps): ResolvedHost {
  const override = env.HANDSFREE_HOST?.trim();
  if (override) return { host: override, source: "override" };
  const ts = deps.tailscaleIP();
  if (ts) return { host: ts, source: "tailscale" };
  const lan = deps.lanIP();
  if (lan) return { host: lan, source: "lan" };
  return { host: "localhost", source: "localhost" };
}

/** Decide which host to advertise: env override → Tailscale → LAN → localhost. */
export function resolveHost(env: NodeJS.ProcessEnv, deps: HostDeps): string {
  return resolveHostInfo(env, deps).host;
}

/** One-line note telling the user whether the bridge is reachable remotely or only on the LAN. */
export function reachabilityNote(r: ResolvedHost): string {
  switch (r.source) {
    case "tailscale":
      return `Connecting over Tailscale (${r.host}) — works remotely, from any network.`;
    case "lan":
      return `Connecting over your local network (${r.host}) — phone must be on the same Wi-Fi. For remote access, set up Tailscale: https://tailscale.com/download`;
    case "override":
      return `Connecting to ${r.host} (from HANDSFREE_HOST).`;
    case "localhost":
      return `No network address found — only reachable on this machine. Join a Wi-Fi or set up Tailscale (https://tailscale.com/download) to connect your phone.`;
  }
}

/** The `handsfree://connect?...` deep link the QR encodes. Token only when set. */
export function buildPairURL(host: string, port: number, token: string | null): string {
  const base = `handsfree://connect?host=${encodeURIComponent(host)}&port=${port}`;
  return token ? `${base}&token=${encodeURIComponent(token)}` : base;
}

/**
 * Print the pairing QR + URL. The URL line is emitted synchronously (so it is
 * easy to test and always visible even if the terminal can't render the QR);
 * the QR is rendered after it.
 */
export function printPairing(
  config: Config,
  deps: HostDeps = { tailscaleIP, lanIP },
  out: (s: string) => void = (s) => process.stdout.write(s),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const resolved = resolveHostInfo(env, deps);
  const url = buildPairURL(resolved.host, config.port, config.token);
  out(`\n${reachabilityNote(resolved)}\n`);
  out(`\nScan to connect Handsfree (or open this URL on the phone):\n${url}\n`);
  qrcode.generate(url, { small: true }, (qr) => out("\n" + qr + "\n"));
}
