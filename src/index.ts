import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { BridgeServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLogger(join(tmpdir(), "handsfree-bridge.log"));
  const server = new BridgeServer({ config, logger });
  const port = await server.listen();
  logger.info("bridge listening", { port, bind: config.bindAddress });

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
