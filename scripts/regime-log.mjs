/**
 * The append-only record of what the app actually said, on the day it said it.
 *
 * This is deliberately separate from data/regime-history.json. That file is a
 * replay: today's model applied backwards over revised data, rebuilt from scratch
 * whenever the model changes. This one is the live record — each entry is what a
 * reader would have seen that morning, and it is never recomputed. It is the only
 * part of the archive that is honest about vintage, and the only part that cannot
 * be reconstructed later, which is why it starts accumulating now.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIGHT_IDS } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "data", "regime-log.json");

export async function appendRegimeLog(bake) {
  if (!bake || bake.verdict !== "SPOT ON") return null;

  let log = { note: "", modelVersions: [], days: [] };
  try {
    const existing = JSON.parse(await fs.readFile(LOG, "utf8"));
    if (Array.isArray(existing.days)) log = existing;
  } catch {
    /* first run */
  }
  log.note =
    "What the app said each morning, recorded live and never recomputed. " +
    "data/regime-history.json is a replay of the current model over revised data; " +
    "this is the contemporaneous record.";

  const date = (bake.generatedAt || new Date().toISOString()).slice(0, 10);
  const entry = {
    date,
    generatedAt: bake.generatedAt,
    headline: bake.headline,
    lights: Object.fromEntries(
      LIGHT_IDS.map((id) => [
        id,
        { state: bake.lights?.[id]?.state ?? null, score: bake.lights?.[id]?.score ?? null },
      ])
    ),
    duration: bake.meaning?.duration?.dir ?? null,
    credit: bake.meaning?.credit?.dir ?? null,
  };

  // One entry per day; a re-bake replaces the day rather than duplicating it.
  const i = log.days.findIndex((d) => d.date === date);
  if (i >= 0) log.days[i] = entry;
  else log.days.push(entry);
  log.days.sort((a, b) => a.date.localeCompare(b.date));

  await fs.writeFile(LOG, JSON.stringify(log, null, 2) + "\n");
  return { date, n: log.days.length };
}
