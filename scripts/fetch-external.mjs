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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(ROOT, "data", "external");
const UA =
  "GlobalFlows/0.1 (+https://markmaga.com; educational macro instrument; external shelf)";

const TFF = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
const DISAGG = "https://publicreporting.cftc.gov/resource/72hh-3qpy.json";
const FEAR =
  "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/2021-02-01";
const CONVEX = "https://convextrade.com/api/public/regime";

/** Exact CFTC market_and_exchange_names we keep. */
const TFF_WATCH = [
  {
    id: "ust_10y",
    label: "UST 10Y note",
    name: "UST 10Y NOTE - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "ust_5y",
    label: "UST 5Y note",
    name: "UST 5Y NOTE - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "ust_ultra",
    label: "Ultra UST bond",
    name: "ULTRA UST BOND - CHICAGO BOARD OF TRADE",
    gf: "treasuries",
  },
  {
    id: "es",
    label: "E-mini S&P 500",
    name: "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
    gf: "equities",
  },
  {
    id: "nq",
    label: "Nasdaq mini",
    name: "NASDAQ MINI - CHICAGO MERCANTILE EXCHANGE",
    gf: "equities",
  },
  {
    id: "btc",
    label: "Bitcoin CME",
    name: "BITCOIN - CHICAGO MERCANTILE EXCHANGE",
    gf: "crypto",
  },
  {
    id: "dxy",
    label: "USD index",
    name: "USD INDEX - ICE FUTURES U.S.",
    gf: null,
  },
];

const DISAGG_WATCH = [
  {
    id: "gold",
    label: "Gold COMEX",
    name: "GOLD - COMMODITY EXCHANGE INC.",
    gf: "gold",
  },
  {
    id: "copper",
    label: "Copper COMEX",
    name: "COPPER- #1 - COMMODITY EXCHANGE INC.",
    gf: "commodities",
  },
  {
    id: "wti",
    label: "WTI physical NYMEX",
    name: "WTI-PHYSICAL - NEW YORK MERCANTILE EXCHANGE",
    gf: "commodities",
  },
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function net(longV, shortV) {
  const l = num(longV);
  const s = num(shortV);
  if (l == null || s == null) return null;
  return l - s;
}

function isoDay(s) {
  if (!s) return null;
  return String(s).slice(0, 10);
}

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

async function latestReportDate(url) {
  const rows = await getJson(
    `${url}?$select=max(report_date_as_yyyy_mm_dd)%20as%20d`
  );
  return rows?.[0]?.d || null;
}

async function rowsForDate(url, reportDate) {
  const q = new URL(url);
  q.searchParams.set("$where", `report_date_as_yyyy_mm_dd='${reportDate}'`);
  q.searchParams.set("$limit", "10000");
  return getJson(q.toString());
}

function slimTff(row) {
  return {
    openInterest: num(row.open_interest_all),
    assetMgrNet: net(row.asset_mgr_positions_long, row.asset_mgr_positions_short),
    levMoneyNet: net(row.lev_money_positions_long, row.lev_money_positions_short),
    dealerNet: net(row.dealer_positions_long_all, row.dealer_positions_short_all),
    assetMgrLong: num(row.asset_mgr_positions_long),
    assetMgrShort: num(row.asset_mgr_positions_short),
    levMoneyLong: num(row.lev_money_positions_long),
    levMoneyShort: num(row.lev_money_positions_short),
  };
}

function slimDisagg(row) {
  return {
    openInterest: num(row.open_interest_all),
    managedMoneyNet: net(
      row.m_money_positions_long_all,
      row.m_money_positions_short_all
    ),
    producerNet: net(row.prod_merc_positions_long, row.prod_merc_positions_short),
    swapNet: net(row.swap_positions_long_all, row.swap__positions_short_all),
    managedMoneyLong: num(row.m_money_positions_long_all),
    managedMoneyShort: num(row.m_money_positions_short_all),
  };
}

async function fetchCot(fetchedAt) {
  const tffDate = await latestReportDate(TFF);
  const disaggDate = await latestReportDate(DISAGG);
  const tffRows = await rowsForDate(TFF, tffDate);
  const disaggRows = await rowsForDate(DISAGG, disaggDate);
  const tffByName = new Map(
    tffRows.map((r) => [r.market_and_exchange_names, r])
  );
  const disaggByName = new Map(
    disaggRows.map((r) => [r.market_and_exchange_names, r])
  );

  const contracts = [];
  for (const w of TFF_WATCH) {
    const row = tffByName.get(w.name);
    contracts.push({
      id: w.id,
      label: w.label,
      gf: w.gf,
      report: "tff",
      market: w.name,
      asOf: isoDay(tffDate),
      ...(row ? slimTff(row) : { missing: true }),
    });
  }
  for (const w of DISAGG_WATCH) {
    const row = disaggByName.get(w.name);
    contracts.push({
      id: w.id,
      label: w.label,
      gf: w.gf,
      report: "disaggregated",
      market: w.name,
      asOf: isoDay(disaggDate),
      ...(row ? slimDisagg(row) : { missing: true }),
    });
  }

  const payload = {
    source: "cot",
    fetchedAt,
    tffAsOf: isoDay(tffDate),
    disaggregatedAsOf: isoDay(disaggDate),
    note: "CFTC as-of is typically Tuesday; publish is typically Friday. Do not treat Friday knowledge as known on Tuesday.",
    contracts,
  };
  await writeJson(path.join(EXT, "cot", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "cot", "history.jsonl"), {
    fetchedAt,
    tffAsOf: payload.tffAsOf,
    disaggregatedAsOf: payload.disaggregatedAsOf,
    contracts: contracts.map((c) => ({
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
  const raw = await getJson(FEAR, {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Origin: "https://www.cnn.com",
    Referer: "https://www.cnn.com/",
  });
  const fg = raw.fear_and_greed || {};
  const hist = raw.fear_and_greed_historical?.data || [];
  const subs = {};
  for (const key of [
    "market_momentum_sp500",
    "stock_price_strength",
    "stock_price_breadth",
    "put_call_options",
    "market_volatility_vix",
    "junk_bond_demand",
    "safe_haven_demand",
  ]) {
    const block = raw[key];
    if (!block) continue;
    subs[key] = {
      score: num(block.score ?? block.now),
      rating: block.rating ?? null,
      timestamp: block.timestamp ?? null,
    };
  }
  const payload = {
    source: "fear-greed",
    fetchedAt,
    asOf: isoDay(fg.timestamp) || isoDay(fetchedAt),
    score: num(fg.score),
    rating: fg.rating || null,
    previousClose: num(fg.previous_close),
    previous1Week: num(fg.previous_1_week),
    previous1Month: num(fg.previous_1_month),
    previous1Year: num(fg.previous_1_year),
    subs,
    historyPoints: hist.length,
    note: "Unofficial CNN page feed. Fragile. Equity-centric mood gauge.",
  };
  await writeJson(path.join(EXT, "fear-greed", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "fear-greed", "history.jsonl"), {
    fetchedAt,
    asOf: payload.asOf,
    score: payload.score,
    rating: payload.rating,
  });
  return payload;
}

async function fetchConvex(fetchedAt) {
  const raw = await getJson(CONVEX);
  const assetViews = {};
  for (const [k, v] of Object.entries(raw.assetViews || {})) {
    assetViews[k] = {
      direction: v?.direction || null,
      conviction: v?.conviction || null,
      thesis: v?.thesis || null,
    };
  }
  const generatedAt = raw.generatedAt || raw.generated_at || null;
  const payload = {
    source: "convex",
    fetchedAt,
    generatedAt,
    asOf: isoDay(generatedAt),
    regime: raw.regime || null,
    trajectory: raw.trajectory || null,
    confidence: raw.confidence ?? null,
    narrative: raw.narrative || null,
    assetViews,
    attribution: raw.attribution || {
      text: "Data by Convex",
      url: "https://convextrade.com/regime",
    },
    staleDays:
      generatedAt && Number.isFinite(Date.parse(generatedAt))
        ? Math.floor((Date.parse(fetchedAt) - Date.parse(generatedAt)) / 86400000)
        : null,
    note: "Peer regime dashboard. Attribution required. Check staleDays before trusting.",
  };
  await writeJson(path.join(EXT, "convex", "latest.json"), payload);
  await appendJsonl(path.join(EXT, "convex", "history.jsonl"), {
    fetchedAt,
    generatedAt,
    asOf: payload.asOf,
    regime: payload.regime,
    trajectory: payload.trajectory,
    staleDays: payload.staleDays,
    views: Object.fromEntries(
      Object.entries(assetViews).map(([k, v]) => [k, v.direction])
    ),
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
      `  cot     tff ${cot.tffAsOf}  disagg ${cot.disaggregatedAsOf}  (${hit}/${cot.contracts.length} contracts)`
    );
    for (const c of cot.contracts.filter((x) => x.missing)) {
      console.log(`           missing ${c.id}: ${c.market}`);
    }
  } catch (e) {
    console.error("  cot FAIL", e.message || e);
  }

  try {
    const fear = await fetchFearGreed(fetchedAt);
    console.log(`  fear    ${fear.asOf}  score ${fear.score} (${fear.rating})`);
  } catch (e) {
    console.error("  fear FAIL", e.message || e);
  }

  try {
    const convex = await fetchConvex(fetchedAt);
    console.log(
      `  convex  ${convex.asOf || "?"}  ${convex.regime} / ${convex.trajectory}  staleDays=${convex.staleDays}`
    );
  } catch (e) {
    console.error("  convex FAIL", e.message || e);
  }

  await touchCatalog(fetchedAt);
  console.log("ok — wrote data/external/{cot,fear-greed,convex}/");
  console.log("house-card.csv is still manual.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
