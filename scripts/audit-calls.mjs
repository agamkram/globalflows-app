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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST_FILE = path.join(ROOT, "data", "regime-history.json");
const HY_FILE = path.join(ROOT, "data", "history", "BAMLH0A0HYM2.json");

const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};

/** Parent class → archive ticker(s). Multiple tickers average into one return. */
const CLASS_ASSETS = {
  treasuries: ["UST5", "UST10", "UST30"],
  credit: ["HYG", "LQD"],
  stocks: ["SPX"],
  crypto: ["BTC"],
  gold: ["GOLD"],
  cmdty: ["WTI", "COPPER"],
};

const CLASS_ORDER = ["treasuries", "credit", "stocks", "crypto", "gold", "cmdty"];
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
const MAX_MIXED_SHARE = 0.5;

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

function classReturn(fwd, assetIds) {
  if (!fwd) return null;
  const vals = assetIds.map((id) => fwd[id]).filter(Number.isFinite);
  if (!vals.length) return null;
  return mean(vals);
}

async function loadHyAsOf() {
  try {
    const raw = JSON.parse(await fs.readFile(HY_FILE, "utf8"));
    const pts = (raw.points || [])
      .filter((p) => p?.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
    return pts;
  } catch {
    return [];
  }
}

function hySnapAsOf(hyPts, cursor, date) {
  let i = cursor;
  while (i + 1 < hyPts.length && hyPts[i + 1].date <= date) i++;
  if (!hyPts[i] || hyPts[i].date > date) return { cursor: i, series: {} };
  const latest = hyPts[i].value;
  const anchor = makeAnchor({ id: "BAMLH0A0HYM2", light: "risk", sign: -1 }, latest);
  return {
    cursor: i,
    series: {
      BAMLH0A0HYM2: {
        id: "BAMLH0A0HYM2",
        status: "ok",
        latest,
        asOf: hyPts[i].date,
        anchor,
      },
    },
  };
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

  const hyPts = await loadHyAsOf();
  let hyCursor = 0;

  // One pass: stamp each row with the six calls.
  const labeled = [];
  for (const row of hist.rows) {
    const hy = hySnapAsOf(hyPts, hyCursor, row.date);
    hyCursor = hy.cursor;
    const meaning = buildMeaning(
      { lights: lightsFromRow(row), series: hy.series },
      "1m"
    );
    const stance = Object.fromEntries(
      (meaning.favor?.items || []).map((it) => [it.id, it.stance])
    );
    labeled.push({ date: row.date, fwd: row.fwd || {}, stance });
  }

  const fails = [];
  console.log("Call audit — in / mixed / out vs forward returns");
  console.log(
    `archive ${hist.start} → ${hist.end}  n=${hist.n}  horizons ${horizons.join(", ")}`
  );
  console.log(
    `fail when: in-favor median < out-favor median (${PRIMARY_HZ}); any stance n < ${MIN_STANCE_N}; mixed share > ${Math.round(MAX_MIXED_SHARE * 100)}%\n`
  );

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
        const all = [];
        for (const r of days) {
          const ret = classReturn(r.fwd[hz], assets);
          if (ret == null) continue;
          const st = r.stance[cls];
          if (!byStance[st]) continue;
          byStance[st].push(ret);
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
          console.log(
            `      ${pad(r.st, 6)}  med ${fmtPct(r.median)}  mean ${fmtPct(r.mean)}  up ${fmtUp(r.up)}  n=${String(r.n).padStart(4)}  lift ${fmtPct(lift)}`
          );
        }

        // Loud fails — grade on the primary horizon so short noise doesn't veto.
        if (hz === PRIMARY_HZ) {
          for (const st of STANCES) {
            const n = byStance[st].length;
            if (n < MIN_STANCE_N) {
              fails.push(
                `${win.id}/${cls}: stance "${st}" has n=${n} < ${MIN_STANCE_N} (${PRIMARY_HZ})`
              );
            }
          }
          if (mixedShare > MAX_MIXED_SHARE) {
            fails.push(
              `${win.id}/${cls}: mixed ${Math.round(mixedShare * 100)}% of days > ${Math.round(MAX_MIXED_SHARE * 100)}% (${PRIMARY_HZ})`
            );
          }
          const inn = stats(byStance.in);
          const out = stats(byStance.out);
          if (inn.n >= MIN_STANCE_N && out.n >= MIN_STANCE_N && inn.median != null && out.median != null) {
            if (inn.median < out.median) {
              fails.push(
                `${win.id}/${cls}: in-favor median ${fmtPct(inn.median).trim()} underperforms out-favor ${fmtPct(out.median).trim()} (${PRIMARY_HZ})`
              );
            }
          }
        }
      }
      console.log("");
    }
  }

  if (fails.length) {
    console.log("FAIL");
    // De-dupe while keeping order
    const seen = new Set();
    for (const f of fails) {
      if (seen.has(f)) continue;
      seen.add(f);
      console.log(`  ${f}`);
    }
    process.exit(1);
  }

  console.log(
    `ok — in-favor beats out-favor on ${PRIMARY_HZ}; stance samples and mixed share clear the bar.`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
