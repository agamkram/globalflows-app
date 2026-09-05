#!/usr/bin/env node
/**
 * Before/after report for a regime bake (Actions + local).
 *
 *   node scripts/bake-report.mjs --before /tmp/before.json --after regime-today.json
 *   node scripts/bake-report.mjs --snapshot-before /tmp/before.json   # write current → before
 *
 * Prints markdown to stdout; optional --out PATH.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}
function has(flag) {
  return process.argv.includes(flag);
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

function lights2(bake) {
  const L = bake?.horizons?.["2"]?.lights || {};
  const out = {};
  for (const id of ["liquidity", "rates", "growth", "inflation", "risk"]) {
    const row = L[id];
    if (!row) {
      out[id] = "—";
      continue;
    }
    out[id] = row.word || row.state || "—";
  }
  return out;
}

function meaningBits(bake) {
  const m = bake?.horizons?.["2"]?.meaning || bake?.meaning || null;
  if (!m) return { duration: "—", credit: "—" };
  return {
    duration: m.duration?.label || "—",
    credit: m.credit?.label || "—",
  };
}

function fmtWhen(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return String(iso);
  }
}

function lightDiff(before, after) {
  const b = lights2(before);
  const a = lights2(after);
  const lines = [];
  for (const id of Object.keys(a)) {
    if (b[id] !== a[id]) lines.push(`${id}: ${b[id]} → ${a[id]}`);
  }
  return lines;
}

function buildReport(before, after, meta = {}) {
  const ok = after?.verdict === "SPOT ON";
  const status = ok ? "SUCCESS · SPOT ON" : `FAIL · ${after?.verdict || "NO BAKE"}`;
  const bL = lights2(before);
  const aL = lights2(after);
  const bM = meaningBits(before);
  const aM = meaningBits(after);
  const flips = lightDiff(before || {}, after || {});
  const fails = Array.isArray(after?.fails) ? after.fails : [];
  const headlineChanged =
    (before?.headline || "") !== (after?.headline || "");

  const lines = [];
  lines.push(`# GlobalFlows regime bake`);
  lines.push("");
  lines.push(`**${status}**`);
  if (meta.runUrl) lines.push(`Run: ${meta.runUrl}`);
  if (meta.when) lines.push(`Finished: ${meta.when}`);
  lines.push("");

  lines.push(`## Headline`);
  lines.push(`- Before: ${before?.headline || "—"}`);
  lines.push(`- After:  ${after?.headline || "—"}`);
  if (!headlineChanged) lines.push(`- (unchanged)`);
  lines.push("");

  lines.push(`## Clocks`);
  lines.push(
    `| | Before | After |`,
  );
  lines.push(`|---|---|---|`);
  lines.push(`| Bake | ${fmtWhen(before?.generatedAt)} | ${fmtWhen(after?.generatedAt)} |`);
  lines.push(`| Ingest | ${fmtWhen(before?.ingestAt)} | ${fmtWhen(after?.ingestAt)} |`);
  lines.push(`| Verdict | ${before?.verdict || "—"} | ${after?.verdict || "—"} |`);
  lines.push("");

  lines.push(`## Lights (2y)`);
  lines.push(`| Light | Before | After |`);
  lines.push(`|---|---|---|`);
  for (const id of ["liquidity", "rates", "growth", "inflation", "risk"]) {
    const mark = bL[id] !== aL[id] ? " *" : "";
    lines.push(`| ${id} | ${bL[id]} | ${aL[id]}${mark} |`);
  }
  lines.push("");

  lines.push(`## So what`);
  lines.push(`- Duration: ${bM.duration} → ${aM.duration}`);
  lines.push(`- Credit: ${bM.credit} → ${aM.credit}`);
  lines.push("");

  lines.push(`## Changes`);
  if (flips.length || headlineChanged || bM.duration !== aM.duration || bM.credit !== aM.credit) {
    if (headlineChanged) lines.push(`- Headline changed`);
    for (const f of flips) lines.push(`- Light ${f}`);
    if (bM.duration !== aM.duration) lines.push(`- Duration: ${bM.duration} → ${aM.duration}`);
    if (bM.credit !== aM.credit) lines.push(`- Credit: ${bM.credit} → ${aM.credit}`);
  } else {
    lines.push(`- No light / headline / meaning label changes (numbers may still have moved).`);
  }
  lines.push("");

  if (fails.length) {
    lines.push(`## Fails`);
    for (const f of fails) lines.push(`- ${f}`);
    lines.push("");
  }

  if (after?.netLiquidity) {
    lines.push(`## Plumbing`);
    lines.push(
      `- Net liquidity ${after.netLiquidity.latest} ${after.netLiquidity.units || ""} (as-of ${after.netLiquidity.asOf || "—"})`,
    );
    lines.push("");
  }

  return lines.join("\n");
}

async function main() {
  if (has("--snapshot-before")) {
    const dest = arg("--snapshot-before");
    if (!dest) throw new Error("--snapshot-before needs a path");
    const src = path.join(ROOT, "regime-today.json");
    await fs.copyFile(src, dest);
    console.log(`before ← ${path.relative(ROOT, src)} → ${dest}`);
    return;
  }

  const beforePath = arg("--before");
  const afterPath = arg("--after", path.join(ROOT, "regime-today.json"));
  if (!beforePath) throw new Error("need --before PATH (or --snapshot-before)");

  let before = null;
  try {
    before = await readJson(beforePath);
  } catch {
    before = {};
  }
  const after = await readJson(afterPath);
  const md = buildReport(before, after, {
    runUrl: process.env.GITHUB_RUN_URL || null,
    when: new Date().toISOString(),
  });

  const out = arg("--out");
  if (out) {
    await fs.writeFile(out, md);
    console.log(`report → ${out}`);
  }
  process.stdout.write(md.endsWith("\n") ? md : md + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
