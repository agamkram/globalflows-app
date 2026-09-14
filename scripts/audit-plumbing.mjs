#!/usr/bin/env node
/**
 * Plumbing audit — the machinery around the model, not the model.
 *   npm run audit:plumbing
 *
 * The other four checks all read the archive and all ask whether the rules are
 * good. None of them can see a pipeline that is quietly telling the truth about
 * the wrong thing. Every bug this file tests for is one that actually happened
 * and that all four passed straight through:
 *
 *   parity   The Growth survey cap ran on the live path and never on the archive
 *            path. For three days the audited model was not the shipped model,
 *            and every archive-reading check agreed with itself the whole time.
 *   bands    Anchors are frozen at ingest. Edit a band, re-bake, and nothing
 *            changes — the edit looks applied and is not.
 *   units    A units string with no fmtValue case renders as a bare number.
 *            FRED publishes China's reserves in millions; a bare number there is
 *            wrong by six orders of magnitude and still looks like a number.
 *   log      The forward record stamped the UTC date, filing a call against a
 *            session that had not opened yet.
 *   copy     About and Math state constants. Nothing kept them true.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIGHT_IDS,
  clubLight,
  tallyVotes,
  calibrateLightScore,
  lightStateFromScore,
  setLightDist,
  makeAnchor,
} from "../score.js";
import { MIN_GAP_DAYS, MAX_ANALOGS, CLOSE_CUT, LOOSE_CUT } from "./analogs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EPS = 1e-9;

const fails = [];
const warns = [];
const lines = [];
const ok = (s) => lines.push(`  ok    ${s}`);
const fail = (s) => {
  fails.push(s);
  lines.push(`  FAIL  ${s}`);
};
const warn = (s) => {
  warns.push(s);
  lines.push(`  warn  ${s}`);
};

const snap = JSON.parse(await fs.readFile(path.join(ROOT, "data", "snapshot.json"), "utf8"));
if (snap.lightDist) setLightDist(snap.lightDist);

lines.push("Plumbing audit — the machinery around the model");
lines.push("");

/* ── 1. The live path and the archive path must score identically ────────────
 * Live calibrates inside tallyVotes. The archive takes the raw composite and
 * calibrates outside it. Any rule that lives on one side of that fork and not
 * the other is invisible to every other check in the suite. */
lines.push("1. Live vs archive scoring parity");
{
  const dist = snap.lightDist;
  let bad = 0;
  for (const lid of LIGHT_IDS) {
    const voters = clubLight(snap, lid)?.voters || [];
    if (!voters.length) continue;
    const live = tallyVotes(lid, voters, { calibrate: true, dist }).score;
    const raw = tallyVotes(lid, voters, { calibrate: false }).score;
    const archive = calibrateLightScore(lid, raw, dist);
    if (live == null || archive == null) continue;
    if (Math.abs(live - archive) > EPS) {
      bad++;
      fail(
        `${lid}: live path scores ${live.toFixed(4)}, archive path ${archive.toFixed(4)} — ` +
          `a rule applies on one side of the fork only, so the audits grade a different model than ships`
      );
    }
  }
  if (!bad) ok(`all ${LIGHT_IDS.length} components score the same through both paths`);
}

/* ── 2. Bands in score.js vs the anchors frozen into snapshot.json ─────────── */
lines.push("");
lines.push("2. Bands frozen at ingest vs current score.js");
{
  let checked = 0;
  let drifted = 0;
  for (const [id, row] of Object.entries(snap.series || {})) {
    if (row.status !== "ok" || !Number.isFinite(row.latest)) continue;
    if (row.anchor?.score == null) continue;
    const again = makeAnchor({ id, sign: -1 }, row.latest);
    if (again?.score == null) continue;
    checked++;
    if (Math.abs(again.score - row.anchor.score) > 1e-6) {
      drifted++;
      if (drifted <= 6) {
        fail(
          `${id}: snapshot holds ${row.anchor.score.toFixed(3)}, score.js now says ` +
            `${again.score.toFixed(3)} — run npm run refresh, the band edit is not live`
        );
      }
    }
  }
  if (drifted > 6) fail(`…and ${drifted - 6} more series with stale frozen anchors`);
  if (!drifted) ok(`${checked} frozen anchors match a fresh recompute`);
}

/* ── 3. Every catalog units string has an explicit fmtValue case ──────────── */
lines.push("");
lines.push("3. Units coverage in fmtValue");
{
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, "data", "catalog.json"), "utf8"));
  const appSrc = await fs.readFile(path.join(ROOT, "app.js"), "utf8");
  const fn = appSrc.slice(appSrc.indexOf("function fmtValue"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 1);
  const cased = new Set([...body.matchAll(/case\s+"([^"]+)"/g)].map((m) => m[1]));
  // Unitless readings where a bare two-decimal number is the correct print. Any
  // units string outside this list and outside the switch is the trap: a scale
  // the reader cannot see. Add to this list only after checking what the source
  // publishes — FRED reports China's reserves in millions.
  const BARE_IS_CORRECT = new Set(["index", "ρ 60d"]);
  const used = new Set();
  for (const s of catalog.series || []) if (s.units) used.add(s.units);
  const missing = [...used].filter((u) => !cased.has(u) && !BARE_IS_CORRECT.has(u)).sort();
  if (missing.length) {
    for (const u of missing) {
      const who = (catalog.series || []).filter((s) => s.units === u).map((s) => s.id);
      warn(
        `units "${u}" (${who.join(", ")}) has no fmtValue case and is not on the bare-number ` +
          `list — it will print without a scale. Check what the source publishes.`
      );
    }
  } else {
    ok(`${used.size} catalog units: ${used.size - BARE_IS_CORRECT.size} cased, ${BARE_IS_CORRECT.size} deliberately bare`);
  }
}

/* ── 4. The forward record must be a clean, past-tense ledger ─────────────── */
lines.push("");
lines.push("4. Forward record integrity");
{
  let log = null;
  try {
    log = JSON.parse(await fs.readFile(path.join(ROOT, "data", "regime-log.json"), "utf8"));
  } catch {
    warn("data/regime-log.json not present yet");
  }
  if (log) {
    const days = log.days || [];
    // The trading day in New York, not the UTC calendar day.
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const future = days.filter((d) => d.date > today);
    const dates = days.map((d) => d.date);
    const dupes = dates.filter((d, i) => dates.indexOf(d) !== i);
    const sorted = [...dates].sort();
    const weekend = days.filter((d) => [0, 6].includes(new Date(d.date + "T12:00:00Z").getUTCDay()));
    const thin = days.filter((d) => Object.keys(d.lights || {}).length !== LIGHT_IDS.length);

    if (future.length)
      fail(
        `${future.length} entr${future.length === 1 ? "y is" : "ies are"} dated past today ` +
          `(${future.map((d) => d.date).join(", ")}) — a call filed against a session that has not opened`
      );
    if (dupes.length) fail(`duplicate dates in the forward record: ${[...new Set(dupes)].join(", ")}`);
    if (String(dates) !== String(sorted)) fail("forward record is not in date order");
    if (weekend.length)
      warn(
        `${weekend.length} of ${days.length} entries fall on a weekend ` +
          `(${weekend.map((d) => d.date).join(", ")}) — real bakes, but no session opened against them, ` +
          `so the record is smaller than its day count suggests`
      );
    if (thin.length) fail(`${thin.length} entries do not carry all five components`);
    if (!future.length && !dupes.length && !thin.length && String(dates) === String(sorted))
      ok(`${days.length} entries, in order, none dated later than ${today}`);
  }
}

/* ── 5. Numbers stated on About and Math must still be the numbers in code ── */
lines.push("");
lines.push("5. Claims on About and Math vs the code");
{
  const about = await fs.readFile(path.join(ROOT, "about.html"), "utf8");
  const math = await fs.readFile(path.join(ROOT, "math.html"), "utf8");
  const pages = { "about.html": about, "math.html": math };

  // Probe the colour cut rather than trusting a literal: binary search the point
  // where the word turns, so a change to lightStateFromScore surfaces here.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (lightStateFromScore(mid).state === "easing") hi = mid;
    else lo = mid;
  }
  const cut = Math.round(hi * 1e6) / 1e6;
  const hist = JSON.parse(
    await fs.readFile(path.join(ROOT, "data", "regime-history.json"), "utf8")
  ).horizons ?? {};

  const claims = [
    { what: "colour cut", value: 0.45, near: cut, where: ["about.html", "math.html"] },
    { what: "analog minimum gap (days)", value: MIN_GAP_DAYS, near: 21, where: ["math.html"] },
    { what: "analogs kept", value: MAX_ANALOGS, near: 40, where: ["math.html"] },
    { what: "close cut", value: CLOSE_CUT, near: 0.35, where: ["math.html"] },
    { what: "loose cut", value: LOOSE_CUT, near: 0.7, where: ["math.html"] },
    { what: "1m horizon in trading days", value: hist["1m"], near: 21, where: ["math.html"] },
    { what: "12m horizon in trading days", value: hist["12m"], near: 252, where: ["math.html"] },
  ];

  let bad = 0;
  for (const c of claims) {
    if (c.value == null) continue;
    if (Math.abs(c.value - c.near) > 1e-9) {
      bad++;
      fail(
        `${c.what} is ${c.value} in code but the pages were written against ${c.near} — ` +
          `update ${c.where.join(" and ")}`
      );
      continue;
    }
    // The number must also actually appear where it is claimed.
    for (const page of c.where) {
      const needle = String(c.value);
      if (!pages[page].includes(needle)) {
        bad++;
        fail(`${page} no longer states ${c.what} (${needle})`);
      }
    }
  }
  if (!bad) ok(`${claims.filter((c) => c.value != null).length} stated constants match the code`);
}

lines.push("");
if (fails.length) {
  lines.push(`FAIL — ${fails.length} plumbing problem(s); the model may be fine and still be reported wrong.`);
} else if (warns.length) {
  lines.push(`ok — plumbing holds (${warns.length} thing(s) to look at above).`);
} else {
  lines.push("ok — plumbing holds: one model on both paths, bands live, units covered, record clean, pages true.");
}

console.log(lines.join("\n"));
process.exit(fails.length ? 1 : 0);
