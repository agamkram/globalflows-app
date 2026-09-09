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
  trailingNorm,
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
const AMBER_CLIFF = 0.45; // score at which a light leaves amber
const AMBER_EXCESS_WARN = 0.05; // amber share this far over its own implied floor

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf). */
function normalCdf(z) {
  const s = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 + s * erf);
}
const ONEWAY_MIN = 0.08; // a colour reached on fewer days than this is not a call
const SKEW_MAX = 3; // green:red (or red:green) beyond this describes an era
/** A pinned valuation centre this one-sided has stopped separating days. */
const VAL_ONESIDE_MIN = 0.1;
const CENTRE_SPAN_MIN = 0.8; // a valuation centre must span this much of the replay
const QUIET_SD_FRAC = 0.75; // flag light sd more than ~25% below the median light
const OUT_SD_TOL = 0.05; // calibrated output sds must match — else ±0.45 is a different percentile
const CALIB_SKIP = 252; // first year of archive is raw, before expanding-window calib
const VAL_MEAN_TOL = 0.08;

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

async function auditLightComposites(catalog, coreAt, problems, fails) {
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

  let stored = null;
  try {
    stored = JSON.parse(await fs.readFile(path.join(ROOT, "data", "light-dist.json"), "utf8"));
  } catch {
    fails.push("light-dist.json missing — run npm run calibrate:lights");
  }

  const withRaw = rows.filter((r) => Array.isArray(r.raw) && r.raw.length === LIGHT_IDS.length);
  console.log(
    `LIGHT COMPOSITES — calibrated scores from ${LIGHT_SINCE} (${rows.length} days` +
      (withRaw.length ? `; ${withRaw.length} with raw` : "; no raw — rebake for drift check") +
      ")\n"
  );

  // Drift check: archive raw mean/sd vs stored LIGHT_DIST (ingest freeze for lights).
  const MEAN_TOL = 0.03;
  const SD_TOL = 0.03;
  if (stored?.lights && withRaw.length >= 252) {
    for (let i = 0; i < LIGHT_IDS.length; i++) {
      const lid = LIGHT_IDS[i];
      const vals = withRaw.map((r) => r.raw[i]).filter(Number.isFinite);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const sd = stdev(vals);
      const expect = stored.lights[lid];
      if (!expect) continue;
      const flags = [];
      if (Math.abs(mean - expect.mean) > MEAN_TOL) {
        flags.push(`mean ${mean.toFixed(4)} vs stored ${expect.mean} (tol ${MEAN_TOL})`);
      }
      if (Math.abs(sd - expect.sd) > SD_TOL) {
        flags.push(`sd ${sd.toFixed(4)} vs stored ${expect.sd} (tol ${SD_TOL})`);
      }
      if (flags.length) {
        fails.push(`${lid} LIGHT_DIST drift: ${flags.join("; ")} — run calibrate:lights`);
      }
    }
  } else if (stored && withRaw.length < 252) {
    fails.push(
      "light composites: archive has no row.raw — rebake history so drift vs LIGHT_DIST can be checked"
    );
  }

  // Quietness is judged on the stored raw centres — after C3 calibrated sds match.
  const RAW_SD = Object.fromEntries(
    LIGHT_IDS.map((id) => [id, stored?.lights?.[id]?.sd ?? 0.5])
  );
  const rawSds = LIGHT_IDS.map((id) => RAW_SD[id]).sort((a, b) => a - b);
  const medianRawSd = rawSds[Math.floor(rawSds.length / 2)];

  const scored = rows.length > CALIB_SKIP ? rows.slice(CALIB_SKIP) : rows;
  const byLight = {};
  for (let i = 0; i < LIGHT_IDS.length; i++) {
    const vals = scored.map((r) => r.s[i]).filter(Number.isFinite);
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
  // A light can carry the right spread and still describe the calendar rather
  // than the world. Liquidity was green 58% and red 1% across a window holding
  // the GFC, the 2019 repo squeeze and the 2022 QT: correct sd, correct centre
  // drift, and it called every crisis after 2008 ample. What gave it away was
  // the count of red days, which nothing was checking. A light that almost never
  // reaches one colour has that colour in name only.
  for (const lid of LIGHT_IDS) {
    const { green, red } = byLight[lid];
    const one = Math.min(green, red);
    const other = Math.max(green, red);
    const thin = green < red ? "green" : "red";
    if (one < ONEWAY_MIN) {
      fails.push(
        `${lid} light reaches ${thin} on ${(one * 100).toFixed(0)}% of days ` +
          `(min ${(ONEWAY_MIN * 100).toFixed(0)}%) — that colour is decoration, not a call`
      );
    } else if (other > one * SKEW_MAX) {
      fails.push(
        `${lid} light is ${(other / one).toFixed(1)}:1 skewed ` +
          `(green ${(green * 100).toFixed(0)}% vs red ${(red * 100).toFixed(0)}%, max ${SKEW_MAX}:1) — ` +
          `check whether a voter's band is tracking an era rather than a condition`
      );
    }
  }
  // Calibrated output sds must match. Input-centre drift can pass while
  // expanding-window z × refSd quietly gives each light a different percentile.
  const outSds = LIGHT_IDS.map((id) => byLight[id].sd).filter((s) => s > 0);
  outSds.sort((a, b) => a - b);
  const medianOutSd = outSds[Math.floor(outSds.length / 2)] || 0;
  if (medianOutSd > 0) {
    for (const lid of LIGHT_IDS) {
      const sd = byLight[lid].sd;
      if (Math.abs(sd - medianOutSd) > OUT_SD_TOL) {
        fails.push(
          `${lid} calibrated sd ${sd.toFixed(3)} vs median ${medianOutSd.toFixed(3)} ` +
            `(tol ${OUT_SD_TOL}) — ±0.45 is no longer the same percentile; rebake history`
        );
      }
    }
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
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.date < LIGHT_SINCE) continue;
      let a;
      if (isReal) {
        const c = coreAt(p.date);
        if (c == null) continue;
        a = makeAnchor({ ...spec, anchorKind: "real_rate" }, p.value - c);
      } else {
        a = makeAnchor(spec, p.value, trailingNorm(pts, i, spec.freq));
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
    // Judge amber against what the cliffs imply for this light's own spread, not
    // a flat 60%: a normally distributed composite at the shared calibrated sd
    // with cliffs at ±0.45 is amber 60% of the time by construction, so the flat
    // line flagged Inflation for sitting exactly where the arithmetic puts it.
    // Only an excess over that floor says the composite is peaked — that its
    // ballots are averaging each other into the middle.
    const impliedAmber = L.sd > 0 ? 2 * normalCdf(AMBER_CLIFF / L.sd) - 1 : null;
    if (impliedAmber != null && L.amber - impliedAmber > AMBER_EXCESS_WARN) {
      flags.push(
        `AMBER ${Math.round(L.amber * 100)}% vs ${Math.round(impliedAmber * 100)}% implied by its spread`
      );
    }
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

async function auditValCenters(problems, fails) {
  const VAL_FILE = path.join(ROOT, "data", "val-center.json");
  let stored;
  try {
    stored = JSON.parse(await fs.readFile(VAL_FILE, "utf8"));
  } catch {
    fails.push("val-center.json missing — run npm run calibrate:val");
    return;
  }
  const centers = stored.centers || stored;
  const ids = Object.keys(centers);
  if (!ids.length) {
    fails.push("val-center.json has no centres");
    return;
  }
  // The window audit:calls replays these centres over.
  let replayYears = 0;
  try {
    const h = JSON.parse(await fs.readFile(REGIME_HIST, "utf8"));
    if (h.start && h.end) {
      replayYears = (Date.parse(h.end) - Date.parse(h.start)) / 31557600000;
    }
  } catch {
    /* no archive yet — the span check simply cannot run */
  }
  console.log(
    `VALUATION CENTRES — archive medians vs stored (${SINCE}+, replayed over ${replayYears.toFixed(1)}y)\n`
  );
  for (const id of ids) {
    const expect = centers[id];
    const pts = await readPoints(id);
    const use = (pts || []).filter((p) => p.date >= LIGHT_SINCE);
    if (!use.length) {
      problems.push(`val/${id}: no history`);
      console.log(`  ${pad(id, 16)} no history`);
      continue;
    }
    const vals = use.map((p) => p.value).filter(Number.isFinite).sort((a, b) => a - b);
    const mid = vals[Math.floor((vals.length - 1) / 2)];
    const source = expect.source || "archive-median";
    const flags = [];
    if (source === "band-mid") {
      // HY: do not let the short ICE download overwrite the long-run typical.
      if (Math.abs(Number(expect.median) - 4.0) > 0.01) {
        flags.push(`band-mid median ${expect.median} drifted from 4.0`);
      }
    } else if (Math.abs(mid - Number(expect.median)) > VAL_MEAN_TOL) {
      flags.push(`median ${mid.toFixed(4)} vs stored ${expect.median} (tol ${VAL_MEAN_TOL})`);
    }
    // A centre decides whether an asset is cheap or expensive, and audit:calls
    // applies it to every day back to 2003. Fit it on a slice of that and the
    // replay judges 2008 against a range 2008 never saw. Judge the fitting
    // window by the years it spans, not the count of prints: monthly ERP has 285
    // observations covering the full archive, which read as thin next to a daily
    // series' 5,900 and sent an earlier review chasing a problem that wasn't
    // there. The genuinely short one is HY, and it is on the band mid for that
    // reason.
    const spanYears =
      (Date.parse(use[use.length - 1].date) - Date.parse(use[0].date)) / 31557600000;
    if (source !== "band-mid" && spanYears < replayYears * CENTRE_SPAN_MIN) {
      fails.push(
        `${id} valuation centre is fit on ${spanYears.toFixed(1)}y but replayed across ` +
          `${replayYears.toFixed(1)}y — either extend the history or pin the centre ` +
          `to a long-run typical the way HY is`
      );
    }
    // Does the term this centre produces actually vary, or has it been saying
    // the same thing for years? The band audit has always asked this of voters
    // and never of valuation, which is the other half of every asset call.
    //
    // The answer only means something for a centre pinned from outside. An
    // archive-median centre is the median of the very window it is applied to,
    // so it is forced to land near 50/50 and its balance is arithmetic, not
    // evidence — worth stating plainly, because a row of 50/50s reads like six
    // passing checks when five of them cannot fail. It also means those five
    // terms can never report that a whole era was expensive: the centre
    // absorbs the era.
    const scale = Number(expect.scale) || 1;
    const z = use
      .map((p) => (p.value - Number(expect.median)) / scale)
      .map((v) => Math.max(-1, Math.min(1, v)));
    const posShare = z.filter((v) => v > 0).length / z.length;
    const balance =
      source === "archive-median"
        ? "50/50 by construction"
        : `${(100 * posShare).toFixed(0)}% cheap / ${(100 * (1 - posShare)).toFixed(0)}% rich`;
    if (source !== "archive-median" && Math.min(posShare, 1 - posShare) < VAL_ONESIDE_MIN) {
      // Not a failure. A pinned centre is meant to outlive its download window,
      // and HY genuinely has not paid since 2023 — a term that says so for three
      // straight years is correct, not stuck. It is listed so that nobody has to
      // rediscover that this half of the credit call is currently a near-constant.
      problems.push(
        `val/${id}: term is ${balance} against a pinned centre of ${expect.median} — ` +
          `true while the regime holds, but it is not distinguishing days right now`
      );
    }
    console.log(
      `  ${pad(id, 16)} stored ${Number(expect.median).toFixed(4)}  archive ${mid.toFixed(4)}` +
        `  scale ${expect.scale}  ${spanYears.toFixed(1)}y span, n=${vals.length}  ${source}` +
        `  ${balance}` +
        (flags.length ? `   <-- ${flags.join(" ")}` : "")
    );
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
  const fails = [];
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
      // Index into the full series, not `use`: a trailing-norm voter judges each
      // print against the window before it, which reaches back past SINCE.
      const offset = pts.length - use.length;
      for (let k = 0; k < use.length; k++) {
        const p = use[k];
        let a;
        if (isReal) {
          const c = coreAt(p.date);
          if (c == null) continue;
          a = makeAnchor({ ...spec, anchorKind: "real_rate" }, p.value - c);
        } else {
          a = makeAnchor(spec, p.value, trailingNorm(pts, offset + k, spec.freq));
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

  await auditLightComposites(catalog, coreAt, problems, fails);
  await auditValCenters(problems, fails);

  if (fails.length) {
    console.log(`FAIL — ${fails.length} light-dist problem(s):`);
    for (const f of fails) console.log(`  - ${f}`);
  }
  if (!problems.length && !fails.length) {
    console.log("No band problems found.");
    return;
  }
  if (problems.length) {
    console.log(`${problems.length} thing(s) to look at:`);
    for (const p of problems) console.log(`  - ${p}`);
  }
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error(`audit-bands failed: ${e.message}`);
  process.exit(1);
});
