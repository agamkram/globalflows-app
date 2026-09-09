#!/usr/bin/env node
/**
 * Grade the six asset-class calls against forward returns in the archive.
 *
 * npm run sanity only proves the bake matches the recomputed math. This script
 * asks whether "in favor" actually beat "out of favor" — and fails loudly when
 * it does not, when a stance has too few days, or when mixed eats the strip.
 *
 * Requires data/regime-history.json (npm run bake:history). Replays meaning.js
 * from each day's light states (same path as the live strip). Series that only
 * nudge needles or wording are left empty; hy cycle-tights use as-of HY OAS
 * when history is present.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeaning } from "../meaning.js";
import { LIGHT_IDS, makeAnchor } from "../score.js";
import { loadValCenter } from "./load-val-center.mjs";
import { CLASS_ASSETS, CLASS_ORDER, classReturn } from "./class-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST_FILE = path.join(ROOT, "data", "regime-history.json");
const HIST_DIR = path.join(ROOT, "data", "history");

/** Series meaning.js reads for valuation / term premium / dollar / HY tights. */
const SUPPORT_IDS = [
  "BAMLH0A0HYM2",
  "BAA10Y",
  "THREEFFTP10",
  "DFII10",
  "DFII5",
  "DOLLAR_YOY",
  "DTWEXBGS",
  "WTI",
  "DGS10",
  "CREDIT_IMPULSE",
  "SPX_EY",
  "EQUITY_ERP",
  "CHINA_CREDIT_IMPULSE",
  "CHINA_CREDIT_GDP",
  "GOLD_COT",
];

const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};

/** Parent class → archive ticker(s). Multiple tickers average into one return. */
const STANCES = ["in", "mixed", "out"];

/** Windows the harness always prints. COVID = Feb–Jun 2020. */
const WINDOWS = [
  { id: "full", label: "full sample", keep: () => true },
  {
    id: "ex-COVID",
    label: "ex-COVID (drop Feb–Jun 2020)",
    keep: (d) => d < "2020-02-01" || d > "2020-06-30",
  },
  { id: "pre-2020", label: "pre-2020", keep: (d) => d < "2020-01-01" },
  { id: "2021+", label: "2021+", keep: (d) => d >= "2021-01-01" },
  { id: "2023+", label: "2023+", keep: (d) => d >= "2023-01-01" },
];

/** Primary grade horizon — one month matches the evidence that opened this work. */
const PRIMARY_HZ = "1m";
const MIN_STANCE_N = 50;
const MIN_INDEP_WINDOWS = 12;
/** Calendar days each horizon's forward return spans, for overlap counting. */
const HZ_SPAN_DAYS = { "1w": 7, "2w": 14, "1m": 30, "3m": 91, "6m": 182, "12m": 365 };

/**
 * Days are not trials. A stance held across 58 consecutive days and graded on a
 * one-month forward return is about two independent bets on one episode, not 58
 * — every window overlaps almost entirely with its neighbours. Counting days
 * let a single stretch clear a sample-size gate of 50 and then fail the median
 * comparison as though it were evidence, which is how a 26bp gap on one 2023
 * commodity episode came to look like a broken signal.
 *
 * Greedy non-overlapping count: take a window, skip everything it covers.
 */
function independentWindows(dates, hz) {
  const span = (HZ_SPAN_DAYS[hz] || 30) * 86400000;
  let n = 0;
  let free = -Infinity;
  for (const d of [...dates].sort()) {
    const t = Date.parse(d);
    if (t >= free) {
      n++;
      free = t + span;
    }
  }
  return n;
}
const MAX_MIXED_SHARE = 0.5;
/** Soft (warn, not fail) when the window cannot discriminate: too few days,
 *  one-way returns, or an in/out call that never printed. Window names do not
 *  get a free pass — 2021+ has ~1,400 days and can fail. */
const SOFT_MIN_DAYS = 400;
const ONE_WAY_UP = 0.95;
/** Fail inversion only when the gap is larger than noise on a 1m median. */
const INV_TOL = 0.1;

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stats(vals) {
  if (!vals.length) return { n: 0, median: null, mean: null, up: null };
  return {
    n: vals.length,
    median: median(vals),
    mean: mean(vals),
    up: vals.filter((v) => v > 0).length / vals.length,
  };
}

function fmtPct(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "   —  ";
  const s = n.toFixed(d);
  return (n > 0 ? "+" : "") + s + "%";
}

function fmtUp(n) {
  if (n == null || !Number.isFinite(n)) return "  — ";
  return String(Math.round(n * 100)).padStart(3) + "%";
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function lightsFromRow(row) {
  const lights = {};
  LIGHT_IDS.forEach((id, i) => {
    const state = row.st[i];
    lights[id] = {
      state,
      word: WORD[id][state],
      words: WORD[id],
      score: row.s[i],
      // Stance comes from levels. Flat lookback matches a pure checklist grade.
      impulse: { dir: "flat", score: 0 },
    };
  });
  return lights;
}


async function loadPoints(id) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(HIST_DIR, `${id}.json`), "utf8"));
    return (raw.points || [])
      .filter((p) => p?.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function supportSnapAsOf(seriesPts, cursors, date) {
  const series = {};
  for (const id of SUPPORT_IDS) {
    const pts = seriesPts[id];
    if (!pts?.length) continue;
    let i = cursors[id] || 0;
    while (i + 1 < pts.length && pts[i + 1].date <= date) i++;
    cursors[id] = i;
    if (!pts[i] || pts[i].date > date) continue;
    const latest = pts[i].value;
    const anchor = makeAnchor({ id, sign: -1 }, latest);
    series[id] = {
      id,
      status: "ok",
      latest,
      asOf: pts[i].date,
      anchor,
    };
  }
  return series;
}

function inWindow(row, win, hz) {
  if (!win.keep(row.date)) return false;
  return row.fwd?.[hz] != null;
}

async function main() {
  let hist;
  try {
    hist = JSON.parse(await fs.readFile(HIST_FILE, "utf8"));
  } catch {
    console.error("audit:calls needs data/regime-history.json — run npm run bake:history");
    process.exit(1);
  }

  const horizons = Object.keys(hist.horizons || { "1m": 21 });
  if (!horizons.includes(PRIMARY_HZ)) {
    console.error(`archive has no ${PRIMARY_HZ} forwards`);
    process.exit(1);
  }

  const seriesPts = {};
  for (const id of SUPPORT_IDS) seriesPts[id] = await loadPoints(id);
  const cursors = {};
  let valCenter = null;
  try {
    valCenter = await loadValCenter();
  } catch {
    /* defaults in meaning.js */
  }

  // One pass: stamp each row with the six calls.
  const labeled = [];
  const valCover = {
    EQUITY_ERP: { first: null, n: 0 },
    SPX_EY: { first: null, n: 0 },
    DFII10: { first: null, n: 0 },
    erpFallback: 0,
  };
  for (const row of hist.rows) {
    const series = supportSnapAsOf(seriesPts, cursors, row.date);
    for (const id of ["EQUITY_ERP", "SPX_EY", "DFII10"]) {
      if (series[id]) {
        valCover[id].n++;
        if (!valCover[id].first) valCover[id].first = series[id].asOf;
      }
    }
    if (!series.EQUITY_ERP && (series.SPX_EY || series.DFII10)) valCover.erpFallback++;
    const meaning = buildMeaning(
      {
        lights: lightsFromRow(row),
        series,
        valCenter,
      },
      "1m"
    );
    const stance = Object.fromEntries(
      (meaning.favor?.items || []).map((it) => [it.id, it.stance])
    );
    labeled.push({ date: row.date, fwd: row.fwd || {}, stance });
  }

  const fails = [];
  const warns = [];
  console.log("Call audit — in / mixed / out vs forward returns");
  console.log(
    `archive ${hist.start} → ${hist.end}  n=${hist.n}  horizons ${horizons.join(", ")}`
  );
  console.log(
    `fail when: in-favor median < out-favor median by more than ${INV_TOL}% (${PRIMARY_HZ}); any stance n < ${MIN_STANCE_N}; mixed share > ${Math.round(MAX_MIXED_SHARE * 100)}% unless in still beats out`
  );
  console.log(
    `warn (not fail) when the window cannot discriminate (<${SOFT_MIN_DAYS} days, one-way returns ≥${Math.round(ONE_WAY_UP * 100)}% in one direction, an in/out call with n < ${MIN_STANCE_N} or fewer than ${MIN_INDEP_WINDOWS} non-overlapping windows, or the class misses the first ${SOFT_MIN_DAYS} days of the window)`
  );
  const nRows = hist.rows?.length || 1;
  console.log(
    `valuation live: EQUITY_ERP ${valCover.EQUITY_ERP.n}/${nRows} (from ${valCover.EQUITY_ERP.first || "—"})` +
      `  SPX_EY ${valCover.SPX_EY.n}/${nRows}  DFII10 ${valCover.DFII10.n}/${nRows}` +
      (valCover.erpFallback
        ? `  erp-fallback days ${valCover.erpFallback}`
        : "  erp-fallback days 0")
  );
  console.log("");

  for (const win of WINDOWS) {
    console.log(`══ ${win.label} ══`);

    for (const hz of horizons) {
      const days = labeled.filter((r) => inWindow(r, win, hz));
      if (days.length < 30) {
        console.log(`  ${hz}: too thin (${days.length} days) — skip`);
        continue;
      }

      console.log(`  horizon ${hz}  (${days.length} days with forwards)`);

      for (const cls of CLASS_ORDER) {
        const assets = CLASS_ASSETS[cls];
        const byStance = { in: [], mixed: [], out: [] };
        const datesByStance = { in: [], mixed: [], out: [] };
        const all = [];
        for (const r of days) {
          const ret = classReturn(r.fwd[hz], assets);
          if (ret == null) continue;
          const st = r.stance[cls];
          if (!byStance[st]) continue;
          byStance[st].push(ret);
          datesByStance[st].push(r.date);
          all.push(ret);
        }

        const base = stats(all);
        const rows = STANCES.map((st) => ({ st, ...stats(byStance[st]) }));
        const totalN = rows.reduce((a, r) => a + r.n, 0);
        const mixedShare = totalN ? rows.find((r) => r.st === "mixed").n / totalN : 0;

        console.log(
          `    ${pad(cls, 11)}  base ${fmtPct(base.median)} median  ${fmtUp(base.up)} up  n=${base.n}`
        );
        for (const r of rows) {
          const lift =
            r.median != null && base.median != null
              ? r.median - base.median
              : null;
          const eff = independentWindows(datesByStance[r.st], hz);
          console.log(
            `      ${pad(r.st, 6)}  med ${fmtPct(r.median)}  mean ${fmtPct(r.mean)}  up ${fmtUp(r.up)}  n=${String(r.n).padStart(4)}` +
              `  indep ${String(eff).padStart(3)}  lift ${fmtPct(lift)}`
          );
        }

        // Loud fails — grade on the primary horizon so short noise doesn't veto.
        // Short / one-way windows warn instead: they cannot discriminate.
        if (hz === PRIMARY_HZ) {
          const innN = byStance.in.length;
          const outN = byStance.out.length;
          const effIn = independentWindows(datesByStance.in, hz);
          const effOut = independentWindows(datesByStance.out, hz);
          const oneWay =
            base.up != null && (base.up >= ONE_WAY_UP || base.up <= 1 - ONE_WAY_UP);
          const winFrom = labeled.find((r) => win.keep(r.date))?.date;
          const coverFrom = days.find((r) => classReturn(r.fwd[hz], assets) != null)?.date;
          const lateCover =
            coverFrom &&
            winFrom &&
            Date.parse(coverFrom) - Date.parse(winFrom) > SOFT_MIN_DAYS * 86400000;
          const soft =
            days.length < SOFT_MIN_DAYS ||
            oneWay ||
            innN < MIN_STANCE_N ||
            outN < MIN_STANCE_N ||
            effIn < MIN_INDEP_WINDOWS ||
            effOut < MIN_INDEP_WINDOWS ||
            lateCover;
          const bucket = soft ? warns : fails;
          const inn = stats(byStance.in);
          const out = stats(byStance.out);
          for (const st of STANCES) {
            const n = byStance[st].length;
            if (n < MIN_STANCE_N) {
              bucket.push(
                `${win.id}/${cls}: stance "${st}" has n=${n} < ${MIN_STANCE_N} (${PRIMARY_HZ})`
              );
            }
          }
          if (mixedShare > MAX_MIXED_SHARE) {
            const tailsWork =
              innN >= MIN_STANCE_N &&
              outN >= MIN_STANCE_N &&
              inn.median != null &&
              out.median != null &&
              inn.median + INV_TOL >= out.median;
            (tailsWork ? warns : bucket).push(
              `${win.id}/${cls}: mixed ${Math.round(mixedShare * 100)}% of days > ${Math.round(MAX_MIXED_SHARE * 100)}% (${PRIMARY_HZ})`
            );
          }
          if (inn.n >= MIN_STANCE_N && out.n >= MIN_STANCE_N && inn.median != null && out.median != null) {
            if (inn.median + INV_TOL < out.median) {
              bucket.push(
                `${win.id}/${cls}: in-favor median ${fmtPct(inn.median).trim()} underperforms out-favor ${fmtPct(out.median).trim()} (${PRIMARY_HZ})`
              );
            }
          }
        }
      }
      console.log("");
    }
  }

  const uniq = (arr) => {
    const seen = new Set();
    const out = [];
    for (const f of arr) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(f);
    }
    return out;
  };
  const warnList = uniq(warns);
  const failList = uniq(fails);
  if (warnList.length) {
    console.log("WARN");
    for (const w of warnList) console.log(`  ${w}`);
  }
  if (failList.length) {
    console.log("FAIL");
    for (const f of failList) console.log(`  ${f}`);
    process.exit(1);
  }
  console.log(warnList.length ? "ok — real regressions clear (short-window warnings above)" : "ok — in-favor beats out-favor on 1m; stance samples and mixed share clear the bar.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
