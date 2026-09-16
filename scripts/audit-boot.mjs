/**
 * Catch the bug class that blanked the live book: a leftover name in a template
 * string (heldNote) that throws on first paint and leaves the shell empty.
 *
 * node --check cannot see it. We (1) ban known-retired bindings in ${...},
 * (2) syntax-check the three browser modules, (3) smoke-build meaning from
 * today's bake so a missing export fails here, not on Vercel.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Names removed from the UI that must not linger in template strings. */
const RETIRED = ["heldNote", "heldFlag", "surveyCapNote"];

async function smokeMeaning() {
  const snap = JSON.parse(await fs.readFile(path.join(ROOT, "data", "snapshot.json"), "utf8"));
  const regime = JSON.parse(await fs.readFile(path.join(ROOT, "data", "regime-today.json"), "utf8"));
  const { buildMeaning } = await import(pathToFileURL(path.join(ROOT, "meaning.js")).href);
  const { LIGHT_IDS, chipBandFromScore, lightStateFromScore } = await import(
    pathToFileURL(path.join(ROOT, "score.js")).href
  );
  const { chipWord } = await import(pathToFileURL(path.join(ROOT, "light-copy.js")).href);
  const bands = [
    [0.46, "easing"],
    [0.42, "leaningEasing"],
    [0.20, "neutral"],
    [0.0, "neutral"],
    [-0.20, "neutral"],
    [-0.32, "leaningTight"],
    [-0.46, "tight"],
  ];
  for (const [sc, want] of bands) {
    const got = chipBandFromScore(sc);
    if (got !== want) throw new Error(`chipBandFromScore(${sc}) = ${got}, want ${want}`);
  }
  if (lightStateFromScore(0.42).state !== "neutral") {
    throw new Error("lean must not cross the rail: +0.42 should stay inside ±0.45");
  }
  if (chipBandFromScore(-0.32) !== "leaningTight") {
    throw new Error(`chipBandFromScore(-0.32) = ${chipBandFromScore(-0.32)}, want leaningTight`);
  }
  if (chipWord("inflation", 0.42) !== "Leaning hot") {
    throw new Error(`chipWord inflation 0.42 = ${chipWord("inflation", 0.42)}`);
  }
  const meaning = buildMeaning(
    { ...snap, lights: regime.lights, valCenter: snap.valCenter },
    regime.defaultImpulse || "1m"
  );
  const lightN = LIGHT_IDS.filter((id) => regime.lights?.[id]).length;
  const classN = meaning?.favor?.items?.length || 0;
  if (lightN < 5) throw new Error(`regime-today missing lights: have ${lightN}`);
  if (classN < 6) throw new Error(`meaning returned ${classN} classes, need 6`);
  return { lightN, classN, headline: meaning?.headline || regime.headline };
}

async function main() {
  const appSrc = await fs.readFile(path.join(ROOT, "app.js"), "utf8");
  const hits = RETIRED.filter((name) => new RegExp(`\\$\\{\\s*${name}\\b`).test(appSrc));
  if (hits.length) {
    console.log("FAIL — retired bindings still referenced in app.js templates:");
    for (const h of hits) console.log(`  \${${h}}`);
    process.exit(1);
  }

  for (const file of ["app.js", "meaning.js", "score.js", "light-copy.js"]) {
    const r = spawnSync(process.execPath, ["--check", path.join(ROOT, file)], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      console.log(`FAIL — node --check ${file}`);
      console.log(r.stderr || r.stdout);
      process.exit(1);
    }
  }

  const smoke = await smokeMeaning();
  console.log(
    `ok — no retired template bindings; syntax clean; ` +
      `smoke ${smoke.lightN} lights + ${smoke.classN} classes` +
      (smoke.headline ? ` (“${String(smoke.headline).slice(0, 60)}”)` : "")
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
