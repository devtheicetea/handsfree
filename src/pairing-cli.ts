import { loadConfig } from "./config.js";
import { printPairing } from "./pairing.js";

printPairing(loadConfig(process.env));
