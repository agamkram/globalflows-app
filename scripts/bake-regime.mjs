#!/usr/bin/env node
/**
 * Bake today's regime — anchored lights + 3m so-what.
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
  lightStateFromScore,
  distanceToCliff,
  clubLight,
  DEFAULT_IMPULSE,
} from "../score.js";
import { LIGHT_IDS, LIGHT_WORD, lightSheet } from "../light-copy.js";
import { loadLightDist } from "./load-light-dist.mjs";
import { loadValCenter } from "./load-val-center.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const OUT_DATA = path.join(ROOT, "data", "regime-today.json");
const OUT_ROOT = path.join(ROOT, "regime-today.json");

const LIGHTS = LIGHT_IDS;

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
  try {
    snap.valCenter = await loadValCenter();
  } catch {
    /* optional until calibrate:val */
  }
  const fails = [];
  const rebuilt = buildLights(snap);
  attachImpulse(rebuilt, snap, DEFAULT_IMPULSE);

  const lights = {};
  for (const lid of LIGHTS) {
    const c = clubLight(snap, lid);
    const sheet = lightSheet(lid, {
      ...c,
      cliff: distanceToCliff(c.score),
      impulse: rebuilt[lid].impulse,
    });
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
      word: sheet.word,
      score: c.score,
      cliff: sheet.cliff,
      color: sheet.color,
      n: c.n,
      teach: sheet.teach,
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
        words: LIGHT_WORD[id],
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
