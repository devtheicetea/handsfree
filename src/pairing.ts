import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";

export interface HostDeps {
  tailscaleIP: () => string | null;
  lanIP: () => string | null;
}

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** The Mac's Tailscale IPv4 (`tailscale ip -4`), or null if Tailscale isn't available. */
export function tailscaleIP(): string | null {
  try {
    const out = execFileSync("tailscale", ["ip", "-4"], { encoding: "utf8", timeout: 2000 });
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
