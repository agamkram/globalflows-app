#!/usr/bin/env node
/**
 * Prove each light's number, word, and color match the anchor math.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memberAnchorScore, lightStateFromScore } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SNAP = path.join(ROOT, "snapshot.json");
const OUT = path.join(ROOT, "sanity.txt");

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
function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = Number(n).toFixed(d);
  return Number(n) > 0 ? `+${s}` : s;
}

async function main() {
  const snap = JSON.parse(await fs.readFile(SNAP, "utf8"));
  const fails = [];
  const lines = [];
  lines.push("GlobalFlows light check (anchors)");
  lines.push(`ingest ${snap.generatedAt || "—"}`);
  lines.push("");
  lines.push("Lights = median of voter anchors. Impulse clocks do not recolor lights.");
  lines.push("Score > +0.45 → green · < −0.45 → red · else amber.");
  lines.push("");

  for (const lid of LIGHTS) {
    const members = (snap.lights?.[lid]?.members || [])
      .map((id) => snap.series?.[id])
      .filter((m) => m && m.status === "ok");
    const bag = [];
    const detail = [];
    for (const m of members) {
      const sc = memberAnchorScore(m);
      if (sc == null) continue;
      detail.push({ name: m.name || m.id, sc, why: m.anchor?.why || "" });
      for (let i = 0; i < Math.max(1, Math.round(m.weight || 1)); i++) bag.push(sc);
    }
    const score = bag.length ? median(bag) : null;
    const state = lightStateFromScore(score).state;
    const word = WORD[lid][state];
    const color = COLOR[state];
    const baked = snap.lights?.[lid];
    if (baked?.state && baked.state !== state) {
      fails.push(`${lid}: snapshot ${baked.state} ≠ math ${state}`);
    }
    if (!detail.length) fails.push(`${lid}: no anchor voters`);
    lines.push(`  ${lid.toUpperCase()}  ${word}  ${fmt(score)}  ${color}`);
    for (const d of detail) {
      lines.push(`    ${fmt(d.sc)}  ${d.name}  ${d.why}`);
    }
  }

  lines.push("");
  if (fails.length) {
    lines.push("FAIL");
    for (const f of fails) lines.push(`  ${f}`);
  } else {
    lines.push("ok — number, word, and color lock.");
  }
  await fs.writeFile(OUT, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  if (fails.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
