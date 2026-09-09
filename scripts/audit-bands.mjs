/**
 * Audit every level band against the history it is supposed to score.
 *
 * A band fails quietly. Nothing throws, the light still lights, and the number
 * looks plausible — but if the series has drifted outside the band, the voter
 * returns the same ±1 every day and the light is a constant wearing the costume
 * of a signal. Reverse repo did this for two years and NFCI for a decade before
 * anyone noticed.
 *
 * Run this whenever a band changes. It reports, per voter:
 *   pinned   share of days the score sat at exactly +1 or -1
 *   spread   standard deviation of the score — a voter that never moves is furniture
 *   cover    whether the series reaches back far enough to be scored at all
 *
 * A voter pinned on most days is not necessarily wrong — spreads genuinely sit at
 * the calm end for long stretches — but it cannot distinguish degrees while it is
 * there, and a light built mostly from pinned voters cannot move.
 *
 * After the voters, LIGHT COMPOSITES checks the five lights themselves: colour
 * mix and composite sd over the archive, plus each family ballot's sd. Family
 * averaging can compress a light onto amber while every member still looks fine.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeAnchor,
  anchorKind,
  LIGHT_IDS,
  VOTE_FAMILIES,
  familyIds,
  lightStateFromScore,
  weightedMean,
} from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST = path.join(ROOT, "data", "history");
const REGIME_HIST = path.join(ROOT, "data", "regime-history.json");

const SINCE = "2015-01-01";
const LIGHT_SINCE = "2003-01-01";
const PIN_WARN = 0.5; // flag a voter pinned on more than half the days
const FLAT_WARN = 0.15; // flag a voter whose score barely moves
const AMBER_WARN = 0.6; // light stuck amber most days — scale or voters too quiet
const QUIET_SD_FRAC = 0.75; // flag light sd more than ~25% below the median light

/**
 * A voter measured over a short window is measured over one regime, and one
 * regime pins almost any band. Flags below this much coverage describe the sample,
 * not the band, and are reported as such.
 */
const SHORT_WINDOW_YEARS = 5;

async function readPoints(id) {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HIST, `${id}.json`), "utf8"));
    return (j.points || [])
      .filter((p) => p && p.date && Number.isFinite(p.value))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return null;
  }
}

function stdev(a) {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((acc, v) => acc + (v - m) ** 2, 0) / a.length);
}

function pad(s, n) {
  return String(s).padEnd(n);
}

function asof(pts, date) {
  if (!pts?.length) return null;
  let lo = 0;
  let hi = pts.length - 1;
  if (pts[0].date > date) return null;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pts[mid].date <= date) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo];
}

async function auditLightComposites(catalog, coreAt, problems) {
  let hist;
  try {
    hist = JSON.parse(await fs.readFile(REGIME_HIST, "utf8"));
  } catch {
    console.log("LIGHT COMPOSITES — no data/regime-history.json (run bake:history)\n");
    return;
  }
  const rows = (hist.rows || []).filter((r) => r.date >= LIGHT_SINCE);
  if (rows.length < 30) {
    console.log("LIGHT COMPOSITES — regime history too thin\n");
    return;
  }

  console.log(`LIGHT COMPOSITES — calibrated scores from ${LIGHT_SINCE} (${rows.length} days)\n`);

  // Quietness is judged on the raw (pre-calibrate) archive — after C3 every
  // light’s calibrated sd matches by construction.
  const RAW_SD = {
    liquidity: 0.6015,
    rates: 0.5627,
    growth: 0.445,
    inflation: 0.4707,
    risk: 0.5307,
  };
  const rawSds = LIGHT_IDS.map((id) => RAW_SD[id]).sort((a, b) => a - b);
  const medianRawSd = rawSds[Math.floor(rawSds.length / 2)];

  const byLight = {};
  for (let i = 0; i < LIGHT_IDS.length; i++) {
    const vals = rows.map((r) => r.s[i]).filter(Number.isFinite);
    const green = vals.filter((v) => lightStateFromScore(v).state === "easing").length / vals.length;
    const amber = vals.filter((v) => lightStateFromScore(v).state === "neutral").length / vals.length;
    const red = vals.filter((v) => lightStateFromScore(v).state === "tight").length / vals.length;
    byLight[LIGHT_IDS[i]] = {
      green,
      amber,
      red,
      sd: stdev(vals),
      rawSd: RAW_SD[LIGHT_IDS[i]],
      n: vals.length,
    };
  }
  // Family ballot sds: weekly asof over the same window (raw voter scale).
  const specById = Object.fromEntries(catalog.series.map((s) => [s.id, s]));
  const scoreCache = new Map();

  async function scoreSeries(id) {
    if (scoreCache.has(id)) return scoreCache.get(id);
    const pts = await readPoints(id);
    const spec = specById[id];
    if (!pts || !spec) {
      scoreCache.set(id, null);
      return null;
    }
    const kind = anchorKind(id);
    const isReal = kind === "pending_real";
    const scored = [];
    for (const p of pts) {
      if (p.date < LIGHT_SINCE) continue;
      let a;
      if (isReal) {
        const c = coreAt(p.date);
        if (c == null) continue;
        a = makeAnchor({ ...spec, anchorKind: "real_rate" }, p.value - c);
      } else {
        a = makeAnchor(spec, p.value);
      }
      if (a.score != null && Number.isFinite(a.score)) scored.push({ date: p.date, score: a.score });
    }
    scoreCache.set(id, scored);
    return scored;
  }

  const weekDates = rows.filter((_, i) => i % 5 === 0).map((r) => r.date);

  for (const lid of LIGHT_IDS) {
    const L = byLight[lid];
    const flags = [];
    if (L.amber > AMBER_WARN) flags.push(`AMBER ${Math.round(L.amber * 100)}%`);
    if (medianRawSd > 0 && L.rawSd < QUIET_SD_FRAC * medianRawSd) {
      flags.push(`QUIET raw-sd=${L.rawSd.toFixed(3)} (median ${medianRawSd.toFixed(3)})`);
    }
    if (flags.length) {
      problems.push(`${lid} light: ${flags.join(", ")} over full sample`);
    }
    console.log(
      `  ${pad(lid.toUpperCase(), 10)}` +
        ` green ${pad(Math.round(L.green * 100) + "%", 4)}` +
        ` amber ${pad(Math.round(L.amber * 100) + "%", 4)}` +
        ` red ${pad(Math.round(L.red * 100) + "%", 4)}` +
        `  sd ${L.sd.toFixed(3)}  raw-sd ${L.rawSd.toFixed(3)}` +
        (flags.length ? `   <-- ${flags.join(" ")}` : "")
    );

    const fams = VOTE_FAMILIES[lid] || {};
    for (const [fname, raw] of Object.entries(fams)) {
      const ids = familyIds(raw);
      const series = [];
      for (const id of ids) series.push(await scoreSeries(id));
      const ballot = [];
      for (const d of weekDates) {
        const members = [];
        for (let i = 0; i < ids.length; i++) {
          const pts = series[i];
          if (!pts) continue;
          const hit = asof(pts, d);
          if (hit) members.push({ score: hit.score, weight: 1 });
        }
        const fam = weightedMean(members);
        if (fam != null) ballot.push(fam);
      }
      if (ballot.length < 30) {
        console.log(`    family:${pad(fname, 12)} thin (${ballot.length} weeks)`);
        continue;
      }
      console.log(`    family:${pad(fname, 12)} sd ${stdev(ballot).toFixed(3)}  n=${ballot.length}`);
    }
  }
  console.log("");
}

async function main() {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, "data", "catalog.json"), "utf8"));
  const voters = catalog.series.filter((s) => s.light);

  // Real-rate voters are scored as nominal minus core PCE, so they need the
  // inflation series aligned alongside their own.
  const core = await readPoints("PCEPILFE");
  const coreAt = (date) => {
    const f = asof(core, date);
    return f ? f.value : null;
  };

  const problems = [];
  console.log(`Band audit — scores computed from ${SINCE}\n`);

  for (const lid of LIGHT_IDS) {
    const members = voters.filter((s) => s.light === lid);
    console.log(`${lid.toUpperCase()}  (${members.length} level voters)`);

    let pinnedVoters = 0;
    for (const spec of members) {
      const pts = await readPoints(spec.id);
      if (!pts) {
        console.log(`  ${pad(spec.id, 16)} no history on disk`);
        problems.push(`${lid}/${spec.id}: no history`);
        continue;
      }
      const kind = anchorKind(spec.id);
      const isReal = kind === "pending_real";
      const use = pts.filter((p) => p.date >= SINCE);
      if (use.length < 30) {
        console.log(`  ${pad(spec.id, 16)} only ${use.length} points since ${SINCE.slice(0, 4)}`);
        problems.push(`${lid}/${spec.id}: thin coverage (${use.length})`);
        continue;
      }

      const scores = [];
      for (const p of use) {
        let a;
        if (isReal) {
          const c = coreAt(p.date);
          if (c == null) continue;
          a = makeAnchor({ ...spec, anchorKind: "real_rate" }, p.value - c);
        } else {
          a = makeAnchor(spec, p.value);
        }
        if (a.score != null && Number.isFinite(a.score)) scores.push(a.score);
      }
      if (!scores.length) {
        console.log(`  ${pad(spec.id, 16)} scores to nothing — no band for kind "${kind}"`);
        problems.push(`${lid}/${spec.id}: no band`);
        continue;
      }

      const hi = scores.filter((s) => s >= 0.999).length / scores.length;
      const lo = scores.filter((s) => s <= -0.999).length / scores.length;
      const pinned = hi + lo;
      const sd = stdev(scores);
      const now = scores[scores.length - 1];

      const years =
        (Date.parse(use[use.length - 1].date) - Date.parse(use[0].date)) / (365.25 * 86400000);
      const short = years < SHORT_WINDOW_YEARS;

      const flags = [];
      if (pinned > PIN_WARN) flags.push(`PINNED ${Math.round(pinned * 100)}%`);
      if (sd < FLAT_WARN) flags.push(`FLAT sd=${sd.toFixed(2)}`);
      if (flags.length) {
        if (short) {
          problems.push(
            `${lid}/${spec.id}: ${flags.join(", ")} but only ${years.toFixed(1)}y of history ` +
              `(from ${use[0].date}) — likely a truncated-data artifact, not a bad band`
          );
        } else {
          pinnedVoters++;
          problems.push(
            `${lid}/${spec.id}: ${flags.join(", ")} over ${years.toFixed(1)}y ` +
              `(${Math.round(hi * 100)}% at ceiling, ${Math.round(lo * 100)}% at floor)`
          );
        }
      }

      console.log(
        `  ${pad(spec.id, 16)} pinned ${pad(Math.round(pinned * 100) + "%", 5)}` +
          ` (ceil ${pad(Math.round(hi * 100) + "%", 5)} floor ${pad(Math.round(lo * 100) + "%", 5)})` +
          ` sd ${sd.toFixed(2)}  now ${pad((now >= 0 ? "+" : "") + now.toFixed(2), 6)}` +
          ` ${years.toFixed(1)}y` +
          (flags.length ? `   <-- ${flags.join(" ")}${short ? " (short window)" : ""}` : "")
      );
    }
    if (members.length && pinnedVoters >= Math.ceil(members.length / 2)) {
      problems.push(
        `${lid}: ${pinnedVoters} of ${members.length} voters are pinned or flat — this light struggles to move`
      );
    }
    console.log("");
  }

  await auditLightComposites(catalog, coreAt, problems);

  if (!problems.length) {
    console.log("No band problems found.");
    return;
  }
  console.log(`${problems.length} thing(s) to look at:`);
  for (const p of problems) console.log(`  - ${p}`);
}

main().catch((e) => {
  console.error(`audit-bands failed: ${e.message}`);
  process.exit(1);
});
