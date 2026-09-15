#!/usr/bin/env node
/**
 * Pull outside reads onto the external shelf.
 * Does not touch score.js, bake, or the live strip.
 *
 *   npm run fetch:external
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arsenalFromPrints, isoDay, pullCot } from "../shelf-lib.js";
import { fetchFearGreed as pullFear } from "./shelf-live.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "data", "external");
const UA =
  "GlobalFlows/0.1 (+https://markmaga.com; educational macro instrument; external shelf)";
const IITIAN = "https://iitianmacro.ai/terminal/regime";

async function getJson(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${url}\n${body.slice(0, 240)}`);
  }
  return res.json();
}

async function getText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      ...extraHeaders,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${url}\n${body.slice(0, 240)}`);
  }
  return res.text();
}

function stripTags(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function readHistoryPoints(seriesId) {
  const file = path.join(ROOT, "data", "history", `${seriesId}.json`);
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const pts = raw.points || [];
  if (!pts.length) throw new Error(`empty history ${seriesId}`);
  return pts;
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function writeJson(file, obj) {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function appendJsonl(file, row) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, JSON.stringify(row) + "\n", "utf8");
}

async function fetchCot(fetchedAt) {
  const payload = await pullCot(getJson);
  payload.fetchedAt = fetchedAt;
  payload.note =
    "CFTC as-of is typically Tuesday; publish is typically Friday. Do not treat Friday knowledge as known on Tuesday.";
  await writeJson(path.join(EXT, "cot", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "cot", "history.jsonl"), {
    fetchedAt,
    tffAsOf: payload.tffAsOf,
    disaggregatedAsOf: payload.disaggregatedAsOf,
    contracts: (payload.contracts || []).map((c) => ({
      id: c.id,
      asOf: c.asOf,
      openInterest: c.openInterest ?? null,
      assetMgrNet: c.assetMgrNet ?? null,
      levMoneyNet: c.levMoneyNet ?? null,
      managedMoneyNet: c.managedMoneyNet ?? null,
      missing: !!c.missing,
    })),
  });
  return payload;
}

async function fetchFearGreed(fetchedAt) {
  const payload = await pullFear();
  payload.fetchedAt = fetchedAt;
  await writeJson(path.join(EXT, "fear-greed", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "fear-greed", "history.jsonl"), {
    fetchedAt,
    asOf: payload.asOf,
    score: payload.score,
    rating: payload.rating,
  });
  return payload;
}

async function fetchArsenal(fetchedAt) {
  const gdpPts = await readHistoryPoints("GDPC1");
  const cpiPts = await readHistoryPoints("CPIAUCSL");
  const gdp = gdpPts[gdpPts.length - 1];
  const cpi = cpiPts[cpiPts.length - 1];
  const payload = arsenalFromPrints({
    gdpYoy: gdp.value,
    cpiYoy: cpi.value,
    gdpAsOf: gdp.date,
    cpiAsOf: cpi.date,
  });
  if (!payload) throw new Error("Arsenal needs GDPC1 and CPIAUCSL YoY points");
  payload.fetchedAt = fetchedAt;
  await writeJson(path.join(EXT, "arsenal", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "arsenal", "history.jsonl"), {
    fetchedAt,
    asOf: payload.asOf,
    regime: payload.regime,
    gdpYoy: payload.gdpYoy,
    cpiYoy: payload.cpiYoy,
  });
  return payload;
}

async function fetchIitian(fetchedAt) {
  const html = await getText(IITIAN);
  const labelMatch = html.match(
    /Position read<\/h3>\s*<div[^>]*>([^<]+)<\/div>/i
  );
  const blurbMatch = html.match(
    /Position read<\/h3>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i
  );
  const kv = {};
  for (const key of [
    "6-month path",
    "Assets this transition historically favours",
    "Assets it punishes",
    "What moves the dot next",
  ]) {
    const re = new RegExp(
      key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
        "</span>\\s*<b[^>]*>([\\s\\S]*?)</b>",
      "i"
    );
    const m = html.match(re);
    if (m) kv[key] = stripTags(m[1]);
  }
  const label = stripTags(labelMatch?.[1] || "");
  const blurb = stripTags(blurbMatch?.[1] || "");
  let quadrant = null;
  if (/Quadrant\s*2|Deep into ②|② now/i.test(html)) quadrant = 2;
  else if (/Quadrant\s*3|③/.test(html)) quadrant = 3;
  else if (/Quadrant\s*4|④/.test(html)) quadrant = 4;
  else if (/Quadrant\s*1|①/.test(html)) quadrant = 1;

  if (!label) throw new Error("IITian regime label not found in HTML");

  const payload = {
    source: "iitian",
    fetchedAt,
    asOf: isoDay(fetchedAt),
    label,
    blurb,
    quadrant,
    path6m: kv["6-month path"] || null,
    favours: kv["Assets this transition historically favours"] || null,
    punishes: kv["Assets it punishes"] || null,
    nextCatalyst: kv["What moves the dot next"] || null, // viewer: nextCatalyst
    attribution: {
      text: "IITian Macro Terminal",
      url: IITIAN,
    },
    note: "Scraped from their public regime page. Layout changes can break the pull.",
  };
  await writeJson(path.join(EXT, "iitian", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "iitian", "history.jsonl"), {
    fetchedAt,
    asOf: payload.asOf,
    label: payload.label,
    quadrant: payload.quadrant,
  });
  return payload;
}

async function touchCatalog(fetchedAt) {
  const file = path.join(EXT, "catalog.json");
  const cat = JSON.parse(await fs.readFile(file, "utf8"));
  cat.updated = fetchedAt;
  await writeJson(file, cat);
}

async function main() {
  const fetchedAt = new Date().toISOString();
  console.log("external shelf — fetch", fetchedAt);

  try {
    const cot = await fetchCot(fetchedAt);
    const hit = cot.contracts.filter((c) => !c.missing).length;
    console.log(
      `  cot        tff ${cot.tffAsOf}  disagg ${cot.disaggregatedAsOf}  (${hit}/${cot.contracts.length} contracts)`
    );
    for (const c of cot.contracts.filter((x) => x.missing)) {
      console.log(`             missing ${c.id}: ${c.market}`);
    }
  } catch (e) {
    console.error("  cot FAIL", e.message || e);
  }

  try {
    const fear = await fetchFearGreed(fetchedAt);
    console.log(`  fear       ${fear.asOf}  score ${fear.score} (${fear.rating})`);
  } catch (e) {
    console.error("  fear FAIL", e.message || e);
  }

  try {
    const arsenal = await fetchArsenal(fetchedAt);
    console.log(
      `  arsenal    ${arsenal.asOf}  ${arsenal.regime}  GDP ${arsenal.gdpYoy.toFixed(2)}%  CPI ${arsenal.cpiYoy.toFixed(2)}%`
    );
  } catch (e) {
    console.error("  arsenal FAIL", e.message || e);
  }

  try {
    const iitian = await fetchIitian(fetchedAt);
    console.log(
      `  iitian     ${iitian.asOf}  ${iitian.label}${iitian.quadrant ? `  Q${iitian.quadrant}` : ""}`
    );
  } catch (e) {
    console.error("  iitian FAIL", e.message || e);
  }

  await touchCatalog(fetchedAt);
  console.log("ok — wrote data/external/{cot,fear-greed,arsenal,iitian}/");
  console.log("house-card.csv is still manual.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
