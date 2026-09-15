#!/usr/bin/env node
/** One-screen terminal peek at data/external. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "external"
);

function read(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXT, rel), "utf8"));
  } catch {
    return null;
  }
}

function net(n) {
  if (n == null || !Number.isFinite(Number(n))) return "       —";
  const v = Math.round(Number(n));
  return ((v > 0 ? "+" : "") + v.toLocaleString("en-US")).padStart(10);
}

const fear = read("fear-greed/latest.json");
const cot = read("cot/latest.json");
const convex = read("convex/latest.json");

console.log("\nExternal shelf\n");
if (fear) {
  console.log(`Fear & Greed  ${Math.round(fear.score)} ${fear.rating}   as of ${fear.asOf}`);
} else console.log("Fear & Greed  (missing)");

if (convex) {
  console.log(
    `Convex        ${convex.regime} / ${convex.trajectory}   as of ${convex.asOf}   stale ${convex.staleDays}d`
  );
  const views = Object.entries(convex.assetViews || {})
    .map(([k, v]) => `${k}:${v.direction}`)
    .join("  ");
  if (views) console.log(`              ${views}`);
} else console.log("Convex        (missing)");

if (cot) {
  console.log(`\nCOT           as of ${cot.tffAsOf}`);
  console.log("              contract             smart net    lev net");
  for (const c of cot.contracts || []) {
    if (c.missing) {
      console.log(`              ${String(c.label).padEnd(18)} missing`);
      continue;
    }
    const smart = c.report === "tff" ? c.assetMgrNet : c.managedMoneyNet;
    const lev = c.report === "tff" ? c.levMoneyNet : null;
    console.log(
      `              ${String(c.label).padEnd(18)} ${net(smart)} ${net(lev)}`
    );
  }
} else console.log("\nCOT           (missing)");

console.log("\nBrowser:  /external.html on the local preview");
console.log("Refresh:  npm run fetch:external\n");
