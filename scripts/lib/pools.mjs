// The split of change groups into the tuning and the evaluation pool. It is a
// hash rule, so every tool gets the same answer without shared state: every
// review of one commit lands in the same pool, whatever the session.
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";

export const EVALUATION_SHARE = 0.7;

export function poolOf(changeGroupKey) {
  return parseInt(String(changeGroupKey).slice(0, 8), 16) / 0xffffffff < EVALUATION_SHARE ? "evaluation" : "tuning";
}

export function labelsDir(env = process.env) {
  return path.join(dataDir(env), "labels");
}

export function poolsFile(env = process.env) {
  return path.join(labelsDir(env), "pools.json");
}

// True once `orch-label.mjs reserve` ran. Before that, no report is kept for an
// evaluation, so the cleanup may delete old results.
export function poolsReserved(env = process.env) {
  return fs.existsSync(poolsFile(env));
}
