#!/usr/bin/env node
/**
 * Prove all 11 boxes lock: 5 lights (number / word / color) and 6 asset
 * classes (in / mixed / out). Also fail if any series' on-disk history shrank
 * below the high-water mark in data/history-lengths.json — the only class of
 * data loss that is silent and unrecoverable. Writes sanity.txt.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  memberAnchorScore,
  lightStateFromScore,
  buildLights,
  attachImpulse,
  aggregateVotes,
  DEFAULT_IMPULSE,
} from "../score.js";
import { buildMeaning } from "../meaning.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const REGIME = path.join(ROOT, "data", "regime-today.json");
const HIST = path.join(ROOT, "data", "history");
const LENGTHS = path.join(ROOT, "data", "history-lengths.json");
const CHECKS = path.join(ROOT, "data", "sanity-checks.json");
const CATALOG = path.join(ROOT, "data", "catalog.json");
const OUT = path.join(ROOT, "sanity.txt");

const LIGHTS = ["liquidity", "rates", "growth", "inflation", "risk"];
const FAVOR = ["treasuries", "credit", "stocks", "crypto", "gold", "cmdty"];
const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};
const COLOR = { easing: "green", neutral: "amber", tight: "red", empty: "gray" };
const FAVOR_WORD = { in: "in", mixed: "mixed", out: "out" };
const FAVOR_COLOR = { in: "green", mixed: "amber", out: "red" };

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Number(n).toFixed(d);
  return Number(n) > 0 ? `+${s}` : s;
}
function near(a, b, eps = 1e-6) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= eps;
}
function kidsOf(it) {
  return it?.tenors || it?.splits || [];
}

function ageDays(asOf, today = new Date()) {
  if (!asOf || typeof asOf !== "string") return null;
  const t = Date.parse(asOf.slice(0, 10) + "T00:00:00Z");
  if (!Number.isFinite(t)) return null;
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.floor((end - t) / 86400000);
}

async function main() {
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
  const catalog = JSON.parse(await fs.readFile(CATALOG, "utf8"));
  const bySpec = Object.fromEntries((catalog.series || []).map((s) => [s.id, s]));
  let checks = null;
  try {
    checks = JSON.parse(await fs.readFile(CHECKS, "utf8"));
  } catch {
    checks = null;
  }
  let regime = null;
  try {
    regime = JSON.parse(await fs.readFile(REGIME, "utf8"));
  } catch {
    /* bake optional — lights still lock without it */
  }

  const fails = [];
  const lines = [];
  lines.push("GlobalFlows check — 11 boxes");
  lines.push(`ingest ${snap.generatedAt || "—"}`);
  if (regime?.generatedAt) lines.push(`regime ${regime.generatedAt}`);
  lines.push("");
  lines.push("Lights = weighted mean of voter anchors (families first). Lookback does not recolor lights.");
  lines.push("Score > +0.45 → green · < −0.45 → red · else amber.");
  lines.push("");

  const mathLights = {};
  for (const lid of LIGHTS) {
    const members = (snap.lights?.[lid]?.members || [])
      .map((id) => snap.series?.[id])
      .filter((m) => m && m.status === "ok");
    const voters = [];
    const detail = [];
    for (const m of members) {
      const sc = memberAnchorScore(m);
      if (sc == null) continue;
      detail.push({ name: m.name || m.id, sc, why: m.anchor?.why || "" });
      voters.push({ id: m.id, score: sc, weight: Math.max(1, Number(m.weight) || 1) });
    }
    const score = aggregateVotes(lid, voters);
    const state = lightStateFromScore(score).state;
    const word = WORD[lid][state];
    const color = COLOR[state];
    mathLights[lid] = { state, word, score, color };
    const baked = snap.lights?.[lid];
    if (baked?.state && baked.state !== state) {
      fails.push(`${lid}: snapshot ${baked.state} ≠ math ${state}`);
    }
    if (regime?.lights?.[lid]?.state && regime.lights[lid].state !== state) {
      fails.push(`${lid}: regime ${regime.lights[lid].state} ≠ math ${state}`);
    }
    if (!detail.length) fails.push(`${lid}: no anchor voters`);
    lines.push(`  ${lid.toUpperCase()}  ${word}  ${fmt(score)}  ${color}`);
    for (const d of detail) {
      lines.push(`    ${fmt(d.sc)}  ${d.name}  ${d.why}`);
    }
  }

  // Same path the bake and UI use: lights → lookback → checklist → asset classes.
  const view = buildLights(snap);
  attachImpulse(view, snap, DEFAULT_IMPULSE);
  for (const lid of LIGHTS) {
    if (view[lid]?.state !== mathLights[lid].state) {
      fails.push(`${lid}: buildLights ${view[lid]?.state} ≠ aggregate ${mathLights[lid].state}`);
    }
  }
  const meaning = buildMeaning(
    {
      series: snap.series,
      lights: Object.fromEntries(
        LIGHTS.map((id) => [
          id,
          {
            state: mathLights[id].state,
            word: mathLights[id].word,
            words: WORD[id],
            // Continuous checklist reads the score, not only the painted word.
            score: mathLights[id].score ?? view[id]?.score,
            impulse: view[id]?.impulse,
          },
        ])
      ),
    },
    DEFAULT_IMPULSE
  );

  lines.push("");
  lines.push(
    `Asset classes = checklist from the five lights (+ duration / credit). Lookback ${DEFAULT_IMPULSE} slides the needle only.`
  );
  lines.push("in → green · mixed → amber · out → red.");
  if (meaning?.duration?.label) {
    lines.push(`  duration  ${meaning.duration.label}  (${meaning.duration.dir || "—"})`);
  }
  if (meaning?.credit?.label) {
    lines.push(`  credit    ${meaning.credit.label}  (${meaning.credit.dir || "—"})`);
  }
  lines.push("");

  const bakedItems = regime?.meaning?.favor?.items || [];
  const byBake = Object.fromEntries(bakedItems.map((it) => [it.id, it]));
  const got = meaning?.favor?.items || [];
  const byGot = Object.fromEntries(got.map((it) => [it.id, it]));

  for (const id of FAVOR) {
    const it = byGot[id];
    if (!it) {
      fails.push(`${id}: missing from meaning`);
      lines.push(`  ${id.toUpperCase()}  —`);
      continue;
    }
    const stance = it.stance;
    if (!FAVOR_WORD[stance]) fails.push(`${id}: bad call ${stance}`);
    const word = FAVOR_WORD[stance] || stance;
    const color = FAVOR_COLOR[stance] || "gray";
    lines.push(`  ${it.name || id}  ${word}  needle ${fmt(it.margin)}  ${color}`);

    const bake = byBake[id];
    if (regime && !bake) fails.push(`${id}: missing from regime bake`);
    if (bake?.stance && bake.stance !== stance) {
      fails.push(`${id}: regime ${bake.stance} ≠ math ${stance}`);
    }
    if (bake && !near(bake.margin, it.margin, 1e-4)) {
      fails.push(`${id}: regime needle ${fmt(bake.margin)} ≠ math ${fmt(it.margin)}`);
    }

    const kids = kidsOf(it);
    const bakeKids = Object.fromEntries(kidsOf(bake).map((c) => [c.id, c]));
    for (const kid of kids) {
      const kWord = FAVOR_WORD[kid.stance] || kid.stance;
      const kColor = FAVOR_COLOR[kid.stance] || "gray";
      lines.push(
        `    ${kid.label || kid.name || kid.id}  ${kWord}  needle ${fmt(kid.margin)}  ${kColor}`
      );
      const bk = bakeKids[kid.id];
      if (bk?.stance && bk.stance !== kid.stance) {
        fails.push(`${id}/${kid.id}: regime ${bk.stance} ≠ math ${kid.stance}`);
      }
    }
  }

  for (const id of Object.keys(byGot)) {
    if (!FAVOR.includes(id)) fails.push(`${id}: unexpected asset class`);
  }

  if (regime?.meaning?.duration?.dir && meaning?.duration?.dir) {
    if (regime.meaning.duration.dir !== meaning.duration.dir) {
      fails.push(
        `duration: regime ${regime.meaning.duration.dir} ≠ math ${meaning.duration.dir}`
      );
    }
  }
  if (regime?.meaning?.credit?.dir && meaning?.credit?.dir) {
    if (regime.meaning.credit.dir !== meaning.credit.dir) {
      fails.push(`credit: regime ${regime.meaning.credit.dir} ≠ math ${meaning.credit.dir}`);
    }
  }

  // History must never shrink. Rolling-window feeds (ICE BofA 3y, Yahoo ~10y)
  // used to overwrite data/history and drop a day off the back every run.
  lines.push("");
  lines.push("History length (append-only high-water marks)");
  let lengthLedger = null;
  try {
    lengthLedger = JSON.parse(await fs.readFile(LENGTHS, "utf8"));
  } catch {
    fails.push("history-lengths.json missing — run npm run ingest once to seed it");
  }
  if (lengthLedger?.series) {
    const ids = Object.keys(lengthLedger.series).sort();
    let checked = 0;
    let shrunk = 0;
    for (const id of ids) {
      const mark = lengthLedger.series[id];
      const want = mark?.n || 0;
      if (!want) continue;
      let n = 0;
      let first = null;
      let last = null;
      try {
        const hist = JSON.parse(await fs.readFile(path.join(HIST, `${id}.json`), "utf8"));
        // Transformed series (YoY/diff) keep fewer scored points than observations.
        // Append-only is about the underlying record — prefer raw when present.
        const pts =
          Array.isArray(hist.raw) && hist.raw.length
            ? hist.raw
            : Array.isArray(hist.points)
              ? hist.points
              : [];
        n = pts.length;
        first = pts[0]?.date || null;
        last = pts[n - 1]?.date || null;
      } catch {
        fails.push(`${id}: history file missing (high-water n=${want})`);
        shrunk++;
        continue;
      }
      checked++;
      if (n < want) {
        shrunk++;
        fails.push(
          `${id}: history shrank ${want} → ${n} (first ${first || "—"} last ${last || "—"}; high-water first ${mark.first || "—"})`
        );
      }
    }
    if (shrunk) {
      lines.push(`  FAIL  ${shrunk} series shorter than high-water mark (${checked} checked)`);
    } else {
      lines.push(
        `  ok  ${checked} series at or above high-water` +
          (lengthLedger.updatedAt ? ` · ledger ${lengthLedger.updatedAt}` : "")
      );
    }
  }

  // External gates — a stuck feed or absurd print must fail even when the bake
  // still matches the recomputed math.
  lines.push("");
  lines.push("External checks (staleness + plausible range)");
  if (!checks?.series) {
    fails.push("sanity-checks.json missing — cannot gate staleness or ranges");
    lines.push("  FAIL  sanity-checks.json missing");
  } else {
    const defaults = checks.defaults || {};
    let checked = 0;
    let staleN = 0;
    let rangeN = 0;
    const ids = Object.keys(checks.series).sort();
    for (const id of ids) {
      const gate = checks.series[id];
      const s = snap.series?.[id];
      const spec = bySpec[id] || {};
      if (!s || s.status !== "ok") {
        // BBB_OAS and other non-voters still must be present once catalogued.
        if (spec.light || id === "BBB_OAS") {
          fails.push(`${id}: missing or not ok in snapshot (external check)`);
          lines.push(`  FAIL  ${id} missing from snapshot`);
        }
        continue;
      }
      checked++;
      const freq = spec.freq || "unknown";
      const maxAge =
        gate.maxAgeDays ?? defaults[freq] ?? defaults.unknown ?? 90;
      const age = ageDays(s.asOf);
      if (age != null && age > maxAge) {
        staleN++;
        fails.push(
          `${id}: stale asOf ${s.asOf || "—"} (${age}d > ${maxAge}d ${freq})`
        );
      }
      const v = Number(s.latest);
      if (
        Number.isFinite(v) &&
        Number.isFinite(gate.min) &&
        Number.isFinite(gate.max) &&
        (v < gate.min || v > gate.max)
      ) {
        rangeN++;
        fails.push(
          `${id}: latest ${v} outside plausible [${gate.min}, ${gate.max}]`
        );
      }
    }
    if (!staleN && !rangeN) {
      lines.push(`  ok  ${checked} series within age and range gates`);
    } else {
      lines.push(
        `  FAIL  ${staleN} stale · ${rangeN} out of range (${checked} checked)`
      );
    }
  }

  lines.push("");
  if (fails.length) {
    lines.push("FAIL");
    for (const f of fails) lines.push(`  ${f}`);
  } else {
    lines.push(
      "ok — all 11 boxes lock (5 lights + 6 asset classes); history lengths hold; external gates clear."
    );
  }
  await fs.writeFile(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
