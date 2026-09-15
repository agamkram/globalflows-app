#!/usr/bin/env node
/**
 * Shelf live pulls that cannot run in the browser (CNN Origin).
 *   node scripts/shelf-live.mjs --fear
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { fearFromRaw } from "../shelf-lib.js";

const FEAR =
  "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2021-02-01";

export async function fetchFearGreed() {
  const fetchedAt = new Date().toISOString();
  const res = await fetch(FEAR, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Origin: "https://www.cnn.com",
      Referer: "https://www.cnn.com/",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} CNN\n${body.slice(0, 240)}`);
  }
  return fearFromRaw(await res.json(), fetchedAt);
}

const here = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === here) {
  if (process.argv.includes("--fear")) {
    const body = await fetchFearGreed();
    process.stdout.write(JSON.stringify(body));
  } else {
    console.error("usage: node scripts/shelf-live.mjs --fear");
    process.exit(1);
  }
}
