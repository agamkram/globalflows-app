#!/usr/bin/env node
/**
 * Bake today's regime — anchored lights + 6m so-what.
 *   npm run bake:regime
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeaning } from "../meaning.js";
import { buildAnalogs } from "./analogs.mjs";
import { appendRegimeLog } from "./regime-log.mjs";
import {
  buildLights,
  attachImpulse,
  memberAnchorScore,
  lightStateFromScore,
  distanceToCliff,
  aggregateVotes,
  DEFAULT_IMPULSE,
} from "../score.js";
import { loadLightDist } from "./load-light-dist.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const OUT_DATA = path.join(ROOT, "data", "regime-today.json");
const OUT_ROOT = path.join(ROOT, "regime-today.json");

const LIGHTS = ["liquidity", "rates", "growth", "inflation", "risk"];
const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};
const COLOR = { easing: "green", neutral: "amber", tight: "red", empty: "gray" };

function club(snap, lid) {
  const members = (snap.lights?.[lid]?.members || [])
    .map((id) => snap.series?.[id])
    .filter((m) => m && m.status === "ok");
  const voters = [];
  for (const m of members) {
    const sc = memberAnchorScore(m);
    if (sc == null) continue;
    const w = Math.max(1, Number(m.weight) || 1);
    voters.push({ id: m.id, name: m.name, score: sc, weight: w, why: m.anchor?.why });
  }
  voters.sort((a, b) => b.score - a.score);
  const score = aggregateVotes(lid, voters);
  const state = lightStateFromScore(score).state;
  const easy = voters.filter((v) => v.score > 0.45);
  const tight = voters.filter((v) => v.score < -0.45);
  return {
    score,
    state,
    word: WORD[lid]?.[state] || state,
    color: COLOR[state],
    voters,
    easy,
    tight,
    n: members.length,
  };
}

function names(arr, n = 2) {
  return arr.slice(0, n).map((v) => v.name).join(", ");
}

function teach(lid, c) {
  const soft = names(c.easy, 2);
  const hard = names(c.tight, 2);
  const split =
    c.easy.length && c.tight.length
      ? ` Split: ${soft || "some"} lean easier; ${hard || "others"} lean tighter.`
      : "";
  let inflNote = split;
  if (lid === "inflation") {
    const pce = c.voters.find((v) => v.id === "PCEPILFE");
    const bei = c.voters.find((v) => v.id === "T5YIFR");
    if (pce && bei && pce.score > 0.45 && bei.score <= 0.45 && bei.score >= -0.45) {
      inflNote =
        " Core PCE is still high versus ~2%; 5y5y is anchored at the CPI-equivalent of target.";
    } else if (pce && bei && pce.score > 0.45 && bei.score < -0.45) {
      inflNote = " Split: core PCE still hot; the bond market is pricing cold.";
    } else if (pce && bei && pce.score < -0.45 && bei.score > 0.45) {
      inflNote = " Split: core PCE is cold; the bond market is pricing hot.";
    }
  }
  let riskNote = split;
  if (lid === "risk") {
    const hy = c.voters.find((v) => v.id === "BAMLH0A0HYM2");
    if (hy && hy.score >= 0.85) {
      riskNote = " HY OAS is at cycle tights — calm, and not paid.";
    }
  }
  const cliff = distanceToCliff(c.score);
  const cliffNote =
    cliff != null && cliff < 0.05
      ? Math.abs(c.score) > 0.45
        ? ` Only ${cliff.toFixed(2)} past a word flip.`
        : ` Only ${cliff.toFixed(2)} from flipping the word.`
      : "";
  const by = {
    liquidity: {
      easing: `Cash looks ample on the level.${split}${cliffNote} Point: plumbing is not the scarce good.`,
      neutral: `Cash looks neither clearly ample nor scarce.${split}${cliffNote} Point: liquidity isn’t the loud driver right now.`,
      tight: `Cash looks scarce on the level.${split}${cliffNote} Point: funding/parking say less fuel in the pipes.`,
    },
    rates: {
      easing: `Real funding looks easy.${split}${cliffNote} Point: money is cheap to fund with.`,
      neutral: `Real funding looks mixed.${split}${cliffNote} Point: not clearly cheap or dear.`,
      tight: `Real funding looks tight.${split}${cliffNote} Point: you are being paid to wait in cash, not in duration.`,
    },
    growth: {
      easing: `Activity looks firm versus full employment / trend.${split}${cliffNote} Point: the real side is holding up.`,
      neutral: `Activity looks mixed versus trend.${split}${cliffNote} Point: no clean boom or bust.`,
      tight: `Activity looks soft versus trend.${split}${cliffNote} Point: demand/labor are under pressure.`,
    },
    inflation: {
      easing: `Prices are high versus ~2%.${inflNote}${cliffNote} Point: the level is still hot — the impulse row says if it’s cooling.`,
      neutral: `Prices are near the target band.${inflNote}${cliffNote} Point: no clean hot or cold call.`,
      tight: `Prices are cold versus ~2%.${inflNote}${cliffNote} Point: inflation is not the tax right now.`,
    },
    risk: {
      easing: `Fear is cheap on the gauges.${riskNote}${cliffNote} Point: vol and credit are quiet.`,
      neutral: `Fear gauges look mixed.${riskNote}${cliffNote} Point: not a clear risk-on or risk-off tape.`,
      tight: `Markets are paying up for fear.${riskNote}${cliffNote} Point: vol/credit stress is elevated.`,
    },
  };
  return by[lid]?.[c.state] || `${c.word}.`;
}

function headline(lights) {
  return `Cash ${lights.liquidity.word.toLowerCase()}, borrowing ${lights.rates.word.toLowerCase()}, growth ${lights.growth.word.toLowerCase()}, inflation ${lights.inflation.word.toLowerCase()}, risk ${lights.risk.word.toLowerCase()}.`;
}

function story(lights) {
  const bites = LIGHTS.map((id) => lights[id].teach.split(".")[0].trim() + ".");
  return bites.join(" ");
}

async function main() {
  const lightDist = await loadLightDist().catch(() => null);
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
  // File wins over whatever ingest embedded — calibrate:lights runs after ingest.
  if (lightDist) snap.lightDist = lightDist;
  const fails = [];
  const rebuilt = buildLights(snap);
  attachImpulse(rebuilt, snap, DEFAULT_IMPULSE);

  const lights = {};
  for (const lid of LIGHTS) {
    const c = club(snap, lid);
    if (!c.n) fails.push(`${lid}: no members`);
    if (!c.voters.length) fails.push(`${lid}: no anchor voters`);
    if (lightStateFromScore(c.score).state !== c.state) fails.push(`${lid}: lock broken`);
    const baked = snap.lights?.[lid];
    if (baked?.state && baked.state !== c.state) {
      fails.push(`${lid}: snapshot ${baked.state} ≠ math ${c.state}`);
    }
    lights[lid] = {
      id: lid,
      label: snap.lights?.[lid]?.label || lid,
      state: c.state,
      word: c.word,
      score: c.score,
      cliff: distanceToCliff(c.score),
      color: c.color,
      n: c.n,
      teach: teach(lid, c),
      voters: c.voters.map((v) => ({
        id: v.id,
        name: v.name,
        score: v.score,
        weight: v.weight,
        why: v.why,
      })),
    };
  }

  const viewLights = Object.fromEntries(
    LIGHTS.map((id) => [
      id,
      {
        state: rebuilt[id].state,
        word: lights[id].word,
        words: WORD[id],
        // Continuous checklist reads the score, not only the painted word.
        score: lights[id].score ?? rebuilt[id].score,
        impulse: rebuilt[id].impulse,
      },
    ])
  );
  const meaning = buildMeaning({ series: snap.series, lights: viewLights }, DEFAULT_IMPULSE);

  const net = snap.series?.NET_LIQ;
  if (!net || net.status !== "ok" || !Number.isFinite(net.latest)) {
    fails.push("net liquidity missing");
  } else if (net.latest < 1000 || net.latest > 15000) {
    fails.push(`net liquidity absurd (${net.latest})`);
  }
  const impulse = snap.series?.CREDIT_IMPULSE;
  if (!impulse || impulse.status !== "ok") fails.push("credit impulse missing");
  const gdp = snap.series?.GDP;
  if (!gdp || gdp.status !== "ok") fails.push("nominal GDP missing");

  const verdict = fails.length ? "NOT SPOT ON" : "SPOT ON";
  const bake = {
    title: "GlobalFlows regime — today",
    generatedAt: new Date().toISOString(),
    ingestAt: snap.generatedAt || null,
    verdict,
    fails,
    defaultImpulse: DEFAULT_IMPULSE,
    headline: headline(lights),
    story: story(lights),
    meaning,
    lights,
    netLiquidity: net
      ? { latest: net.latest, asOf: net.asOf, units: net.units }
      : null,
    creditImpulse: impulse
      ? { latest: impulse.latest, asOf: impulse.asOf, units: impulse.units }
      : null,
    note: `Anchored lights. Impulse default ${DEFAULT_IMPULSE}. Meaning = duration/credit/asset classes.`,
  };

  const analogs = await buildAnalogs(
    Object.fromEntries(LIGHTS.map((id) => [id, lights[id]?.score]))
  );
  bake.analogs = analogs;

  const json = JSON.stringify(bake, null, 2) + "\n";
  await fs.writeFile(OUT_DATA, json);
  await fs.writeFile(OUT_ROOT, json);
  console.log(`regime bake → ${path.relative(ROOT, OUT_DATA)}`);
  console.log(`verdict  ${verdict}`);
  console.log(`headline ${bake.headline}`);
  if (meaning) {
    console.log(`duration ${meaning.duration.label}`);
    console.log(`credit   ${meaning.credit.label}`);
  }
  if (fails.length) {
    for (const f of fails) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  for (const lid of LIGHTS) {
    const L = lights[lid];
    console.log(`  ${L.word.padEnd(11)} ${lid}  ${L.score >= 0 ? "+" : ""}${(L.score ?? 0).toFixed(2)}`);
  }
  if (analogs) {
    console.log(
      `analogs  ${analogs.n} comparable days (${analogs.closeness}) from ${analogs.sampleDays} in the record`
    );
  } else {
    console.log("analogs  none — run `npm run bake:history` to build the archive");
  }
  const logged = await appendRegimeLog(bake);
  if (logged) console.log(`logged   ${logged.date} → data/regime-log.json (${logged.n} days)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
