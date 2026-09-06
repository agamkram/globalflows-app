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
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeAnchor, anchorKind, LIGHT_IDS } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HIST = path.join(ROOT, "data", "history");

const SINCE = "2015-01-01";
const PIN_WARN = 0.5; // flag a voter pinned on more than half the days
const FLAT_WARN = 0.15; // flag a voter whose score barely moves

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

async function main() {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, "data", "catalog.json"), "utf8"));
  const voters = catalog.series.filter((s) => s.light);

  // Real-rate voters are scored as nominal minus core PCE, so they need the
  // inflation series aligned alongside their own.
  const core = await readPoints("PCEPILFE");
  const coreAt = (date) => {
    if (!core) return null;
    const f = core.filter((p) => p.date <= date).pop();
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
