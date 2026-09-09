/**
 * Load data/light-dist.json into score.js for Node scripts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setLightDist } from "../score.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "data", "light-dist.json");

export async function loadLightDist() {
  const dist = JSON.parse(await fs.readFile(DIST, "utf8"));
  setLightDist(dist);
  return dist;
}

export function lightDistPath() {
  return DIST;
}
