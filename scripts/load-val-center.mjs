/**
 * Load data/val-center.json into meaning.js for Node scripts.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setValCenter } from "../meaning.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "data", "val-center.json");

export async function loadValCenter() {
  const raw = JSON.parse(await fs.readFile(FILE, "utf8"));
  const table = raw.centers || raw;
  setValCenter(table);
  return table;
}

export function valCenterPath() {
  return FILE;
}
