import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFearGreed } from "../scripts/shelf-live.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FALLBACK = path.join(ROOT, "data", "external", "fear-greed", "latest.json");

const CACHE_MS = 5 * 60 * 1000;
let cache = null;

async function fallback() {
  try {
    const text = await fs.readFile(FALLBACK, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const now = Date.now();
  if (cache && now - cache.t < CACHE_MS) {
    res.statusCode = 200;
    res.end(JSON.stringify(cache.body));
    return;
  }
  try {
    const body = await fetchFearGreed();
    cache = { t: now, body };
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  } catch (e) {
    const stale = cache?.body || (await fallback());
    if (stale) {
      res.statusCode = 200;
      res.end(JSON.stringify(stale));
      return;
    }
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
}
