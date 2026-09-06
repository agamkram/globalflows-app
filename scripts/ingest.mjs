#!/usr/bin/env node
/**
 * GlobalFlows ingest — public pipes only.
 * FRED CSV graph (no key required), NY Fed Markets API, Yahoo chart API.
 * Empty cell > fake. Writes data/snapshot.json + data/history/*.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  seriesFacts,
  applyRealRateAnchors,
  buildLights,
  attachImpulse,
  DEFAULT_IMPULSE,
} from "../score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CATALOG = path.join(ROOT, "data", "catalog.json");
const OUT = path.join(ROOT, "data", "snapshot.json");
const HIST = path.join(ROOT, "data", "history");

const UA =
  "GlobalFlows/0.1 (+https://markmaga.com; public macro instrument; educational)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function daysSince(isoDate) {
  if (!isoDate) return null;
  const t = Date.parse(isoDate + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "User-Agent": UA, Accept: "*/*", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

function parseFredCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    if (!date || raw === "." || raw === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    out.push({ date, value });
  }
  return out;
}

async function fetchFred(seriesId) {
  // Unauthenticated CSV graph endpoint — full history for public series
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const text = await fetchText(url);
  const points = parseFredCsv(text);
  if (!points.length) throw new Error(`FRED empty: ${seriesId}`);
  return {
    points,
    source: "FRED",
    sourceUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
  };
}

async function fetchFredApi(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}&api_key=${apiKey}&file_type=json&observation_start=1990-01-01`;
  const json = await fetchJson(url);
  const points = (json.observations || [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((p) => Number.isFinite(p.value));
  if (!points.length) throw new Error(`FRED API empty: ${seriesId}`);
  return {
    points,
    source: "FRED API",
    sourceUrl: `https://fred.stlouisfed.org/series/${seriesId}`,
  };
}

async function fetchNyfedSofr() {
  // Last ~years via search; fall back to last 1000
  const url =
    "https://markets.newyorkfed.org/api/rates/secured/sofr/search.json?startDate=2018-01-01&endDate=2099-12-31";
  try {
    const json = await fetchJson(url);
    const rows = json.refRates || json.rates || [];
    const points = rows
      .map((r) => ({
        date: r.effectiveDate || r.date,
        value: Number(r.percentRate ?? r.rate),
      }))
      .filter((p) => p.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!points.length) throw new Error("empty");
    return {
      points,
      source: "NY Fed Markets",
      sourceUrl: "https://www.newyorkfed.org/markets/reference-rates/sofr",
    };
  } catch {
    const last = await fetchJson(
      "https://markets.newyorkfed.org/api/rates/secured/sofr/last/1000.json"
    );
    const rows = last.refRates || last.rates || [];
    const points = rows
      .map((r) => ({
        date: r.effectiveDate || r.date,
        value: Number(r.percentRate ?? r.rate),
      }))
      .filter((p) => p.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      points,
      source: "NY Fed Markets",
      sourceUrl: "https://www.newyorkfed.org/markets/reference-rates/sofr",
    };
  }
}

async function fetchYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10y&interval=1d&includePrePost=false`;
  let json;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      json = await fetchJson(url, {
        headers: { Accept: "application/json" },
      });
      break;
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("429") && attempt < 3) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo empty: ${symbol}`);
  const ts = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const v = closes[i];
    if (v == null || !Number.isFinite(v)) continue;
    const d = new Date(ts[i] * 1000);
    const date = d.toISOString().slice(0, 10);
    points.push({ date, value: v });
  }
  if (!points.length) throw new Error(`Yahoo no closes: ${symbol}`);
  return {
    points,
    source: "Yahoo Finance",
    sourceUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`,
  };
}

function mean(arr) {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function stdev(arr) {
  if (arr.length < 2) return NaN;
  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
}

function percentileRank(arr, value) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  let below = 0;
  for (const x of sorted) {
    if (x < value) below++;
    else break;
  }
  return below / sorted.length;
}

function windowPoints(points, years) {
  if (!points.length) return [];
  const last = points[points.length - 1].date;
  const end = new Date(last + "T00:00:00Z");
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - years);
  const s = start.toISOString().slice(0, 10);
  return points.filter((p) => p.date >= s);
}

function yoyTransform(points) {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  const out = [];
  for (const p of points) {
    const d = new Date(p.date + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    // find nearest prior within 20 days
    let found = null;
    for (let k = 0; k < 25; k++) {
      const tryD = new Date(d);
      tryD.setUTCDate(tryD.getUTCDate() - k);
      const key = tryD.toISOString().slice(0, 10);
      if (byDate.has(key)) {
        found = byDate.get(key);
        break;
      }
    }
    if (found != null && found !== 0) {
      out.push({ date: p.date, value: (p.value / found - 1) * 100 });
    }
  }
  return out;
}

function diffTransform(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    out.push({
      date: points[i].date,
      value: points[i].value - points[i - 1].value,
    });
  }
  return out;
}

function alignWeeklyApprox(aPts, bPts) {
  // map B onto A's dates via last-known
  const b = [...bPts].sort((x, y) => x.date.localeCompare(y.date));
  let j = 0;
  const out = [];
  for (const a of aPts) {
    while (j + 1 < b.length && b[j + 1].date <= a.date) j++;
    if (b[j] && b[j].date <= a.date) {
      out.push({ date: a.date, a: a.value, b: b[j].value });
    }
  }
  return out;
}

function computeStats(points, spec = {}) {
  return seriesFacts(points, spec);
}

function pearson(xs, ys) {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  const a = xs.slice(-n);
  const b = ys.slice(-n);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (!da || !db) return null;
  return num / Math.sqrt(da * db);
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  await fs.mkdir(HIST, { recursive: true });

  const apiKey = process.env.FRED_API_KEY || "";
  const marketsOnly = process.env.GF_MARKETS_ONLY === "1";
  const results = {};
  const errors = [];

  let priorSeries = {};
  if (marketsOnly) {
    try {
      const prev = JSON.parse(await fs.readFile(path.join(ROOT, "snapshot.json"), "utf8"));
      priorSeries = prev.series || {};
      console.log(`Markets-only refresh — keeping ${Object.keys(priorSeries).length} prior series…`);
    } catch {
      console.log("Markets-only refresh — no prior snapshot, full pull for selected…");
    }
  }

  const isMarketSeries = (s) =>
    s.street === "markets" ||
    s.layer === "markets" ||
    !!s.marketBucket;

  console.log(
    marketsOnly
      ? `Ingesting market tape (${catalog.series.filter(isMarketSeries).length} series)…`
      : `Ingesting ${catalog.series.length} series…`
  );

  for (const s of catalog.series) {
    if (s.pipe === "derived") continue;
    if (marketsOnly && !isMarketSeries(s)) {
      if (priorSeries[s.id]) results[s.id] = priorSeries[s.id];
      continue;
    }
    process.stdout.write(`  ${s.id} (${s.pipe})… `);
    try {
      let got;
      if (s.pipe === "fred") {
        if (!s.fred) throw new Error("missing fred id");
        got = apiKey
          ? await fetchFredApi(s.fred, apiKey)
          : await fetchFred(s.fred);
      } else if (s.pipe === "nyfed") {
        got = await fetchNyfedSofr();
      } else if (s.pipe === "yahoo") {
        got = await fetchYahoo(s.yahoo);
      } else {
        throw new Error(`unknown pipe ${s.pipe}`);
      }

      let points = got.points;
      if (s.transform === "yoy") points = yoyTransform(points);
      if (s.transform === "diff") points = diffTransform(points);

      await fs.writeFile(
        path.join(HIST, `${s.id}.json`),
        JSON.stringify({ id: s.id, ...got, points, transform: s.transform || null }, null, 0)
      );

      const stats = computeStats(points, s);
      const staleDays = daysSince(stats.asOf);
      // Discontinued mirrors (e.g. old leading index) must not drive lights
      const stale = staleDays != null && staleDays > 400;
      results[s.id] = {
        id: s.id,
        name: s.name,
        layer: s.street || s.layer,
        street: s.street || s.layer,
        causal: s.causal || null,
        units: s.transform === "yoy" ? "% YoY" : s.transform === "diff" ? "change" : s.units,
        freq: s.freq,
        sign: s.sign ?? 0,
        light: stale ? null : s.light || null,
        impulseLight: stale ? null : s.impulseLight || null,
        weight: s.weight || 1,
        marketBucket: s.marketBucket || null,
        order: s.order ?? null,
        note: s.note || null,
        sub: s.sub || s.fred || s.yahoo || s.id,
        search: s.search || s.sub || s.fred || s.yahoo || s.id,
        freshness: stale ? "stale" : s.freshness || "live",
        source: got.source,
        sourceUrl: s.sourceUrl || got.sourceUrl,
        ...stats,
        status: stale ? "stale" : "ok",
        staleDays,
      };
      console.log(
        `${stale ? "STALE" : "ok"}  asOf=${stats.asOf}  n=${stats.n}${stale ? ` (${staleDays}d)` : ""}`
      );
    } catch (e) {
      console.log(`FAIL  ${e.message}`);
      errors.push({ id: s.id, error: String(e.message || e) });
      results[s.id] = {
        id: s.id,
        name: s.name,
        layer: s.layer,
        units: s.units,
        freq: s.freq,
        sign: s.sign ?? 0,
        light: s.light || null,
        impulseLight: s.impulseLight || null,
        weight: s.weight || 1,
        note: s.note || null,
        freshness: s.freshness || "live",
        source: s.pipe,
        sourceUrl: s.sourceUrl || null,
        latest: null,
        asOf: null,
        n: 0,
        anchor: { kind: "none", score: null, why: "empty", votes: false },
        impulse: null,
        status: "empty",
        error: String(e.message || e),
      };
    }
    await sleep(s.pipe === "yahoo" ? 350 : 100);
  }

  // Derived: net liquidity ≈ WALCL − TGA − ON RRP (scale WALCL millions → billions)
  try {
    const walcl = JSON.parse(await fs.readFile(path.join(HIST, "WALCL.json"), "utf8"));
    const tga = JSON.parse(await fs.readFile(path.join(HIST, "WTREGEN.json"), "utf8"));
    const rrp = JSON.parse(await fs.readFile(path.join(HIST, "RRPONTSYD.json"), "utf8"));
    const aligned = alignWeeklyApprox(walcl.points, tga.points);
    const rrpSorted = [...rrp.points].sort((a, b) => a.date.localeCompare(b.date));
    let rj = 0;
    const points = [];
    for (const row of aligned) {
      while (rj + 1 < rrpSorted.length && rrpSorted[rj + 1].date <= row.date) rj++;
      const rrpV = rrpSorted[rj] && rrpSorted[rj].date <= row.date ? rrpSorted[rj].value : null;
      if (rrpV == null) continue;
      // WALCL & TGA (WTREGEN) are millions on FRED; ON RRP is billions
      const walclBn = row.a / 1000;
      const tgaBn = row.b / 1000;
      points.push({ date: row.date, value: walclBn - tgaBn - rrpV });
    }
    await fs.writeFile(
      path.join(HIST, "NET_LIQ.json"),
      JSON.stringify({ id: "NET_LIQ", source: "derived", points }, null, 0)
    );
    const meta = catalog.series.find((x) => x.id === "NET_LIQ");
    const stats = computeStats(points, meta);
    results.NET_LIQ = {
      id: "NET_LIQ",
      name: meta.name,
      layer: meta.street || "liquidity",
      street: meta.street || "liquidity",
      causal: meta.causal || "liquidity",
      units: meta.units,
      freq: "weekly",
      sign: 1,
      light: meta.light || null,
      impulseLight: meta.impulseLight || "liquidity",
      weight: meta.weight || 1,
      note: meta.note,
      sub: meta.sub || "WALCL−TGA−RRP",
      search: meta.search || meta.sub || "WALCL−TGA−RRP",
      freshness: "live",
      source: "derived (WALCL − TGA − ON RRP)",
      sourceUrl: meta.sourceUrl,
      ...stats,
      status: "ok",
    };
    console.log(`  NET_LIQ (derived)… ok  asOf=${stats.asOf}`);
  } catch (e) {
    console.log(`  NET_LIQ FAIL  ${e.message}`);
    errors.push({ id: "NET_LIQ", error: String(e.message || e) });
  }

  // Derived: stock-bond 60d corr using SPX returns vs -DGS10 changes (approx)
  try {
    const spx = JSON.parse(await fs.readFile(path.join(HIST, "SPX.json"), "utf8"));
    const dgs = JSON.parse(await fs.readFile(path.join(HIST, "DGS10.json"), "utf8"));
    const aligned = alignWeeklyApprox(spx.points, dgs.points);
    const spRet = [];
    const bdRet = [];
    for (let i = 1; i < aligned.length; i++) {
      spRet.push(aligned[i].a / aligned[i - 1].a - 1);
      // bond proxy: negative yield change
      bdRet.push(-(aligned[i].b - aligned[i - 1].b));
    }
    const corrPoints = [];
    const win = 60;
    for (let i = win; i < spRet.length; i++) {
      const c = pearson(spRet.slice(i - win, i), bdRet.slice(i - win, i));
      if (c == null) continue;
      corrPoints.push({ date: aligned[i + 1].date, value: c });
    }
    await fs.writeFile(
      path.join(HIST, "STOCK_BOND_CORR.json"),
      JSON.stringify({ id: "STOCK_BOND_CORR", source: "derived", points: corrPoints }, null, 0)
    );
    const meta = catalog.series.find((x) => x.id === "STOCK_BOND_CORR");
    const stats = computeStats(corrPoints, meta);
    results.STOCK_BOND_CORR = {
      id: "STOCK_BOND_CORR",
      name: meta.name,
      layer: meta.street || "risk",
      street: meta.street || "risk",
      causal: meta.causal || "risk",
      units: meta.units,
      freq: "daily",
      sign: 0,
      light: null,
      weight: 1,
      sub: meta.sub || "SPX vs −ΔDGS10",
      search: meta.search || meta.sub || "SPX vs −ΔDGS10",
      freshness: "live",
      source: "derived (SPX vs −ΔDGS10, 60d)",
      sourceUrl: meta.sourceUrl,
      ...stats,
      status: "ok",
    };
    console.log(`  STOCK_BOND_CORR… ok  asOf=${stats.asOf}  r=${stats.latest?.toFixed?.(3)}`);
  } catch (e) {
    console.log(`  STOCK_BOND_CORR FAIL  ${e.message}`);
    errors.push({ id: "STOCK_BOND_CORR", error: String(e.message || e) });
  }

  // Derived: credit impulse = Δ(YoY% of TOTLL) over ~1y, in percentage points
  try {
    const totll = JSON.parse(await fs.readFile(path.join(HIST, "TOTLL.json"), "utf8"));
    const pts = [...(totll.points || [])].sort((a, b) => a.date.localeCompare(b.date));
    const yoy = [];
    let j = 0;
    for (let i = 0; i < pts.length; i++) {
      const end = Date.parse(pts[i].date + "T00:00:00Z");
      const target = end - 365.25 * 86400000;
      const targetIso = new Date(target).toISOString().slice(0, 10);
      while (j + 1 < i && pts[j + 1].date <= targetIso) j++;
      const base = pts[j];
      if (!base || base.date > targetIso || !base.value) continue;
      // Prefer nearest print within ~3 weeks of the 1y mark
      const baseT = Date.parse(base.date + "T00:00:00Z");
      if (Math.abs(end - baseT - 365.25 * 86400000) > 21 * 86400000) continue;
      yoy.push({
        date: pts[i].date,
        value: ((pts[i].value - base.value) / Math.abs(base.value)) * 100,
      });
    }
    const impulse = [];
    let k = 0;
    for (let i = 0; i < yoy.length; i++) {
      const end = Date.parse(yoy[i].date + "T00:00:00Z");
      const targetIso = new Date(end - 365.25 * 86400000).toISOString().slice(0, 10);
      while (k + 1 < i && yoy[k + 1].date <= targetIso) k++;
      const base = yoy[k];
      if (!base || base.date > targetIso) continue;
      const baseT = Date.parse(base.date + "T00:00:00Z");
      if (Math.abs(end - baseT - 365.25 * 86400000) > 28 * 86400000) continue;
      impulse.push({ date: yoy[i].date, value: yoy[i].value - base.value });
    }
    if (impulse.length < 24) throw new Error(`thin impulse history (${impulse.length})`);
    await fs.writeFile(
      path.join(HIST, "CREDIT_IMPULSE.json"),
      JSON.stringify({ id: "CREDIT_IMPULSE", source: "derived", points: impulse }, null, 0)
    );
    const meta = catalog.series.find((x) => x.id === "CREDIT_IMPULSE");
    const stats = computeStats(impulse, meta);
    results.CREDIT_IMPULSE = {
      id: "CREDIT_IMPULSE",
      name: meta.name,
      layer: meta.street || "liquidity",
      street: meta.street || "liquidity",
      causal: meta.causal || "liquidity",
      units: meta.units,
      freq: "weekly",
      sign: 1,
      light: meta.light || null,
      impulseLight: meta.impulseLight || "liquidity",
      weight: meta.weight || 1,
      note: meta.note,
      sub: meta.sub || "Δ bank-credit YoY",
      search: meta.search || "CREDIT_IMPULSE",
      freshness: "live",
      source: "derived (Δ YoY TOTLL)",
      sourceUrl: meta.sourceUrl,
      ...stats,
      status: "ok",
    };
    console.log(
      `  CREDIT_IMPULSE… ok  asOf=${stats.asOf}  ${stats.latest?.toFixed?.(2)} pp`
    );
  } catch (e) {
    console.log(`  CREDIT_IMPULSE FAIL  ${e.message}`);
    errors.push({ id: "CREDIT_IMPULSE", error: String(e.message || e) });
  }

  // Derived: nominal − real GDP YoY (pp) — price heat in the expansion
  try {
    const nom = JSON.parse(await fs.readFile(path.join(HIST, "GDP.json"), "utf8"));
    const real = JSON.parse(await fs.readFile(path.join(HIST, "GDPC1.json"), "utf8"));
    const aligned = alignWeeklyApprox(nom.points || [], real.points || []);
    const points = aligned
      .filter((r) => Number.isFinite(r.a) && Number.isFinite(r.b))
      .map((r) => ({ date: r.date, value: r.a - r.b }));
    if (points.length < 8) throw new Error(`thin nom−real history (${points.length})`);
    await fs.writeFile(
      path.join(HIST, "NOM_REAL_SPREAD.json"),
      JSON.stringify({ id: "NOM_REAL_SPREAD", source: "derived", points }, null, 0)
    );
    const meta = catalog.series.find((x) => x.id === "NOM_REAL_SPREAD");
    const stats = computeStats(points, meta);
    results.NOM_REAL_SPREAD = {
      id: "NOM_REAL_SPREAD",
      name: meta.name,
      layer: meta.street || "growth",
      street: meta.street || "growth",
      causal: meta.causal || "labels",
      units: meta.units,
      freq: "quarterly",
      sign: 1,
      light: null,
      weight: 1,
      note: meta.note,
      sub: meta.sub || "GDP YoY − real GDP YoY",
      search: meta.search || "NOM_REAL_SPREAD",
      freshness: "lagged",
      source: "derived (nominal − real GDP YoY)",
      sourceUrl: meta.sourceUrl,
      ...stats,
      status: "ok",
    };
    console.log(
      `  NOM_REAL_SPREAD… ok  asOf=${stats.asOf}  ${stats.latest?.toFixed?.(2)} pp`
    );
  } catch (e) {
    console.log(`  NOM_REAL_SPREAD FAIL  ${e.message}`);
    errors.push({ id: "NOM_REAL_SPREAD", error: String(e.message || e) });
  }

  applyRealRateAnchors(results);

  const lights = buildLights({
    series: results,
    lightsMeta: catalog.lights,
  });
  attachImpulse(lights, { series: results }, DEFAULT_IMPULSE);

  const liq = lights.liquidity;
  const risk = lights.risk;
  const growth = lights.growth;
  const infl = lights.inflation;
  const goldDir = results.GOLD?.impulse?.[DEFAULT_IMPULSE]?.dir;
  const btcDir = results.BTC?.impulse?.[DEFAULT_IMPULSE]?.dir;
  const headSc = results.CPIAUCSL?.anchor?.score;
  const coreSc = results.CPILFESL?.anchor?.score;
  const disagreements = [];
  if (liq?.state && goldDir) {
    if (liq.state === "easing" && goldDir === "down") {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity easing, gold not confirming",
      });
    }
    if (liq.state === "tight" && goldDir === "up") {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity tightening, gold firm anyway",
      });
    }
  }
  if (liq?.state && btcDir) {
    if (liq.state === "easing" && btcDir === "down") {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity easing, BTC not confirming",
      });
    }
    if (liq.state === "tight" && btcDir === "up") {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity tightening, BTC firm anyway",
      });
    }
  }
  if (liq?.state === "tight" && risk?.state === "easing") {
    disagreements.push({
      kind: "liquidity_vs_risk",
      text: "Liquidity tightening, risk still on",
    });
  }
  if (liq?.state === "easing" && risk?.state === "tight") {
    disagreements.push({
      kind: "liquidity_vs_risk",
      text: "Liquidity easing, risk still off",
    });
  }
  if (headSc != null && coreSc != null && headSc > 0.45 && coreSc < -0.45) {
    disagreements.push({
      kind: "inflation_headline_vs_core",
      text: "Headline CPI hot, core cold",
    });
  } else if (headSc != null && coreSc != null && headSc < -0.45 && coreSc > 0.45) {
    disagreements.push({
      kind: "inflation_headline_vs_core",
      text: "Headline CPI cold, core hot",
    });
  }
  if (growth?.state === "easing" && infl?.state === "tight") {
    disagreements.push({
      kind: "growth_vs_inflation",
      text: "Growth strong, inflation cold",
    });
  }
  if (growth?.state === "tight" && infl?.state === "easing") {
    disagreements.push({
      kind: "growth_vs_inflation",
      text: "Growth soft, inflation hot",
    });
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    catalogTitle: catalog.title,
    defaultGroup: catalog.defaultGroup || "street",
    layers: catalog.layers,
    street: catalog.street || catalog.layers,
    causal: catalog.causal || null,
    lightsMeta: catalog.lights,
    lights,
    disagreements,
    series: results,
    errors,
    formula: {
      lights:
        "Lights = median of voter anchors (economic level, not vs last year). Flow series can move the chevron only. 1m/3m/6m/1y = impulse only. Score >+0.45 / <−0.45 paints the word. Inflation upside = hot vs ~2%.",
      netLiquidity: "WALCL(bn) − TGA − ON RRP",
      stockBondCorr: "60d Pearson of SPX returns vs −ΔDGS10",
    },
  };

  await fs.writeFile(OUT, JSON.stringify(snapshot, null, 2));
  // Also copy for static serve from root
  await fs.writeFile(path.join(ROOT, "snapshot.json"), JSON.stringify(snapshot, null, 2));

  const ok = Object.values(results).filter((r) => r.status === "ok").length;
  const empty = Object.values(results).filter((r) => r.status !== "ok").length;
  console.log(`\nDone. ok=${ok} empty=${empty} → data/snapshot.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
