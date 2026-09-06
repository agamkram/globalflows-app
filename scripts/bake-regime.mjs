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
  DEFAULT_IMPULSE,
} from "../score.js";

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

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function club(snap, lid) {
  const members = (snap.lights?.[lid]?.members || [])
    .map((id) => snap.series?.[id])
    .filter((m) => m && m.status === "ok");
  const bag = [];
  const voters = [];
  for (const m of members) {
    const sc = memberAnchorScore(m);
    if (sc == null) continue;
    const w = Math.max(1, Math.round(m.weight || 1));
    voters.push({ id: m.id, name: m.name, score: sc, weight: w, why: m.anchor?.why });
    for (let i = 0; i < w; i++) bag.push(sc);
  }
  voters.sort((a, b) => b.score - a.score);
  const score = bag.length ? median(bag) : null;
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
  const by = {
    liquidity: {
      easing: `Cash looks ample on the level.${split} Point: plumbing is not the scarce good.`,
      neutral: `Cash looks neither clearly ample nor scarce.${split} Point: liquidity isn’t the loud driver right now.`,
      tight: `Cash looks scarce on the level.${split} Point: funding/parking say less fuel in the pipes.`,
    },
    rates: {
      easing: `Real funding looks easy.${split} Point: money is cheap to fund with.`,
      neutral: `Real funding looks mixed.${split} Point: not clearly cheap or dear.`,
      tight: `Real funding looks tight.${split} Point: you are being paid to wait in cash, not in duration.`,
    },
    growth: {
      easing: `Activity looks firm versus full employment / trend.${split} Point: the real side is holding up.`,
      neutral: `Activity looks mixed versus trend.${split} Point: no clean boom or bust.`,
      tight: `Activity looks soft versus trend.${split} Point: demand/labor are under pressure.`,
    },
    inflation: {
      easing: `Prices are high versus ~2%.${split} Point: the level is still hot — the impulse row says if it’s cooling.`,
      neutral: `Prices are near the target band.${split} Point: no clean hot or cold call.`,
      tight: `Prices are cold versus ~2%.${split} Point: inflation is not the tax right now.`,
    },
    risk: {
      easing: `Fear is cheap on the gauges.${split} Point: vol and credit are quiet.`,
      neutral: `Fear gauges look mixed.${split} Point: not a clear risk-on or risk-off tape.`,
      tight: `Markets are paying up for fear.${split} Point: vol/credit stress is elevated.`,
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
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
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
    note: "Anchored lights. Impulse default 6m. Meaning = duration/credit/asset classes.",
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
