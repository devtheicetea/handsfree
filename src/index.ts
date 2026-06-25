#!/usr/bin/env node
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { BridgeServer } from "./server.js";
import { printPairing } from "./pairing.js";

const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

const HELP = `handsfree-bridge ${pkg.version} — self-hosted backend for the Handsfree iOS app

Usage:
  handsfree-bridge            Start the bridge and print a pairing QR code.
  handsfree-bridge --version  Print the version.
  handsfree-bridge --help     Show this help.

Configuration (environment variables):
  HANDSFREE_PORT     Listen port (default 8744).
  HANDSFREE_BIND     Bind address (default 0.0.0.0).
  HANDSFREE_HOST     Host advertised in the pairing QR/URL (default: Tailscale IP -> LAN IP -> localhost).
  HANDSFREE_TOKEN    Optional shared secret the app must send.
  HANDSFREE_SAFELIST Comma-separated tools auto-approved in safelist mode.
  HANDSFREE_MODEL    Model for Claude sessions (e.g. sonnet, opus).
  HANDSFREE_CODEX_PATH  Full path to the codex binary.
  HANDSFREE_ENV      prod (default) or debug (verbose logging).`;

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (arg === "-v" || arg === "--version") { console.log(pkg.version); return; }
  if (arg === "-h" || arg === "--help") { console.log(HELP); return; }

  const config = loadConfig(process.env);
  // In debug mode, echo every log line to the terminal too (not just the file),
  // so `HANDSFREE_ENV=debug` actually shows the "verbose logging" it advertises.
  const logger = createLogger(join(tmpdir(), "handsfree-bridge.log"),
    config.env === "debug" ? { echo: (line) => console.log(line) } : {});
  const server = new BridgeServer({ config, logger });
  const port = await server.listen();
  logger.info("bridge listening", { port, bind: config.bindAddress, env: config.env });
  if (config.env === "debug") console.log("[hf] debug mode on (HANDSFREE_ENV=debug) — verbose logging enabled");
  printPairing(config);

  const shutdown = async () => {
    logger.info("shutting down");
    await server.close();
    logger.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${String(err)}\n`);
  process.exit(1);
});
