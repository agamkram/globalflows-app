#!/usr/bin/env node
/**
 * Pull ALFRED vintages for analog economic voters.
 * Market-priced series (VIX, SOFR, curve, OAS) are unrevised and stay on
 * data/history. These files are gitignored; bake-history reads them when present.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "vintages");
const CATALOG = path.join(ROOT, "data", "catalog.json");

const VINTAGE_IDS = [
  "PAYEMS",
  "UNRATE",
  "ICSA",
  "GDPC1",
  "CFNAI",
  "WEI",
  "CPILFESL",
  "PCEPILFE",
  "MICH",
  "NFCI",
];

async function loadDotEnv() {
  try {
    const text = await fs.readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 1) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      if (k && process.env[k] == null) process.env[k] = v;
    }
  } catch {
    /* no .env */
  }
}

async function fetchVintage(fred, apiKey) {
  const observations = [];
  const limit = 100000;
  let offset = 0;
  for (;;) {
    const u = new URL("https://api.stlouisfed.org/fred/series/observations");
    u.searchParams.set("series_id", fred);
    u.searchParams.set("api_key", apiKey);
    u.searchParams.set("file_type", "json");
    u.searchParams.set("observation_start", "2010-01-01");
    u.searchParams.set("realtime_start", "2016-01-01");
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("offset", String(offset));
    const json = await fetch(u, {
      headers: {
        "User-Agent": "GlobalFlows/0.1 (+https://markmaga.com; public macro instrument; educational)",
        Accept: "application/json",
      },
    }).then((r) => r.json());
    if (json.error_message) throw new Error(json.error_message);
    const batch = json.observations || [];
    for (const o of batch) {
      if (o.value === ".") continue;
      const value = Number(o.value);
      if (!Number.isFinite(value)) continue;
      observations.push({
        date: o.date,
        rs: o.realtime_start,
        re: o.realtime_end,
        value,
      });
    }
    if (batch.length < limit) break;
    offset += limit;
  }
  return observations;
}

async function main() {
  await loadDotEnv();
  const apiKey = process.env.FRED_API_KEY || "";
  if (!apiKey) {
    console.log("fetch-vintages: no FRED_API_KEY — analog will use revised history");
    return;
  }
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  const byId = Object.fromEntries(catalog.series.map((s) => [s.id, s]));
  await fs.mkdir(OUT, { recursive: true });

  for (const id of VINTAGE_IDS) {
    const spec = byId[id];
    if (!spec?.fred) {
      console.log(`  ${id} skip — not in catalog`);
      continue;
    }
    process.stdout.write(`  ${id} (${spec.fred})… `);
    try {
      const observations = await fetchVintage(spec.fred, apiKey);
      const dates = new Set(observations.map((o) => o.date));
      await fs.writeFile(
        path.join(OUT, `${id}.json`),
        JSON.stringify({
          id,
          fred: spec.fred,
          transform: spec.transform || null,
          fetchedAt: new Date().toISOString(),
          n: observations.length,
          nDates: dates.size,
          observations,
        })
      );
      console.log(`ok  ${observations.length} vintages  ${dates.size} dates`);
    } catch (e) {
      console.log(`FAIL  ${e.message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
