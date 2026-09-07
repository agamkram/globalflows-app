#!/usr/bin/env node
/**
 * Last prints that can move between morning bakes.
 * Yahoo tape (all symbols) + official dailies (FRED / NY Fed via FRED SOFR /
 * Bundesbank / BoE / MOF) + daily derived (G3, SOFR spread, dollar 12m).
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

async function fetchText(url, extra = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: extra.accept || "*/*", ...(extra.headers || {}) },
      });
      if (res.status === 429 && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      const msg = String(e.message || e);
      if (attempt < 2) await sleep(400 * (attempt + 1));
      else throw lastErr;
    }
  }
  throw lastErr;
}

async function fetchJson(url) {
  const text = await fetchText(url, { accept: "application/json" });
  return JSON.parse(text);
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

function isoFromUnix(t) {
  if (!Number.isFinite(t)) return new Date().toISOString().slice(0, 10);
  return new Date(t * 1000).toISOString().slice(0, 10);
}

function isoDaysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
}

async function fetchYahooQuotes(rows) {
  const byYahoo = new Map();
  for (const s of rows) {
    if (s.pipe !== "yahoo" || !s.yahoo) continue;
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
    try {
      const data = await fetchJson(url);
      for (const [sym, row] of Object.entries(data || {})) {
        const { price, t } = lastPrice(row);
        if (price == null) continue;
        const asOf = isoFromUnix(t);
        for (const id of byYahoo.get(sym) || []) {
          quotes[id] = { price, t, asOf, src: "yahoo" };
        }
      }
    } catch {
      /* skip batch */
    }
    if (i + BATCH < symbols.length) await sleep(120);
  }
  return quotes;
}

function parseFredMultiCsv(text, ids) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return {};
  const header = lines[0].split(",").map((h) => h.trim());
  const last = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = (cols[0] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    for (let c = 1; c < header.length; c++) {
      const raw = (cols[c] || "").trim();
      if (raw === "" || raw === ".") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      last[header[c]] = { price: value, asOf: date, src: "fred" };
    }
  }
  const quotes = {};
  for (const [id, fred] of ids) {
    const q = last[fred];
    if (q) quotes[id] = q;
  }
  return quotes;
}

async function poolMap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function fetchFredLast(idFredPairs) {
  const quotes = {};
  const start = isoDaysAgo(50);
  const longStart = isoDaysAgo(420);
  const longIds = new Set(["DTWEXBGS"]);

  await poolMap(idFredPairs, 8, async ([id, fred]) => {
    const cosd = longIds.has(fred) ? longStart : start;
    const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(fred)}&cosd=${cosd}`;
    try {
      const text = await fetchText(url);
      Object.assign(quotes, parseFredMultiCsv(text, [[id, fred]]));
    } catch {
      /* skip series */
    }
  });
  return quotes;
}

function parseSdmxCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].replace(/^\uFEFF/, "").split(";");
  const di = header.indexOf("TIME_PERIOD");
  const vi = header.indexOf("OBS_VALUE");
  if (di < 0 || vi < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(";");
    const date = (cols[di] || "").trim();
    const raw = (cols[vi] || "").trim();
    if (!date || raw === "" || raw === ".") continue;
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

async function fetchBundesbankLast(key) {
  const slash = key.indexOf("/");
  if (slash < 0) return null;
  const flow = key.slice(0, slash);
  const series = key.slice(slash + 1);
  const url =
    `https://api.statistiken.bundesbank.de/rest/data/${encodeURIComponent(flow)}/${series}` +
    `?detail=dataonly&lastNObservations=8`;
  const text = await fetchText(url, {
    headers: { Accept: "application/vnd.sdmx.data+csv;version=1.0.0" },
  });
  const pts = parseSdmxCsv(text);
  const last = pts.at(-1);
  return last ? { price: last.value, asOf: last.date, src: "bundesbank" } : null;
}

const BOE_MONTHS = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function parseBoeDate(s) {
  const m = String(s).trim().match(/^(\d{1,2}) ([A-Za-z]{3}) (\d{4})$/);
  if (!m) return null;
  const mon = BOE_MONTHS[m[2]];
  if (!mon) return null;
  return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

async function fetchBoeLast(code) {
  const from = isoDaysAgo(60);
  const [y, m, d] = from.split("-");
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const datefrom = `${d}/${months[Number(m) - 1]}/${y}`;
  const url =
    "https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes" +
    `&Datefrom=${encodeURIComponent(datefrom)}&Dateto=now&SeriesCodes=${encodeURIComponent(code)}` +
    "&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N";
  const text = await fetchText(url);
  const lines = text.trim().split(/\r?\n/);
  let last = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = parseBoeDate(line.slice(0, comma));
    const value = Number(line.slice(comma + 1).trim());
    if (!date || !Number.isFinite(value)) continue;
    last = { price: value, asOf: date, src: "boe" };
  }
  return last;
}

function parseMofDate(s) {
  const m = String(s).trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

async function fetchMofJgbLast() {
  const url =
    "https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv";
  const text = await fetchText(url);
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let tenorIdx = -1;
  let last = null;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cols = line.split(",");
    if (tenorIdx < 0) {
      if (cols[0] && cols[0].trim() === "Date") {
        tenorIdx = cols.map((c) => c.trim()).indexOf("10Y");
      }
      continue;
    }
    const date = parseMofDate(cols[0]);
    const raw = (cols[tenorIdx] || "").trim();
    if (!date || raw === "" || raw === "-") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    last = { price: value, asOf: date, src: "mof" };
  }
  return last;
}

function yoyFromPoints(points) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const [y, m, d] = last.date.split("-").map(Number);
  const priorDate = `${String(y - 1).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  let prior = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= priorDate) {
      prior = points[i];
      break;
    }
  }
  if (!prior || !prior.value) return null;
  return {
    price: ((last.value - prior.value) / Math.abs(prior.value)) * 100,
    asOf: last.date,
    src: "derived",
  };
}

export async function fetchTapeLive() {
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  const rows = catalog.series || [];
  const quotes = {};

  const yahooP = fetchYahooQuotes(rows).catch(() => ({}));

  const fredPairs = [];
  for (const s of rows) {
    if (s.freq !== "daily") continue;
    if (s.pipe === "fred" && s.fred) fredPairs.push([s.id, s.fred]);
  }
  fredPairs.push(["SOFR", "SOFR"]);
  const fredP = fetchFredLast(fredPairs).catch(() => ({}));

  const de = rows.find((s) => s.id === "DE10Y");
  const gb = rows.find((s) => s.id === "GB10Y");
  const bbkP = de?.bundesbank
    ? fetchBundesbankLast(de.bundesbank).catch(() => null)
    : Promise.resolve(null);
  const boeP = gb?.boe ? fetchBoeLast(gb.boe).catch(() => null) : Promise.resolve(null);
  const mofP = fetchMofJgbLast().catch(() => null);

  const [yahoo, fred, bund, gilt, jgb] = await Promise.all([
    yahooP,
    fredP,
    bbkP,
    boeP,
    mofP,
  ]);
  Object.assign(quotes, yahoo, fred);
  if (bund) quotes.DE10Y = bund;
  if (gilt) quotes.GB10Y = gilt;
  if (jgb) quotes.JP10Y = jgb;

  const sofr = quotes.SOFR;
  const upper = quotes.DFEDTARU;
  if (sofr && upper && sofr.asOf && upper.asOf) {
    quotes.SOFR_SPREAD = {
      price: (sofr.price - upper.price) * 100,
      asOf: sofr.asOf,
      src: "derived",
    };
  }

  if (quotes.DE10Y && quotes.GB10Y && quotes.JP10Y) {
    const asOf = [quotes.DE10Y.asOf, quotes.GB10Y.asOf, quotes.JP10Y.asOf].sort().at(-1);
    quotes.G3_10Y = {
      price: (quotes.DE10Y.price + quotes.GB10Y.price + quotes.JP10Y.price) / 3,
      asOf,
      src: "derived",
    };
  }

  try {
    const start = isoDaysAgo(420);
    const text = await fetchText(
      `https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTWEXBGS&cosd=${start}`
    );
    const lines = text.trim().split(/\r?\n/).slice(1);
    const pts = [];
    for (const line of lines) {
      const comma = line.indexOf(",");
      if (comma < 0) continue;
      const date = line.slice(0, comma).trim();
      const raw = line.slice(comma + 1).trim();
      if (raw === "" || raw === ".") continue;
      const value = Number(raw);
      if (!date || !Number.isFinite(value)) continue;
      pts.push({ date, value });
    }
    if (quotes.DTWEXBGS) {
      const last = pts.at(-1);
      if (!last || quotes.DTWEXBGS.asOf >= last.date) {
        pts.push({ date: quotes.DTWEXBGS.asOf, value: quotes.DTWEXBGS.price });
      } else {
        last.value = quotes.DTWEXBGS.price;
      }
    }
    const yoy = yoyFromPoints(pts);
    if (yoy) quotes.DOLLAR_YOY = yoy;
  } catch {
    /* client can still derive from spark */
  }

  return {
    pulledAt: new Date().toISOString(),
    n: Object.keys(quotes).length,
    quotes,
  };
}

/** Back-compat name used by api/markets-live.js */
export const fetchMarketsLive = fetchTapeLive;

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  fetchTapeLive()
    .then((out) => {
      process.stdout.write(JSON.stringify(out));
    })
    .catch((e) => {
      process.stderr.write(String(e.message || e) + "\n");
      process.exit(1);
    });
}
