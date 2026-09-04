#!/usr/bin/env node
/**
 * Refresh Markets tape only (Yahoo daily). Faster than full ingest.
 *   npm run ingest:markets
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.GF_MARKETS_ONLY = "1";
const child = spawn(process.execPath, [path.join(ROOT, "scripts", "ingest.mjs")], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code) => process.exit(code || 0));
