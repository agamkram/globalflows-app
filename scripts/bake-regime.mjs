#!/usr/bin/env node
/**
 * Bake today's regime — spot-on lights + teaching copy (the X-account job, automated).
 * Writes data/regime-today.json (+ root copy for static serve).
 *
 *   npm run bake:regime
 *
 * Run after ingest. Daily is enough; lights rarely flip intraday on a 2y window.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMeaning } from "../meaning.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const OUT_DATA = path.join(ROOT, "data", "regime-today.json");
const OUT_ROOT = path.join(ROOT, "regime-today.json");

const LIGHTS = ["liquidity", "rates", "growth", "inflation", "risk"];
const YEARS = [1, 2, 5];
const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};
const COLOR = { easing: "green", neutral: "amber", tight: "red", empty: "gray" };

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function hz(m, years) {
  if (years === 1) return { z: m.z1y, pct: m.pct1y };
  if (years === 5) return { z: m.z5y, pct: m.pct5y };
  return { z: m.z2y, pct: m.pct2y };
}
function memberScore(m, lid, years) {
  const sign = m.sign ?? 0;
  const s = lid === "inflation" ? 1 : sign === 0 ? 1 : sign;
  const { z, pct } = hz(m, years);
  const parts = [];
  if (z != null && Number.isFinite(z)) parts.push(z * s);
  if (pct != null && Number.isFinite(pct)) {
    const p = s < 0 ? 1 - pct : pct;
    parts.push((p - 0.5) * 3);
  }
  if (!parts.length) return null;
  return mean(parts);
}
function stateFrom(score) {
  if (score == null || !Number.isFinite(score)) return "empty";
  if (score > 0.45) return "easing";
  if (score < -0.45) return "tight";
  return "neutral";
}
function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  return Number(n);
}

function club(snap, lid, years) {
  const members = (snap.lights?.[lid]?.members || [])
    .map((id) => snap.series?.[id])
    .filter((m) => m && m.status === "ok");
  const bag = [];
  const voters = [];
  for (const m of members) {
    const sc = memberScore(m, lid, years);
    if (sc == null) continue;
    const w = Math.max(1, Math.round(m.weight || 1));
    voters.push({
      id: m.id,
      name: m.name || m.id,
      score: sc,
      weight: w,
      latest: m.latest,
      asOf: m.asOf,
    });
    for (let i = 0; i < w; i++) bag.push(sc);
  }
  voters.sort((a, b) => b.score - a.score);
  const score = bag.length ? median(bag) : null;
  const state = stateFrom(score);
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
  return arr
    .slice(0, n)
    .map((v) => v.name)
    .join(", ");
}

/** Plain clock for copy — not "5y". */
function pastWindow(years) {
  if (years === 1) return "Over the past year";
  if (years === 5) return "Over the past five years";
  return "Over the past two years";
}

/** Teaching blurb — clock is set once at the top of the regime sheet. */
function teach(lid, c, years) {
  const soft = names(c.easy, 2);
  const hard = names(c.tight, 2);
  const split =
    c.easy.length && c.tight.length
      ? ` Split: ${soft || "some"} lean easier; ${hard || "others"} lean tighter.`
      : "";

  const by = {
    liquidity: {
      easing: `Cash has been flowing back into the system.${split} Point: plumbing is adding fuel, not draining it.`,
      neutral: `Cash conditions have looked steady — no clear flood or drain.${split} Point: liquidity isn’t the loud driver right now.`,
      tight: `Cash has been leaving the system.${split} Point: Fed plumbing is tightening — less fuel in the pipes.`,
    },
    rates: {
      easing: `Borrowing has looked cheap.${split} Point: money is easy to fund with — rates/dollar aren’t fighting growth.`,
      neutral: `Borrowing has looked mixed.${split} Point: funding isn’t clearly cheap or dear — funding is split.`,
      tight: `Borrowing has looked expensive.${split} Point: higher rates or a strong dollar are tightening the screw.`,
    },
    growth: {
      easing: `Real activity has looked firm.${split} Point: activity is holding up — soft prints haven’t flipped the regime.`,
      neutral: `Growth has looked mixed.${split} Point: no clean boom or bust signal once the club is combined.`,
      tight: `Real activity has looked soft.${split} Point: the Growth dial is cooling — demand/labor are under pressure.`,
    },
    inflation: {
      easing: `Underlying prices have still looked hot.${split} Point: inflation pressure hasn’t rolled over — heat is still in the gauges the Fed watches.`,
      neutral: `Inflation has looked mixed.${split} Point: some core measures cool, others don’t — no clean Cold call.`,
      tight: `Underlying prices have looked cooler.${split} Point: inflation pressure is fading in this window.`,
    },
    risk: {
      easing: `Market fear has stayed cheap.${split} Point: vol and credit are quiet — the tape isn’t priced for pain.`,
      neutral: `Fear gauges have looked mixed.${split} Point: not a clear risk-on or risk-off tape.`,
      tight: `Markets have been paying up for fear.${split} Point: vol/credit stress is elevated — risk is on the back foot.`,
    },
  };
  return by[lid]?.[c.state] || `${c.word}.`;
}

function headline(lights2) {
  const L = lights2.liquidity.word;
  const T = lights2.rates.word;
  const G = lights2.growth.word;
  const I = lights2.inflation.word;
  const R = lights2.risk.word;
  return `Cash ${L.toLowerCase()}, borrowing ${T.toLowerCase()}, growth ${G.toLowerCase()}, inflation ${I.toLowerCase()}, risk ${R.toLowerCase()}.`;
}

function story(lights2, years = 2) {
  const parts = LIGHTS.map((id) => lights2[id].teach);
  // Clock once, then first sentence of each teach — no repeated “Over the past…”
  const bites = parts.map((t) => t.split(".")[0].trim() + ".");
  const first = bites[0];
  const rest = bites.slice(1).join(" ");
  const opened = first.charAt(0).toLowerCase() + first.slice(1);
  return `${pastWindow(years)}, ${opened}${rest ? ` ${rest}` : ""}`;
}

async function main() {
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
  const fails = [];
  const horizons = {};

  for (const y of YEARS) {
    const lights = {};
    for (const lid of LIGHTS) {
      const c = club(snap, lid, y);
      if (!c.n) fails.push(`${lid} ${y}y: no voters`);
      if (stateFrom(c.score) !== c.state) fails.push(`${lid} ${y}y: lock broken`);

      // File bake at 2y should match
      if (y === 2) {
        const baked = snap.lights?.[lid];
        if (baked?.state && baked.state !== c.state) {
          fails.push(`${lid}: snapshot ${baked.state} ≠ math ${c.state}`);
        }
      }

      lights[lid] = {
        id: lid,
        label: snap.lights?.[lid]?.label || lid,
        state: c.state,
        word: c.word,
        score: c.score,
        color: c.color,
        n: c.n,
        teach: teach(lid, c, y),
        voters: c.voters.map((v) => ({
          id: v.id,
          name: v.name,
          score: v.score,
          weight: v.weight,
        })),
      };
    }
    const viewLights = Object.fromEntries(
      LIGHTS.map((id) => [
        id,
        {
          state: lights[id].state,
          word: lights[id].word,
          words: WORD[id],
        },
      ])
    );
    const meaning = buildMeaning({ series: snap.series, lights: viewLights }, y);
    horizons[String(y)] = { years: y, lights, meaning };
  }

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

  const lights2 = horizons["2"].lights;
  const meaning2 = horizons["2"].meaning;
  const verdict = fails.length ? "NOT SPOT ON" : "SPOT ON";

  const bake = {
    title: "GlobalFlows regime — today",
    generatedAt: new Date().toISOString(),
    ingestAt: snap.generatedAt || null,
    verdict,
    fails,
    defaultHorizon: 2,
    headline: headline(lights2),
    story: story(lights2),
    meaning: meaning2,
    netLiquidity: net
      ? { latest: net.latest, asOf: net.asOf, units: net.units }
      : null,
    creditImpulse: impulse
      ? { latest: impulse.latest, asOf: impulse.asOf, units: impulse.units }
      : null,
    nomRealSpread: snap.series?.NOM_REAL_SPREAD?.status === "ok"
      ? {
          latest: snap.series.NOM_REAL_SPREAD.latest,
          asOf: snap.series.NOM_REAL_SPREAD.asOf,
          units: snap.series.NOM_REAL_SPREAD.units,
        }
      : null,
    horizons,
    note: "Daily bake. Numbers locked before copy. Meaning = duration/credit implications.",
  };

  const json = JSON.stringify(bake, null, 2) + "\n";
  await fs.writeFile(OUT_DATA, json);
  await fs.writeFile(OUT_ROOT, json);

  console.log(`regime bake → ${path.relative(ROOT, OUT_DATA)}`);
  console.log(`verdict  ${verdict}`);
  console.log(`headline ${bake.headline}`);
  if (meaning2) {
    console.log(`duration ${meaning2.duration.label}`);
    console.log(`credit   ${meaning2.credit.label}`);
  }
  if (fails.length) {
    for (const f of fails) console.log(`  FAIL ${f}`);
    process.exit(1);
  }
  for (const lid of LIGHTS) {
    const L = lights2[lid];
    console.log(`  ${L.word.padEnd(11)} ${lid}  ${L.score >= 0 ? "+" : ""}${L.score.toFixed(2)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
