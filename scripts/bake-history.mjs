/**
 * Replay the light model over stored history so the app can answer "when did it
 * look like this before, and what happened next".
 *
 * Same code path as the live bake — makeAnchor, applyRealRateAnchors and
 * buildLights are imported, not reimplemented.
 *
 * Archive starts 2003-01-02 (real yields, TIPS breakevens, Fed assets, ON RRP).
 * Pre-SOFR liquidity uses EFFR minus the fed funds target (bp) in the
 * SOFR_SPREAD slot so the voter set stays comparable. ICE HY OAS only covers
 * ~3 years on FRED; BAA10Y (already weight 2 on Risk) carries credit across
 * the full window.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAnchor, applyRealRateAnchors, buildLights, LIGHT_IDS, fitLightDist, calibrateLightScore, lightStateFromScore } from "../score.js";
import { loadLightDist } from "./load-light-dist.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HIST = path.join(ROOT, "data", "history");
const VINTAGE_DIR = path.join(ROOT, "data", "vintages");

const START = "2003-01-02";
const SOFR_START = "2018-04-02";
const STALE_DAYS = 400;
// Calendar months ≈ 21 trading days. One month is noise for a regime signal;
// 3m / 6m / 12m are the horizons that can actually grade a macro call.
const HORIZONS = { "1w": 5, "2w": 10, "1m": 21, "3m": 63, "6m": 126, "12m": 252 };

/**
 * Forward-return assets. Treasuries are synthetic total-return indices from
 * DGS5/DGS10/DGS30 (ret ≈ y/252 − D·Δy) so the archive grades the same 5s/10s/30s
 * the strip talks about, without the 2002 ETF floor. Credit uses HYG/LQD when
 * the ETF exists; gold and crypto are labeled thin where history is short.
 */
const ASSETS = [
  { id: "SPX", name: "S&P 500" },
  { id: "XLY", name: "Cyclicals" },
  { id: "XLP", name: "Defensives" },
  { id: "BTC", name: "Bitcoin", thinFrom: "2014-09-17" },
  { id: "UST5", name: "5y Treasuries", synthetic: true },
  { id: "UST10", name: "10y Treasuries", synthetic: true },
  { id: "UST30", name: "30y Treasuries", synthetic: true },
  { id: "HYG", name: "High yield", from: "2007-04-11" },
  { id: "LQD", name: "Investment grade" },
  { id: "GOLD", name: "Gold", from: "2000-08-30" },
  { id: "DXY", name: "Dollar" },
  { id: "COPPER", name: "Copper" },
  { id: "WTI", name: "Oil" },
];

const UST_SPECS = [
  { id: "UST5", yieldId: "DGS5", duration: 4.5 },
  { id: "UST10", yieldId: "DGS10", duration: 8.5 },
  { id: "UST30", yieldId: "DGS30", duration: 18 },
];

async function readHistory(id) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HIST, `${id}.json`), "utf8"));
    const pts = (j.points || [])
      .filter((p) => p && p.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    return pts.length ? pts : null;
  } catch {
    return null;
  }
}

/** Public FRED CSV — used for support series (e.g. DFEDTAR) not in the catalog. */
async function fetchFredCsv(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "GlobalFlows/0.1 (+https://markmaga.com)", Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`FRED ${seriesId} ${res.status}`);
  const text = await res.text();
  const out = [];
  for (const line of text.trim().split(/\r?\n/).slice(1)) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    const raw = line.slice(comma + 1).trim();
    if (!date || raw === "." || raw === "") continue;
    const value = Number(raw);
    if (Number.isFinite(value)) out.push({ date, value });
  }
  return out;
}

async function ensureSupportHistory(id, fredId) {
  let pts = await readHistory(id);
  if (pts?.length) return pts;
  console.log(`  fetching support series ${id} (${fredId})…`);
  pts = await fetchFredCsv(fredId);
  if (pts.length < 100) throw new Error(`${id} thin (${pts.length})`);
  await fs.mkdir(HIST, { recursive: true });
  await fs.writeFile(
    path.join(HIST, `${id}.json`),
    JSON.stringify({
      id,
      source: "FRED",
      sourceUrl: `https://fred.stlouisfed.org/series/${fredId}`,
      points: pts,
    }, null, 0)
  );
  return pts;
}

function yoyTransform(points) {
  const byDate = new Map(points.map((p) => [p.date, p.value]));
  const out = [];
  for (const p of points) {
    const d = new Date(p.date + "T00:00:00Z");
    d.setUTCFullYear(d.getUTCFullYear() - 1);
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

function indexVintages(raw) {
  const byDate = new Map();
  for (const o of raw.observations || []) {
    const list = byDate.get(o.date) || [];
    list.push(o);
    byDate.set(o.date, list);
  }
  const dates = [...byDate.keys()].sort();
  return { transform: raw.transform || null, dates, byDate };
}

/** Series as it was known on `date`, after the catalog transform. */
function vintageAsOf(index, date) {
  const levels = [];
  for (const obsDate of index.dates) {
    if (obsDate > date) break;
    const win = index.byDate.get(obsDate);
    const hit = win.find((w) => w.rs <= date && date <= w.re);
    if (hit) levels.push({ date: obsDate, value: hit.value });
  }
  let pts = levels;
  if (index.transform === "diff") pts = diffTransform(levels);
  if (index.transform === "yoy") pts = yoyTransform(levels);
  for (let i = pts.length - 1; i >= 0; i--) {
    const age = (Date.parse(date) - Date.parse(pts[i].date)) / 86400000;
    if (age <= STALE_DAYS) return { value: pts[i].value, obsDate: pts[i].date };
  }
  return { value: null, obsDate: null };
}

/** Last print on or before `date`, plus how stale it is. Cursor is carried forward. */
function asOf(points, cursor, date) {
  let i = cursor;
  while (i + 1 < points.length && points[i + 1].date <= date) i++;
  if (!points[i] || points[i].date > date) return { value: null, i };
  const age = (Date.parse(date) - Date.parse(points[i].date)) / 86400000;
  return { value: age > STALE_DAYS ? null : points[i].value, i };
}

function pctChange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  return ((b - a) / Math.abs(a)) * 100;
}

/**
 * Constant-duration Treasury total-return index from a yield series.
 * Daily return ≈ y/252 − D·Δy, with y and Δy in percent.
 */
function buildBondIndex(yieldPts, duration) {
  if (!yieldPts?.length) return null;
  const out = [{ date: yieldPts[0].date, value: 100 }];
  for (let i = 1; i < yieldPts.length; i++) {
    const y = yieldPts[i - 1].value;
    const dy = yieldPts[i].value - yieldPts[i - 1].value;
    if (!Number.isFinite(y) || !Number.isFinite(dy)) {
      out.push({ date: yieldPts[i].date, value: out[out.length - 1].value });
      continue;
    }
    const retPct = y / 252 - duration * dy;
    out.push({
      date: yieldPts[i].date,
      value: out[out.length - 1].value * (1 + retPct / 100),
    });
  }
  return out;
}

/**
 * Pre-SOFR funding spread: EFFR minus the target top, in bp — same units and
 * band as SOFR_SPREAD. Target is DFEDTARU when it exists, else DFEDTAR.
 */
function buildFundingSpread(effr, targetUpper, targetLegacy) {
  if (!effr?.length) return null;
  const upper = targetUpper || [];
  const legacy = targetLegacy || [];
  let ui = 0;
  let li = 0;
  const out = [];
  for (const p of effr) {
    while (ui + 1 < upper.length && upper[ui + 1].date <= p.date) ui++;
    while (li + 1 < legacy.length && legacy[li + 1].date <= p.date) li++;
    let target = null;
    if (upper[ui] && upper[ui].date <= p.date) target = upper[ui].value;
    else if (legacy[li] && legacy[li].date <= p.date) target = legacy[li].value;
    if (target == null || !Number.isFinite(p.value)) continue;
    out.push({ date: p.date, value: (p.value - target) * 100 });
  }
  return out.length ? out : null;
}

/**
 * Baa-based high-yield total-return proxy for 2003 until HYG lists.
 * Yield ≈ DGS10 + BAA10Y; duration ~5.5.
 */
function buildBaaCreditIndex(dgs10, baa10y, duration = 5.5) {
  if (!dgs10?.length || !baa10y?.length) return null;
  let bi = 0;
  const yld = [];
  for (const p of dgs10) {
    while (bi + 1 < baa10y.length && baa10y[bi + 1].date <= p.date) bi++;
    if (!baa10y[bi] || baa10y[bi].date > p.date) continue;
    yld.push({ date: p.date, value: p.value + baa10y[bi].value });
  }
  return buildBondIndex(yld, duration);
}

/**
 * Prefer ETF levels when present; before that, walk the synthetic index so
 * forward returns stay defined across 2003–2007.
 */
function splicePriceSeries(synth, etf, etfStart) {
  if (!etf?.length && !synth?.length) return null;
  if (!synth?.length) return etf;
  if (!etf?.length) return synth;
  const out = [];
  let si = 0;
  let ei = 0;
  const dates = [
    ...new Set([
      ...synth.map((p) => p.date),
      ...etf.map((p) => p.date),
    ]),
  ].sort();
  let level = 100;
  let lastSynth = null;
  let lastEtf = null;
  let useEtf = false;
  for (const date of dates) {
    while (si + 1 < synth.length && synth[si + 1].date <= date) si++;
    while (ei + 1 < etf.length && etf[ei + 1].date <= date) ei++;
    const s = synth[si] && synth[si].date <= date ? synth[si].value : null;
    const e = etf[ei] && etf[ei].date <= date ? etf[ei].value : null;
    if (etfStart && date >= etfStart && e != null) {
      if (!useEtf) {
        useEtf = true;
        lastEtf = e;
        out.push({ date, value: level });
        continue;
      }
      if (lastEtf != null && lastEtf !== 0) {
        level *= e / lastEtf;
      }
      lastEtf = e;
      out.push({ date, value: level });
    } else if (s != null) {
      if (lastSynth != null && lastSynth !== 0) {
        level *= s / lastSynth;
      }
      lastSynth = s;
      out.push({ date, value: level });
    }
  }
  return out.length ? out : null;
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, "data", "catalog.json"), "utf8"));

  const voters = catalog.series.filter((s) => s.light);
  const needed = [...new Set([...voters.map((s) => s.id), "PCEPILFE"])];

  const hist = {};
  for (const id of needed) {
    const p = await readHistory(id);
    if (p) hist[id] = p;
  }

  // Support series for the pre-SOFR funding-spread substitute and UST synthetics.
  hist.DFEDTAR = await ensureSupportHistory("DFEDTAR", "DFEDTAR");
  for (const id of ["EFFR", "DFEDTARU", "DGS5", "DGS10", "DGS30", "BAA10Y"]) {
    if (!hist[id]) {
      const p = await readHistory(id);
      if (p) hist[id] = p;
    }
  }

  const fundingSpread = buildFundingSpread(hist.EFFR, hist.DFEDTARU, hist.DFEDTAR);
  if (fundingSpread) {
    console.log(
      `  funding-spread proxy: ${fundingSpread[0].date} → ${fundingSpread.at(-1).date} (EFFR − target, bp)`
    );
  } else {
    console.log("  ! no funding-spread proxy — pre-SOFR liquidity loses SOFR_SPREAD");
  }

  const vintages = {};
  for (const id of [...needed, "PCEPILFE"]) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(VINTAGE_DIR, `${id}.json`), "utf8"));
      if (raw.observations?.length) vintages[id] = indexVintages(raw);
    } catch {
      /* revised history fallback */
    }
  }
  const vintageIds = Object.keys(vintages);
  if (vintageIds.length) {
    console.log(`  vintages for: ${vintageIds.join(", ")}`);
  } else {
    console.log("  no vintages — economic voters use revised history");
  }

  // Vintage start dates that matter for the 2003 window (ALFRED coverage).
  const vintageStarts = {};
  for (const id of vintageIds) {
    vintageStarts[id] = vintages[id].dates[0] || null;
  }

  const missing = needed.filter((id) => !hist[id] && id !== "SOFR_SPREAD");
  if (missing.length) console.log(`  no history for: ${missing.join(", ")}`);

  const shortCoverage = voters
    .filter((s) => {
      if (s.id === "SOFR_SPREAD") return false; // substituted pre-2018
      if (s.id === "BAMLH0A0HYM2") return false; // BAA10Y carries credit
      return hist[s.id] && hist[s.id][0].date > START;
    })
    .map((s) => `${s.id} (${s.light}, from ${hist[s.id][0].date})`);
  if (shortCoverage.length) {
    console.log(`  ! voters that do not cover ${START}:`);
    for (const s of shortCoverage) console.log(`      ${s}`);
  }

  const assetHist = {};
  for (const a of ASSETS) {
    if (a.synthetic) continue;
    const p = await readHistory(a.id);
    if (p) assetHist[a.id] = p;
  }

  for (const spec of UST_SPECS) {
    const yld = hist[spec.yieldId] || (await readHistory(spec.yieldId));
    const idx = buildBondIndex(yld, spec.duration);
    if (idx) {
      assetHist[spec.id] = idx.filter((p) => p.date >= START);
      console.log(
        `  ${spec.id}: synthetic from ${spec.yieldId} (D≈${spec.duration}) n=${assetHist[spec.id].length}`
      );
    }
  }

  // HY: Baa synth through HYG inception, then ETF total return.
  const baaCredit = buildBaaCreditIndex(hist.DGS10, hist.BAA10Y, 5.5);
  const hyEtf = assetHist.HYG || null;
  const hySpliced = splicePriceSeries(baaCredit, hyEtf, "2007-04-11");
  if (hySpliced) {
    assetHist.HYG = hySpliced.filter((p) => p.date >= START);
    console.log(`  HYG: Baa synth → ETF splice n=${assetHist.HYG.length}`);
  }

  // Trading-day grid from SPX (daily back through 2003 after period1 ingest).
  const grid = (assetHist.SPX || [])
    .map((p) => p.date)
    .filter((d) => d >= START);
  if (grid.length < 1000) throw new Error(`grid too short (${grid.length})`);

  const cursors = {};
  const assetCursors = {};
  const fundingCursor = { i: 0 };
  const rows = [];
  /** Expanding raw composites — no look-ahead into the day's own future. */
  const rawAccum = Object.fromEntries(LIGHT_IDS.map((id) => [id, []]));
  /** Running mean/M2 for O(1) expanding fit (Welford). */
  const run = Object.fromEntries(
    LIGHT_IDS.map((id) => [id, { n: 0, mean: 0, m2: 0 }])
  );
  const EXPAND_MIN = 252; // ~1y trading days before standardization kicks in
  let liveDist = null;
  try {
    liveDist = await loadLightDist();
  } catch {
    /* live compare optional */
  }

  function pushRunning(lid, x) {
    const s = run[lid];
    s.n += 1;
    const d = x - s.mean;
    s.mean += d / s.n;
    s.m2 += d * (x - s.mean);
  }
  function expandDistNow() {
    const lights = {};
    const sds = [];
    for (const id of LIGHT_IDS) {
      const s = run[id];
      const sd = s.n > 1 ? Math.sqrt(s.m2 / s.n) : 1;
      lights[id] = { mean: s.mean, sd: sd > 1e-9 ? sd : 1 };
      sds.push(lights[id].sd);
    }
    sds.sort((a, b) => a - b);
    return { lights, refSd: sds[Math.floor(sds.length / 2)] || 0.53 };
  }
  for (const date of grid) {
    const series = {};
    for (const spec of voters) {
      let value = null;

      if (spec.id === "SOFR_SPREAD") {
        if (date >= SOFR_START && hist.SOFR_SPREAD) {
          const got = asOf(hist.SOFR_SPREAD, cursors.SOFR_SPREAD || 0, date);
          cursors.SOFR_SPREAD = got.i;
          value = got.value;
        } else if (fundingSpread) {
          const got = asOf(fundingSpread, fundingCursor.i, date);
          fundingCursor.i = got.i;
          value = got.value;
        }
      } else if (vintages[spec.id]) {
        value = vintageAsOf(vintages[spec.id], date).value;
        // ALFRED pulls here start ~2016. Before that window, use revised history
        // so the 2003–2015 archive is not an empty Growth light.
        if (value == null && hist[spec.id]) {
          const got = asOf(hist[spec.id], cursors[spec.id] || 0, date);
          cursors[spec.id] = got.i;
          value = got.value;
        }
      } else {
        const pts = hist[spec.id];
        if (!pts) continue;
        const got = asOf(pts, cursors[spec.id] || 0, date);
        cursors[spec.id] = got.i;
        value = got.value;
      }
      if (value == null) continue;
      series[spec.id] = {
        id: spec.id,
        light: spec.light,
        weight: spec.weight || 1,
        freq: spec.freq,
        status: "ok",
        latest: value,
        asOf: date,
        anchor: makeAnchor(spec, value),
      };
    }

    // Real-rate anchors read core PCE off the same as-of date.
    let pce = { value: null };
    if (vintages.PCEPILFE) pce = vintageAsOf(vintages.PCEPILFE, date);
    if (pce.value == null && hist.PCEPILFE) {
      pce = asOf(hist.PCEPILFE, cursors.PCEPILFE || 0, date);
      cursors.PCEPILFE = pce.i;
    }
    if (pce.value != null) {
      series.PCEPILFE = series.PCEPILFE || {
        id: "PCEPILFE",
        status: "ok",
        latest: pce.value,
        asOf: date,
        anchor: { kind: "pce_yoy", score: null, why: "", votes: false },
      };
      applyRealRateAnchors(series);
    }

    // Raw composites first — expanding-window calib below (no look-ahead).
    const rawLights = buildLights(
      { series, lightsMeta: catalog.lights },
      Date.parse(date + "T12:00:00Z"),
      { calibrate: false }
    );
    const raw = LIGHT_IDS.map((id) => rawLights[id]?.score);
    if (raw.some((s) => s == null || !Number.isFinite(s))) continue;

    LIGHT_IDS.forEach((id, i) => {
      rawAccum[id].push(raw[i]);
      pushRunning(id, raw[i]);
    });
    const nSoFar = run[LIGHT_IDS[0]].n;
    let scores;
    if (nSoFar >= EXPAND_MIN) {
      const expandDist = expandDistNow();
      scores = LIGHT_IDS.map((id, i) => calibrateLightScore(id, raw[i], expandDist));
    } else {
      scores = raw;
    }
    const states = scores.map((sc) => lightStateFromScore(sc).state);

    const prices = {};
    for (const a of ASSETS) {
      const pts = assetHist[a.id];
      if (!pts) continue;
      const got = asOf(pts, assetCursors[a.id] || 0, date);
      assetCursors[a.id] = got.i;
      if (got.value != null) prices[a.id] = got.value;
    }

    rows.push({
      date,
      s: scores.map((v) => Number(v.toFixed(4))),
      raw: raw.map((v) => Number(v.toFixed(4))),
      st: states,
      px: prices,
    });
  }

  const expandFinal = fitLightDist(rawAccum);
  if (liveDist?.lights) {
    console.log("  light calib — expanding (archive) vs full-sample (live):");
    for (const id of LIGHT_IDS) {
      const e = expandFinal.lights[id];
      const f = liveDist.lights[id];
      if (!f) continue;
      const dMean = e.mean - f.mean;
      const dSd = e.sd - f.sd;
      if (Math.abs(dMean) > 0.02 || Math.abs(dSd) > 0.02) {
        console.log(
          `    ${id}: expand μ=${e.mean} σ=${e.sd}  live μ=${f.mean} σ=${f.sd}  Δμ=${dMean.toFixed(3)} Δσ=${dSd.toFixed(3)}`
        );
      }
    }
  }

  const idxOf = new Map(rows.map((r, i) => [r.date, i]));
  for (const r of rows) {
    r.fwd = {};
    const i = idxOf.get(r.date);
    for (const [hz, span] of Object.entries(HORIZONS)) {
      const j = i + span;
      if (j >= rows.length) continue;
      const out = {};
      for (const a of ASSETS) {
        const c = pctChange(r.px[a.id], rows[j].px[a.id]);
        if (c != null) out[a.id] = Number(c.toFixed(2));
      }
      if (Object.keys(out).length) r.fwd[hz] = out;
    }
  }

  const revisedOnlyEarly = ["ICSA", "CFNAI", "NFCI", "WEI"].filter(
    (id) => !vintageIds.includes(id) || (vintageStarts[id] && vintageStarts[id] > "2011-01-01")
  );

  const out = {
    generatedAt: new Date().toISOString(),
    start: rows[0]?.date || null,
    end: rows[rows.length - 1]?.date || null,
    n: rows.length,
    lights: LIGHT_IDS,
    assets: ASSETS,
    horizons: HORIZONS,
    caveats: {
      start:
        "Archive starts 2003-01-02 — first common date for DFII5/DFII10 and T5YIFR, with WALCL from 2002-12-18 and ON RRP from 2003-02-07. The 1990–2003 tier (no real yields, no breakevens, no net liquidity) is skipped on purpose.",
      funding:
        `Before ${SOFR_START}, the SOFR_SPREAD liquidity voter is EFFR minus the fed funds target top (DFEDTAR, then DFEDTARU), in bp on the same band. From ${SOFR_START} it is SOFR − target.`,
      creditVoter:
        "ICE BofA HY OAS (BAMLH0A0HYM2) is a rolling ~3-year FRED license. BAA10Y (weight 2 on Risk, from 1986) carries the credit read across the full archive; HY OAS joins when FRED has it.",
      revisions: vintageIds.length
        ? `ALFRED vintages for ${vintageIds.join(", ")}. Market-priced voters (curve, VIX, spreads, funding) are unrevised.`
        : "Economic voters are scored on revised data, not the vintage that was public on the day. Market-priced voters are unrevised.",
      vintageGaps:
        "Long vintage coverage in principle: PAYEMS (1955), UNRATE (1960), GDPC1 (1991), CPILFESL (1996-12), PCEPILFE (2000-08). This repo’s ALFRED pull currently begins around 2016 — days before that use revised history for those series. ICSA (~2009), CFNAI (~2011), NFCI (~2011) and WEI (2020) are revised-only across early 2003–2011 even with a full vintage pull." +
        (revisedOnlyEarly.length
          ? ` Currently thin/missing vintage files: ${revisedOnlyEarly.join(", ")}.`
          : ""),
      treasuries:
        "Treasury forwards are synthetic total returns from DGS5/DGS10/DGS30 (daily ≈ y/252 − D·Δy), not TLT/IEF — so the grade matches the 5s/10s/30s the strip names.",
      creditReturns:
        "HYG lists 2007-04-11. Before that, high-yield forwards use a Baa (DGS10+BAA10Y) constant-duration total-return proxy spliced into HYG. LQD covers investment-grade from 2002. Treat pre-2007 HY as model-based, not traded.",
      gold:
        "Gold forwards use Yahoo GC=F from 2000-08-30 (LBMA/FRED GOLDAMGBD228NLBM is discontinued).",
      crypto:
        "Bitcoin forwards start 2014-09-17. Crypto base rates are a thin post-2014 sample — do not read them beside multi-decade Treasury or equity rates as equals.",
    },
    rows: rows.map((r) => ({ date: r.date, s: r.s, raw: r.raw, st: r.st, fwd: r.fwd })),
  };

  const dest = path.join(ROOT, "data", "regime-history.json");
  await fs.writeFile(dest, JSON.stringify(out));
  const kb = Math.round((await fs.stat(dest)).size / 1024);
  console.log(`regime history → data/regime-history.json`);
  console.log(`  ${out.n} trading days  ${out.start} → ${out.end}  ${kb}KB`);

  const tally = {};
  for (const r of rows) {
    const k = r.st.join("/");
    tally[k] = (tally[k] || 0) + 1;
  }
  const top = Object.entries(tally)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  console.log(`  ${Object.keys(tally).length} distinct light combinations; most common:`);
  for (const [k, n] of top) console.log(`    ${String(n).padStart(4)}  ${k}`);
}

main().catch((e) => {
  console.error(`bake-history failed: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
});
