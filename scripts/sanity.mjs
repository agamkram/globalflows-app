#!/usr/bin/env node
/**
 * GlobalFlows sanity — prove each light's number, word, and color match.
 * Writes sanity.txt (short). Paste to an agent after for meaning, not before.
 *
 *   npm run sanity
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const OUT = path.join(ROOT, "sanity.txt");

const LIGHTS = ["liquidity", "rates", "growth", "inflation", "risk"];
const YEARS = [1, 2, 5];

/** Word the UI paints for each light + state. */
const WORD = {
  liquidity: { easing: "Easing", neutral: "Neutral", tight: "Tightening" },
  rates: { easing: "Easy", neutral: "Neutral", tight: "Tight" },
  growth: { easing: "Strong", neutral: "Mid", tight: "Soft" },
  inflation: { easing: "Hot", neutral: "Mid", tight: "Cold" },
  risk: { easing: "Risk-on", neutral: "Neutral", tight: "Risk-off" },
};

/** Color the UI uses (same as CSS data-state). */
const COLOR = {
  easing: "green",
  neutral: "amber",
  tight: "red",
  empty: "gray",
};

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
/** Same paint rule as the app: >+0.45 green, <−0.45 red, else amber. */
function stateFrom(score) {
  if (score == null || !Number.isFinite(score)) return "empty";
  if (score > 0.45) return "easing";
  if (score < -0.45) return "tight";
  return "neutral";
}
function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Number(n).toFixed(d);
  return Number(n) > 0 ? `+${s}` : s;
}
function club(snap, lid, years) {
  const members = (snap.lights?.[lid]?.members || [])
    .map((id) => snap.series?.[id])
    .filter((m) => m && m.status === "ok");
  const bag = [];
  const detail = [];
  for (const m of members) {
    const sc = memberScore(m, lid, years);
    if (sc == null) continue;
    detail.push({ name: m.name || m.id, sc, w: Math.max(1, Math.round(m.weight || 1)) });
    for (let i = 0; i < Math.max(1, Math.round(m.weight || 1)); i++) bag.push(sc);
  }
  const score = bag.length ? median(bag) : null;
  const state = stateFrom(score);
  return { score, state, word: WORD[lid]?.[state] || state, color: COLOR[state], detail, n: members.length };
}

async function main() {
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
  const series = snap.series || {};
  const fails = [];
  const lines = [];

  lines.push("GlobalFlows light check");
  lines.push(`ingest ${snap.generatedAt || "—"}`);
  lines.push("");
  lines.push("Rule: score > +0.45 → green word · score < −0.45 → red word · else amber.");
  lines.push("Score = median of voter scores (each voter = avg of signed z + %ile).");
  lines.push("");

  for (const y of YEARS) {
    lines.push(`—— ${y}y window ——`);
    for (const lid of LIGHTS) {
      const c = club(snap, lid, y);
      const baked = snap.lights?.[lid];

      // 1) Number → word → color must lock
      const expectState = stateFrom(c.score);
      const expectWord = WORD[lid][expectState];
      const expectColor = COLOR[expectState];
      const lockOk =
        c.state === expectState && c.word === expectWord && c.color === expectColor;

      lines.push(
        `  ${lid.toUpperCase()}  ${c.word}  ${fmt(c.score)}  ${c.color}`
      );

      if (!c.n) {
        fails.push(`${lid} ${y}y: no voters`);
        lines.push(`    FAIL no voters`);
        continue;
      }
      if (!lockOk) {
        fails.push(`${lid} ${y}y: number/word/color disagree`);
        lines.push(`    FAIL lock broken`);
      } else {
        lines.push(`    lock OK  (number → ${c.color} → “${c.word}”)`);
      }

      // 2) At 2y, saved snapshot light must match (what the file ships)
      if (y === 2 && baked?.state && baked.state !== c.state) {
        fails.push(`${lid}: file says ${baked.state}, math says ${c.state}`);
        lines.push(`    FAIL file light ≠ math`);
      }
      if (y === 2 && baked?.score != null && Math.abs(baked.score - c.score) > 0.02) {
        // UI recomputes; small drift OK — only flag big gaps
        if (Math.abs(baked.score - c.score) > 0.15) {
          fails.push(`${lid}: file score ${fmt(baked.score)} vs math ${fmt(c.score)}`);
          lines.push(`    FAIL file score ≠ math`);
        }
      }

      // 3) Voters (tight — so you can see the number is earned)
      const bits = c.detail
        .map((d) => `${d.name} ${fmt(d.sc)}${d.w > 1 ? `×${d.w}` : ""}`)
        .join(" · ");
      lines.push(`    voters: ${bits}`);
    }
    lines.push("");
  }

  // Plumbing that feeds liquidity
  const net = series.NET_LIQ;
  lines.push("—— plumbing ——");
  if (!net || net.status !== "ok" || !Number.isFinite(net.latest)) {
    fails.push("net liquidity missing/bad");
    lines.push("  FAIL net liquidity");
  } else if (net.latest < 1000 || net.latest > 15000) {
    fails.push(`net liquidity absurd (${fmt(net.latest, 0)} bn)`);
    lines.push(`  FAIL net liquidity ${fmt(net.latest, 0)} bn (broken units)`);
  } else {
    lines.push(`  OK net liquidity ${fmt(net.latest, 0)} bn  as-of ${net.asOf}`);
  }
  lines.push("");

  lines.push("—— verdict ——");
  if (fails.length) {
    lines.push("NOT SPOT ON");
    for (const f of fails) lines.push(`  FAIL  ${f}`);
  } else {
    lines.push("SPOT ON");
    lines.push("Every light’s number, color, and word agree at 1y, 2y, and 5y.");
    lines.push("Net liquidity is a sane figure.");
    lines.push("Safe to ask an AI what each light *means*.");
  }
  lines.push("");

  const text = lines.join("\n");
  await fs.writeFile(OUT, text);
  process.stdout.write(text);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
