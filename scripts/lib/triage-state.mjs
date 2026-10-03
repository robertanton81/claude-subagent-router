// The finding triage keeps its work in files, so a crash, a second event for the
// same subagent or a slow retry never calls Jev twice or loses a result.
//
//   triage/pending/<key>.handback.json   the accepted hand-back report (capture hook)
//   triage/pending/<key>.stop.json       the SubagentStop input, saved first, so a run can be redone
//   triage/claimed/<key>                 who works on the key now: { pid, startedAt, attempts }
//   triage/claimed/<key>.takeover        a short lock while a stale claim is taken over
//   triage/done/<key>.json               the complete result; the source of truth
//
// Every file is private to the user. A file is written under a temporary name
// and then renamed, so a reader never sees half of it. Errors other than "the
// file exists" are thrown: the hook turns them into a hook_error record.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";
import { ensurePrivateDir } from "./log.mjs";

export const CLAIM_STALE_MS = 10 * 60 * 1000;
export const TAKEOVER_STALE_MS = 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const RETRY_PER_RUN = 2;
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function triageDir(env = process.env) {
  return path.join(dataDir(env), "triage");
}

function folder(name, env) {
  const dir = path.join(triageDir(env), name);
  ensurePrivateDir(dir);
  return dir;
}

export function stateKey(sessionId, agentId) {
  const clean = (value) => String(value ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return `${clean(sessionId)}__${clean(agentId)}`;
}

function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Keeps the first accepted report. Returns false when a capture already exists.
export function writeCapture(key, message, env = process.env) {
  const file = path.join(folder("pending", env), `${key}.handback.json`);
  try {
    fs.closeSync(fs.openSync(file, "wx", 0o600));
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
  writeAtomic(file, JSON.stringify({ message, capturedAt: new Date().toISOString() }));
  return true;
}

export function readCapture(key, env = process.env) {
  const file = path.join(triageDir(env), "pending", `${key}.handback.json`);
  try {
    const value = readJson(file);
    return typeof value?.message === "string" ? value.message : null;
  } catch {
    // An empty file is a capture still being written; a missing one is no capture.
    return null;
  }
}

export function deleteCapture(key, env = process.env) {
  fs.rmSync(path.join(triageDir(env), "pending", `${key}.handback.json`), { force: true });
}

export function writeStop(key, input, env = process.env) {
  writeAtomic(path.join(folder("pending", env), `${key}.stop.json`), JSON.stringify(input));
}

export function readStop(key, env = process.env) {
  return readJson(path.join(triageDir(env), "pending", `${key}.stop.json`));
}

export function isDone(key, env = process.env) {
  return fs.existsSync(path.join(triageDir(env), "done", `${key}.json`));
}

export function writeDone(key, result, env = process.env) {
  writeAtomic(path.join(folder("done", env), `${key}.json`), JSON.stringify(result));
}

export function readDone(key, env = process.env) {
  return readJson(path.join(triageDir(env), "done", `${key}.json`));
}

// Ends the claim of a finished key. The pending files go too; the done file stays.
export function release(key, env = process.env) {
  const dir = triageDir(env);
  fs.rmSync(path.join(dir, "claimed", key), { force: true });
  fs.rmSync(path.join(dir, "pending", `${key}.stop.json`), { force: true });
  fs.rmSync(path.join(dir, "pending", `${key}.handback.json`), { force: true });
}

function ageOf(file, now) {
  return now - fs.statSync(file).mtimeMs;
}

// Returns { claimed: true, attempts } or { claimed: false, reason }.
// reason is "busy" (someone works on it), "done" or "abandoned" (too many attempts).
export function claim(key, { now = Date.now(), env = process.env } = {}) {
  if (isDone(key, env)) return { claimed: false, reason: "done" };
  const dir = folder("claimed", env);
  const file = path.join(dir, key);
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    const token = randomUUID();
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now, attempts: 1, token }));
    fs.closeSync(fd);
    // Another run may have finished and released its claim between the first
    // check and this create. Then the work is done, not ours.
    if (isDone(key, env)) {
      fs.rmSync(file, { force: true });
      return { claimed: false, reason: "done" };
    }
    return { claimed: true, attempts: 1, token };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  if (ageOf(file, now) < CLAIM_STALE_MS) return { claimed: false, reason: "busy" };

  // Take over a stale claim. A rename alone is not exclusive: two takers can both
  // see the old claim. So a separate lock decides, and its holder checks again.
  const lock = `${file}.takeover`;
  try {
    if (fs.existsSync(lock) && ageOf(lock, now) >= TAKEOVER_STALE_MS) fs.rmSync(lock, { force: true });
  } catch {
    // Another taker removed or made it first; the exclusive create below decides.
  }
  try {
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
  } catch (error) {
    if (error.code === "EEXIST") return { claimed: false, reason: "busy" };
    throw error;
  }
  try {
    if (isDone(key, env)) return { claimed: false, reason: "done" };
    if (ageOf(file, now) < CLAIM_STALE_MS) return { claimed: false, reason: "busy" };
    let attempts = 1;
    try {
      attempts = Number(readJson(file).attempts) || 1;
    } catch {
      // A claim that cannot be read counts as one attempt.
    }
    if (attempts >= MAX_ATTEMPTS) return { claimed: false, reason: "abandoned", attempts };
    const token = randomUUID();
    writeAtomic(file, JSON.stringify({ pid: process.pid, startedAt: now, attempts: attempts + 1, token }));
    // The rename keeps the old time; the new claim must look fresh.
    const seconds = now / 1000;
    fs.utimesSync(file, seconds, seconds);
    return { claimed: true, attempts: attempts + 1, token };
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// A claim belongs to whoever holds its token. A worker that was suspended (a
// laptop that slept) while its claim went stale may find the claim taken over
// when it resumes; it must then neither send nor write nor release.
export function ownsClaim(key, token, env = process.env) {
  if (!token) return false;
  try {
    return readJson(path.join(triageDir(env), "claimed", key)).token === token;
  } catch {
    return false;
  }
}

// Publishes the result once. The whole file is written under a temporary name
// and linked to the final name; a link fails when the name exists. So the
// first publisher wins and nobody overwrites, even a worker that was suspended
// right after its token check. Returns false when this worker no longer owns
// the claim or another result was published first.
export function writeDoneOnce(key, token, result, env = process.env) {
  if (!ownsClaim(key, token, env)) return false;
  return publishDoneOnce(key, result, env);
}

// The publication by link, without the owner check (for a result that no
// claim owns, such as "abandoned"). False when a result exists already.
export function publishDoneOnce(key, result, env = process.env) {
  const file = path.join(folder("done", env), `${key}.json`);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(result), { mode: 0o600 });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function releaseIfOwner(key, token, env = process.env) {
  if (!ownsClaim(key, token, env)) return false;
  release(key, env);
  return true;
}

// A job whose state may still change (a missing checkout, consent that git
// could not decide, a Jev outage or rate limit) is postponed for DEFER_MS and
// tried again, at most DEFER_MAX times in all. A worker that lost its lock only
// releases its claim: the lock's owner does the job.
export const DEFER_MS = 60 * 60 * 1000;
export const DEFER_MAX = 3;

export function deferral(key, env = process.env) {
  try {
    return readJson(path.join(triageDir(env), "deferred", `${key}.json`));
  } catch {
    // No deferral, or a damaged one: the job is tried now, which loses nothing.
    return null;
  }
}

// Records one more deferral and returns how many there were in all.
export function deferJob(key, reason, env = process.env, now = Date.now()) {
  const count = (Number(deferral(key, env)?.count) || 0) + 1;
  writeAtomic(path.join(folder("deferred", env), `${key}.json`), JSON.stringify({ reason, count, until: now + DEFER_MS }));
  return count;
}

export function clearDeferral(key, env = process.env) {
  fs.rmSync(path.join(triageDir(env), "deferred", `${key}.json`), { force: true });
}

// A job that the scan can never use (not a review, outside consent, before the
// start time, too old) is marked once, so later scans and their budget skip it.
export function markSkipped(key, reason, env = process.env) {
  writeAtomic(path.join(folder("skipped", env), `${key}.json`), JSON.stringify({ reason, at: new Date().toISOString() }));
}

export function isSkipped(key, env = process.env) {
  return fs.existsSync(path.join(triageDir(env), "skipped", `${key}.json`));
}

// Keys whose work stopped: a saved stop input, no done file, and a claim that is
// missing or stale. At most RETRY_PER_RUN, oldest first.
export function abandonedKeys({ now = Date.now(), env = process.env } = {}) {
  const pending = path.join(triageDir(env), "pending");
  if (!fs.existsSync(pending)) return [];
  const keys = [];
  for (const name of fs.readdirSync(pending)) {
    if (!name.endsWith(".stop.json")) continue;
    const key = name.slice(0, -".stop.json".length);
    if (isDone(key, env)) continue;
    const claimFile = path.join(triageDir(env), "claimed", key);
    const stale = !fs.existsSync(claimFile) || ageOf(claimFile, now) >= CLAIM_STALE_MS;
    if (stale) keys.push({ key, at: fs.statSync(path.join(pending, name)).mtimeMs });
  }
  return keys.sort((a, b) => a.at - b.at).slice(0, RETRY_PER_RUN).map((entry) => entry.key);
}

// Every done result, one per report_id. A file that is not valid JSON is
// skipped with a line on stderr, so one bad file never hides the others.
export function loadDoneResults(env = process.env) {
  const dir = path.join(triageDir(env), "done");
  if (!fs.existsSync(dir)) return [];
  const byReport = new Map();
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      const result = readJson(path.join(dir, name));
      const id = result.report_id ?? name;
      if (!byReport.has(id)) byReport.set(id, result);
    } catch (error) {
      process.stderr.write(`subagent-router triage: ${name} could not be read: ${error.message}\n`);
    }
  }
  return [...byReport.values()];
}

// Deletes files older than KEEP_MS. A done file is kept while keepDone(key, result)
// says so (evaluation reports are needed for the labelling).
export function cleanup({ now = Date.now(), env = process.env, keepDone = () => false } = {}) {
  for (const name of ["pending", "claimed", "done", "skipped", "deferred"]) {
    const dir = path.join(triageDir(env), name);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const file = path.join(dir, entry);
      let old;
      try {
        old = ageOf(file, now) >= KEEP_MS;
      } catch {
        continue;
      }
      if (!old) continue;
      if (name === "done" && entry.endsWith(".json")) {
        let result = null;
        try {
          result = readJson(file);
        } catch {
          // An unreadable old file is deleted.
        }
        if (result && keepDone(entry.slice(0, -5), result)) continue;
      }
      fs.rmSync(file, { force: true });
    }
  }
}
