/**
 * Replay the light model over stored history so the app can answer "when did it
 * look like this before, and what happened next".
 *
 * This is the same code path the live bake uses — makeAnchor, applyRealRateAnchors
 * and buildLights are imported, not reimplemented — so an analog is scored exactly
 * the way today is scored. Two honest limits are recorded in the output and shown
 * in the UI:
 *
 *  - FRED serves revised data, not vintages. A CPI or payroll print scored here is
 *    the number we know now, not the number the market traded on that morning. The
 *    market-priced voters (SOFR, curve, VIX, spreads) are unrevised.
 *  - The record starts in April 2018 because that is where SOFR starts. Beginning
 *    earlier would change the liquidity light's voter composition partway through
 *    and make early analogs incomparable to late ones.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAnchor, applyRealRateAnchors, buildLights, LIGHT_IDS } from "../score.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HIST = path.join(ROOT, "data", "history");

const START = "2018-04-02"; // first SOFR print
const STALE_DAYS = 400;
const HORIZONS = { "1m": 21, "3m": 63, "6m": 126 };

/**
 * Assets we measure forward through. Bonds are ETFs rather than yields, measured
 * on adjusted closes so a coupon counts as the return it is — the raw price of a
 * bond fund drifts down as it pays out, which made every duration and credit
 * base rate look worse than the trade actually was.
 */
const ASSETS = [
  { id: "SPX", name: "S&P 500" },
  { id: "TLT", name: "Long Treasuries" },
  { id: "IEF", name: "7–10y Treasuries" },
  { id: "HYG", name: "High yield" },
  { id: "LQD", name: "Investment grade" },
  { id: "GOLD", name: "Gold" },
  { id: "DXY", name: "Dollar" },
  { id: "COPPER", name: "Copper" },
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

async function main() {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, "data", "catalog.json"), "utf8"));

  // Every series that casts a level vote, plus core PCE which the real-rate anchors need.
  const voters = catalog.series.filter((s) => s.light);
  const needed = [...new Set([...voters.map((s) => s.id), "PCEPILFE"])];

  const hist = {};
  for (const id of needed) {
    const p = await readHistory(id);
    if (p) hist[id] = p;
  }
  const missing = needed.filter((id) => !hist[id]);
  if (missing.length) console.log(`  no history for: ${missing.join(", ")}`);

  // A voter whose history starts after the archive does silently changes a light's
  // composition partway through the record, which makes early analogs incomparable
  // to late ones. FRED's unauthenticated CSV truncates the ICE BofA spreads to
  // three years, so this fires unless FRED_API_KEY is set at ingest.
  const shortCoverage = voters
    .filter((s) => hist[s.id] && hist[s.id][0].date > START)
    .map((s) => `${s.id} (${s.light}, from ${hist[s.id][0].date})`);
  if (shortCoverage.length) {
    console.log(`  ! voters that do not cover ${START}:`);
    for (const s of shortCoverage) console.log(`      ${s}`);
    console.log(`    lights above lose these voters early in the record.`);
  }

  const assetHist = {};
  for (const a of ASSETS) {
    const p = await readHistory(a.id);
    if (p) assetHist[a.id] = p;
  }

  // Trading-day grid from the deepest equity series.
  const grid = (assetHist.SPX || []).map((p) => p.date).filter((d) => d >= START);
  if (grid.length < 500) throw new Error(`grid too short (${grid.length})`);

  const cursors = {};
  const assetCursors = {};
  const rows = [];

  for (const date of grid) {
    const series = {};
    for (const spec of voters) {
      const pts = hist[spec.id];
      if (!pts) continue;
      const got = asOf(pts, cursors[spec.id] || 0, date);
      cursors[spec.id] = got.i;
      if (got.value == null) continue;
      series[spec.id] = {
        id: spec.id,
        light: spec.light,
        weight: spec.weight || 1,
        status: "ok",
        latest: got.value,
        anchor: makeAnchor(spec, got.value),
      };
    }
    // Real-rate anchors read core PCE off the same as-of date.
    const pce = hist.PCEPILFE ? asOf(hist.PCEPILFE, cursors.PCEPILFE || 0, date) : { value: null };
    if (hist.PCEPILFE) cursors.PCEPILFE = pce.i;
    if (pce.value != null) {
      series.PCEPILFE = series.PCEPILFE || {
        id: "PCEPILFE",
        status: "ok",
        latest: pce.value,
        anchor: { kind: "pce_yoy", score: null, why: "", votes: false },
      };
      applyRealRateAnchors(series);
    }

    const lights = buildLights({ series, lightsMeta: catalog.lights });
    const scores = LIGHT_IDS.map((id) => lights[id]?.score);
    if (scores.some((s) => s == null || !Number.isFinite(s))) continue;

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
      st: LIGHT_IDS.map((id) => lights[id].state),
      px: prices,
    });
  }

  // Forward returns, measured on the same trading-day grid.
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

  const out = {
    generatedAt: new Date().toISOString(),
    start: rows[0]?.date || null,
    end: rows[rows.length - 1]?.date || null,
    n: rows.length,
    lights: LIGHT_IDS,
    assets: ASSETS,
    horizons: HORIZONS,
    caveats: {
      revisions:
        "Economic voters are scored on revised data, not the vintage that was public on the day. Market-priced voters are unrevised.",
      start:
        "The record starts at the first SOFR print so the liquidity light has the same three voters throughout.",
    },
    rows: rows.map((r) => ({ date: r.date, s: r.s, st: r.st, fwd: r.fwd })),
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
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 6);
  console.log(`  ${Object.keys(tally).length} distinct light combinations; most common:`);
  for (const [k, n] of top) console.log(`    ${String(n).padStart(4)}  ${k}`);
}

main().catch((e) => {
  console.error(`bake-history failed: ${e.message}`);
  process.exit(1);
});
