#!/usr/bin/env node
/**
 * Last prints for Markets series (Yahoo spark, batched).
 * Used by /api/markets-live (Vercel) and local serve-https.py.
 * Empty cell > fake — skip a symbol rather than invent a price.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CATALOG = path.join(ROOT, "data", "catalog.json");

const UA =
  "GlobalFlows/0.1 (+https://markmaga.com; public macro instrument; educational)";
const BATCH = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isMarketSeries(s) {
  return s.street === "markets" || s.layer === "markets" || !!s.marketBucket;
}

async function fetchJson(url) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (res.status === 429 && attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      if (msg.includes("429") && attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (attempt < 3 && /fetch|network|ECONN/i.test(msg)) {
        await sleep(400 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function encodeSymbols(batch) {
  return batch
    .map((s) => encodeURIComponent(s).replace(/%5E/g, "^").replace(/%3D/g, "="))
    .join(",");
}

function lastPrice(row) {
  if (!row || typeof row !== "object") return { price: null, t: null };
  const close = Array.isArray(row.close) ? row.close : [];
  const lastBar = [...close].reverse().find((v) => v != null && Number.isFinite(v));
  const fullday = row.fulldayPrice;
  const price = Number.isFinite(fullday)
    ? fullday
    : Number.isFinite(lastBar)
      ? lastBar
      : null;
  const ts = Array.isArray(row.timestamp) ? row.timestamp : [];
  const t = ts.length ? ts[ts.length - 1] : null;
  return { price, t: Number.isFinite(t) ? t : null };
}

export async function fetchMarketsLive() {
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  const rows = (catalog.series || []).filter(
    (s) => isMarketSeries(s) && s.pipe === "yahoo" && s.yahoo
  );
  const byYahoo = new Map();
  for (const s of rows) {
    const list = byYahoo.get(s.yahoo) || [];
    list.push(s.id);
    byYahoo.set(s.yahoo, list);
  }
  const symbols = [...byYahoo.keys()];
  const quotes = {};

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeSymbols(
      batch
    )}&range=1d&interval=5m`;
    const data = await fetchJson(url);
    for (const [sym, row] of Object.entries(data || {})) {
      const { price, t } = lastPrice(row);
      if (price == null) continue;
      for (const id of byYahoo.get(sym) || []) {
        quotes[id] = { price, t };
      }
    }
    if (i + BATCH < symbols.length) await sleep(120);
  }

  return {
    pulledAt: new Date().toISOString(),
    n: Object.keys(quotes).length,
    quotes,
  };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  fetchMarketsLive()
    .then((out) => {
      process.stdout.write(JSON.stringify(out));
    })
    .catch((e) => {
      process.stderr.write(String(e.message || e) + "\n");
      process.exit(1);
    });
}
