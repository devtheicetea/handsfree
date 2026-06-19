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

/** The host's Tailscale IPv4 (`tailscale ip -4`), or null if Tailscale isn't available. */
export function tailscaleIP(): string | null {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 2000 });
    // take the first IPv4 line; tailscale typically returns exactly one
    const first = out.split("\n").map((s) => s.trim()).find(Boolean);
    return first && IPV4.test(first) ? first : null;
  } catch {
    return null;
  }
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

/** Decide which host to advertise: env override → Tailscale → LAN → localhost. */
export function resolveHost(env: NodeJS.ProcessEnv, deps: HostDeps): string {
  const override = env.HANDSFREE_HOST?.trim();
  if (override) return override;
  return deps.tailscaleIP() ?? deps.lanIP() ?? "localhost";
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
  const host = resolveHost(env, deps);
  const url = buildPairURL(host, config.port, config.token);
  out(`\nScan to connect Handsfree (or open this URL on the phone):\n${url}\n`);
  qrcode.generate(url, { small: true }, (qr) => out("\n" + qr + "\n"));
}
