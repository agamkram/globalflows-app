/**
 * Base rates: find the days in the archive whose lights sat closest to today's,
 * and report what the market actually did over the following weeks.
 *
 * The point is not prediction. It is to put a sample size next to a claim, so a
 * reader can see whether "duration is hard here" has happened forty times before
 * or four, and how often it went the other way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIGHT_IDS } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Adjacent trading days are nearly the same observation, so counting them all
 * would inflate the sample and make a handful of episodes look like a base rate.
 * Analogs must sit at least this far apart.
 */
const MIN_GAP_DAYS = 21;
const MAX_ANALOGS = 40;

function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function buildAnalogs(todayScores) {
  let hist;
  try {
    hist = JSON.parse(
      await fs.readFile(path.join(ROOT, "data", "regime-history.json"), "utf8")
    );
  } catch {
    return null;
  }
  const target = LIGHT_IDS.map((id) => todayScores[id]);
  if (target.some((v) => v == null || !Number.isFinite(v))) return null;

  // Only days with a complete set of forward returns can inform a base rate.
  const scored = hist.rows
    .filter((r) => r.fwd && Object.keys(r.fwd).length)
    .map((r) => ({
      date: r.date,
      st: r.st,
      fwd: r.fwd,
      d: Math.sqrt(r.s.reduce((acc, v, i) => acc + (v - target[i]) ** 2, 0)),
    }))
    .sort((a, b) => a.d - b.d);

  const picked = [];
  for (const cand of scored) {
    if (picked.length >= MAX_ANALOGS) break;
    const t = Date.parse(cand.date);
    const clash = picked.some(
      (p) => Math.abs(Date.parse(p.date) - t) < MIN_GAP_DAYS * 86400000
    );
    if (!clash) picked.push(cand);
  }
  if (picked.length < 8) return null;

  const stats = {};
  for (const hz of Object.keys(hist.horizons)) {
    const byAsset = {};
    for (const a of hist.assets) {
      const vals = picked.map((p) => p.fwd[hz]?.[a.id]).filter(Number.isFinite);
      if (vals.length < 8) continue;
      byAsset[a.id] = {
        name: a.name,
        n: vals.length,
        median: Number(median(vals).toFixed(2)),
        up: Number(((vals.filter((v) => v > 0).length / vals.length) * 100).toFixed(0)),
        best: Number(Math.max(...vals).toFixed(1)),
        worst: Number(Math.min(...vals).toFixed(1)),
      };
    }
    if (Object.keys(byAsset).length) stats[hz] = byAsset;
  }
  if (!Object.keys(stats).length) return null;

  // How alike are these days, really? A tight cluster is worth more than the same
  // count of loose ones, and the reader should be told which they are looking at.
  const dists = picked.map((p) => p.d);
  const spread = median(dists);
  const closeness = spread < 0.35 ? "close" : spread < 0.7 ? "loose" : "distant";

  return {
    n: picked.length,
    closeness,
    medianDistance: Number(spread.toFixed(3)),
    windowStart: hist.start,
    windowEnd: hist.end,
    sampleDays: hist.n,
    minGapDays: MIN_GAP_DAYS,
    caveats: hist.caveats,
    // Most recent first reads better than nearest first when it is shown as a list.
    dates: picked
      .map((p) => p.date)
      .sort()
      .reverse()
      .slice(0, 12),
    stats,
  };
}
