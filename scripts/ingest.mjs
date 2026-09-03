#!/usr/bin/env node
/**
 * MacroFlows ingest — public pipes only.
 * FRED CSV graph (no key required), NY Fed Markets API, Yahoo chart API.
 * Empty cell > fake. Writes data/snapshot.json + data/history/*.json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CATALOG = path.join(ROOT, "data", "catalog.json");
const OUT = path.join(ROOT, "data", "snapshot.json");
const HIST = path.join(ROOT, "data", "history");

const UA =
  "MacroFlows/0.1 (+https://markmaga.com; public macro instrument; educational)";

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
  const json = await fetchJson(url, {
    headers: { Accept: "application/json" },
  });
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

function computeStats(points) {
  if (!points?.length) {
    return {
      latest: null,
      asOf: null,
      z2y: null,
      z5y: null,
      pct5y: null,
      pct10y: null,
      change1y: null,
    };
  }
  const latest = points[points.length - 1];
  const w2 = windowPoints(points, 2).map((p) => p.value);
  const w5 = windowPoints(points, 5).map((p) => p.value);
  const w10 = windowPoints(points, 10).map((p) => p.value);
  const w1 = windowPoints(points, 1);
  const yearAgo = w1.length > 5 ? w1[0].value : null;
  const m2 = mean(w2);
  const s2 = stdev(w2);
  const m5 = mean(w5);
  const s5 = stdev(w5);
  // Need enough history — never invent a percentile from one point
  const z2y = w2.length >= 24 && s2 ? (latest.value - m2) / s2 : null;
  const z5y = w5.length >= 36 && s5 ? (latest.value - m5) / s5 : null;
  const pct5y = w5.length >= 36 ? percentileRank(w5, latest.value) : null;
  const pct10y = w10.length >= 60 ? percentileRank(w10, latest.value) : null;
  return {
    latest: latest.value,
    asOf: latest.date,
    z2y,
    z5y,
    pct5y,
    pct10y,
    change1y:
      yearAgo != null && yearAgo !== 0
        ? ((latest.value - yearAgo) / Math.abs(yearAgo)) * 100
        : yearAgo != null
          ? latest.value - yearAgo
          : null,
    n: points.length,
  };
}

function lightState(signedZ, signedPct) {
  // Combine 2y z and 5y percentile (signed already applied)
  const parts = [];
  if (signedZ != null && Number.isFinite(signedZ)) parts.push(signedZ);
  if (signedPct != null && Number.isFinite(signedPct)) {
    // map pct 0..1 to approx z-ish: (pct-0.5)*3
    parts.push((signedPct - 0.5) * 3);
  }
  if (!parts.length) return { state: "empty", score: null };
  const score = mean(parts);
  if (score > 0.45) return { state: "easing", score };
  if (score < -0.45) return { state: "tight", score };
  return { state: "neutral", score };
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
  const results = {};
  const errors = [];

  console.log(`Ingesting ${catalog.series.length} series…`);

  for (const s of catalog.series) {
    if (s.pipe === "derived") continue;
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

      const stats = computeStats(points);
      const staleDays = daysSince(stats.asOf);
      // Discontinued mirrors (e.g. old leading index) must not drive lights
      const stale = staleDays != null && staleDays > 400;
      results[s.id] = {
        id: s.id,
        name: s.name,
        layer: s.layer,
        units: s.transform === "yoy" ? "% YoY" : s.transform === "diff" ? "change" : s.units,
        freq: s.freq,
        sign: s.sign ?? 0,
        light: stale ? null : s.light || null,
        weight: s.weight || 1,
        note: s.note || null,
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
        weight: s.weight || 1,
        note: s.note || null,
        freshness: s.freshness || "live",
        source: s.pipe,
        sourceUrl: s.sourceUrl || null,
        latest: null,
        asOf: null,
        z2y: null,
        z5y: null,
        pct5y: null,
        pct10y: null,
        change1y: null,
        status: "empty",
        error: String(e.message || e),
      };
    }
    await sleep(120);
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
      // WALCL is millions; TGA & RRP typically billions on FRED
      const walclBn = row.a / 1000;
      points.push({ date: row.date, value: walclBn - row.b - rrpV });
    }
    await fs.writeFile(
      path.join(HIST, "NET_LIQ.json"),
      JSON.stringify({ id: "NET_LIQ", source: "derived", points }, null, 0)
    );
    const stats = computeStats(points);
    const meta = catalog.series.find((x) => x.id === "NET_LIQ");
    results.NET_LIQ = {
      id: "NET_LIQ",
      name: meta.name,
      layer: "liquidity",
      units: meta.units,
      freq: "weekly",
      sign: 1,
      light: "liquidity",
      weight: 2,
      note: meta.note,
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
    const stats = computeStats(corrPoints);
    const meta = catalog.series.find((x) => x.id === "STOCK_BOND_CORR");
    results.STOCK_BOND_CORR = {
      id: "STOCK_BOND_CORR",
      name: meta.name,
      layer: "risk",
      units: meta.units,
      freq: "daily",
      sign: 0,
      light: null,
      weight: 1,
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

  // Lights
  const lightIds = ["liquidity", "transmission", "growth", "inflation", "risk"];
  const lights = {};
  for (const lid of lightIds) {
    const members = Object.values(results).filter(
      (r) => r.light === lid && r.status === "ok" && r.z2y != null
    );
    const signedZs = [];
    const signedPcts = [];
    for (const m of members) {
      const w = m.weight || 1;
      const sign = m.sign ?? 0;
      // inflation light: higher = "hot" = easing side of that light's labels
      const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
      if (m.z2y != null) {
        for (let i = 0; i < w; i++) signedZs.push(m.z2y * s);
      }
      if (m.pct5y != null) {
        // for signed series, flip percentile around 0.5
        const pct = s < 0 ? 1 - m.pct5y : m.pct5y;
        for (let i = 0; i < w; i++) signedPcts.push(pct);
      }
    }
    const z = signedZs.length ? mean(signedZs) : null;
    const pct = signedPcts.length ? mean(signedPcts) : null;
    const { state, score } = lightState(z, pct);
    const meta = catalog.lights.find((l) => l.id === lid);
    lights[lid] = {
      id: lid,
      label: meta?.label || lid,
      state,
      score,
      z2y: z,
      pct5y: pct,
      n: members.length,
      words: {
        easing: meta?.easing,
        neutral: meta?.neutral,
        tight: meta?.tight,
      },
      members: members.map((m) => m.id),
    };
  }

  // Disagreement: liquidity easing vs gold/BTC soft (or reverse)
  const liq = lights.liquidity;
  const gold = results.GOLD;
  const btc = results.BTC;
  const disagreements = [];
  if (liq?.state && gold?.z2y != null) {
    const goldOn = gold.z2y > 0.3;
    const goldOff = gold.z2y < -0.3;
    if (liq.state === "easing" && goldOff) {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity easing, gold not confirming",
      });
    }
    if (liq.state === "tight" && goldOn) {
      disagreements.push({
        kind: "liquidity_vs_gold",
        text: "Liquidity tightening, gold firm anyway",
      });
    }
  }
  if (liq?.state && btc?.z2y != null) {
    const btcOn = btc.z2y > 0.3;
    const btcOff = btc.z2y < -0.3;
    if (liq.state === "easing" && btcOff) {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity easing, BTC not confirming",
      });
    }
    if (liq.state === "tight" && btcOn) {
      disagreements.push({
        kind: "liquidity_vs_btc",
        text: "Liquidity tightening, BTC firm anyway",
      });
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    catalogTitle: catalog.title,
    layers: catalog.layers,
    lightsMeta: catalog.lights,
    lights,
    disagreements,
    series: results,
    errors,
    formula: {
      lights:
        "Per light: mean of member (sign × 2y z) and flipped 5y percentiles; score>0.45 easing/strong/hot/risk-on; <-0.45 tight/soft/cold/risk-off. Inflation uses raw upside = hot.",
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
