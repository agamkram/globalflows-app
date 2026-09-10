/**
 * The forward scorecard: how the six calls actually did, graded only on days
 * the app had already published them.
 *
 * Everything else this app knows about its own accuracy is a backtest. The
 * bands, the calibration and the checklists were all fitted on the same 23
 * years the base rates are measured over, so a good number there partly
 * reflects the fitting. This is the one record that cannot flatter itself: each
 * call was written down before the outcome existed.
 *
 * The cost of that honesty is time. A month of logging is a handful of
 * overlapping observations, which is nothing. So this script refuses to print a
 * verdict until a class has enough independent windows to mean anything, and
 * says "too early" instead. An empty scorecard that admits it is empty is worth
 * more than a hit rate computed on nine days.
 *
 * Forward returns come from the archive rather than a separate price pull: a
 * call logged today is joined to its own date in data/regime-history.json and
 * picks up its one-month return once the archive has extended past it. Same
 * accounting as the backtest, via the shared mapping, so the two are directly
 * comparable.
 *
 *   npm run score:log
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLASS_ASSETS, CLASS_ORDER, CLASS_LABEL, classReturn } from "./class-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Overridable so the grading can be exercised against matured history. An
// empty scorecard proves nothing about whether the join works.
const LOG = process.env.GF_LOG || path.join(ROOT, "data", "regime-log.json");
const ARCHIVE = path.join(ROOT, "data", "regime-history.json");

const HORIZONS = ["1w", "1m", "3m"];
const HZ_SPAN_DAYS = { "1w": 7, "1m": 30, "3m": 91 };

/** Below this many independent windows a stance's return is noise, not a record. */
const MIN_INDEP = 12;

const STANCES = ["in", "mixed", "out"];

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Non-overlapping observations. Daily logging means consecutive days share
 * almost all of their forward window, so a run of 30 days at one stance is
 * roughly one observation, not 30.
 */
function independentWindows(dates, spanDays) {
  if (!dates.length) return 0;
  const sorted = [...dates].sort();
  let n = 1;
  let anchor = new Date(sorted[0]);
  for (const d of sorted.slice(1)) {
    const cur = new Date(d);
    if ((cur - anchor) / 86400000 >= spanDays) {
      n += 1;
      anchor = cur;
    }
  }
  return n;
}

function pct(v) {
  return v == null ? "   —  " : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`.padStart(6);
}

async function main() {
  const log = JSON.parse(await fs.readFile(LOG, "utf8"));
  const days = (log.days || []).filter((d) => d?.date);
  let archive;
  try {
    archive = JSON.parse(await fs.readFile(ARCHIVE, "utf8"));
  } catch {
    console.log(
      "\nForward scorecard — live calls, graded after the fact\n\n" +
        "  ok — no regime archive on disk yet. bake:history writes it; " +
        "the scorecard waits.\n"
    );
    return;
  }
  const rows = archive.rows || archive.days || [];
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const withCalls = days.filter((d) => d.calls && Object.keys(d.calls).length);
  const firstLogged = days[0]?.date ?? null;
  const firstWithCalls = withCalls[0]?.date ?? null;

  console.log("\nForward scorecard — live calls, graded after the fact\n");
  console.log(
    `  ${days.length} day(s) logged${firstLogged ? ` from ${firstLogged}` : ""}; ` +
      `${withCalls.length} carry the six calls${firstWithCalls ? ` from ${firstWithCalls}` : ""}.`
  );
  console.log(
    `  Archive reaches ${rows[rows.length - 1]?.date ?? "?"}, which is what matures the returns.\n`
  );

  if (!withCalls.length) {
    console.log("  Nothing to grade yet. The first entry with calls recorded starts the clock.\n");
    console.log("ok — scorecard empty, which is the honest state of it.\n");
    return;
  }

  let anyReadable = false;

  for (const hz of HORIZONS) {
    const span = HZ_SPAN_DAYS[hz];
    const lines = [];
    let pending = 0;
    let matured = 0;

    for (const cls of CLASS_ORDER) {
      const assets = CLASS_ASSETS[cls];
      const retByStance = { in: [], mixed: [], out: [] };
      const dateByStance = { in: [], mixed: [], out: [] };
      const all = [];

      for (const d of withCalls) {
        const stance = d.calls[cls]?.stance;
        if (!STANCES.includes(stance)) continue;
        const row = byDate.get(d.date);
        const ret = row ? classReturn(row.fwd?.[hz], assets) : null;
        if (ret == null) {
          pending += 1;
          continue;
        }
        matured += 1;
        retByStance[stance].push(ret);
        dateByStance[stance].push(d.date);
        all.push(ret);
      }

      if (!all.length) continue;
      const base = median(all);
      const parts = STANCES.map((s) => {
        const n = retByStance[s].length;
        const indep = independentWindows(dateByStance[s], span);
        const med = median(retByStance[s]);
        return { s, n, indep, med, lift: med == null || base == null ? null : med - base };
      });
      const readable = parts.some((p) => p.indep >= MIN_INDEP);
      if (readable) anyReadable = true;
      lines.push({ cls, base, parts, readable });
    }

    console.log(`  ── ${hz} horizon ──`);
    if (!lines.length) {
      console.log(
        `     no call has aged ${span} days yet (${pending} waiting).\n`
      );
      continue;
    }
    for (const l of lines) {
      console.log(
        `     ${CLASS_LABEL[l.cls].padEnd(11)} base ${pct(l.base)} median` +
          (l.readable ? "" : "   [too early to read]")
      );
      for (const p of l.parts) {
        if (!p.n) continue;
        console.log(
          `       ${p.s.padEnd(6)} med ${pct(p.med)}  lift ${pct(p.lift)}  ` +
            `days ${String(p.n).padStart(4)}  indep ${String(p.indep).padStart(3)}`
        );
      }
    }
    console.log(`     ${matured} call-day(s) matured, ${pending} still waiting.\n`);
  }

  if (!anyReadable) {
    console.log(
      `  Every class is still under ${MIN_INDEP} independent windows, so none of the\n` +
        "  numbers above are evidence yet. They are shown so the record is visible\n" +
        "  while it accumulates, not so they can be quoted.\n"
    );
  }
  console.log("ok — forward record read; it grades only what was published in advance.\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
