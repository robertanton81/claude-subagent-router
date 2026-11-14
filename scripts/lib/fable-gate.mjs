import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";
import { ensurePrivateDir, makeFilePrivate } from "./log.mjs";

// The gate in front of the automatic Fable route. The route is off by default.
// When it is on, the hook may move a debugging task or a hard implementation
// from Opus to Fable, and this file decides whether one more such launch is
// allowed. It answers two questions:
//   1. Does the Claude Code that runs this session resolve `fable` to Fable 5.2?
//   2. Is there room under the launch limit of the last 7 days?
// Every unknown answers "no", and the task then stays on Opus as before.
//
// The limit is a LAUNCH limit, not a money limit. Claude Code gives a plugin no
// reading of the weekly Fable limit, and one launch can use few or many tokens.
// Calls that the hook does not route (a brief with `orch-route: keep`, a call
// from inside a subagent, a workflow agent, another machine) are not counted.
//
// What the limit cannot hold against: a person who deletes the launch record
// starts a new count, and a system clock that jumps forward ends the 7 days
// early. Nothing on this machine can tell either from normal use.

// The alias `fable` means Fable 5.2 from this Claude Code version on. Before it,
// the alias means Fable 5.1, which costs more per token.
// Source: https://code.claude.com/docs/en/model-config, "Version history", read 2026-11-14.
export const FABLE_MIN_VERSION = "2.1.321";

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const LOCK_WAIT_MS = 1500;
const LOCK_POLL_MS = 25;
// More entries than this in 7 days means the file is not ours or is damaged.
const LEDGER_MAX_ENTRIES = 5000;

export function fableLedgerFile(env = process.env) {
  return path.join(dataDir(env), "fable-launches.json");
}

function parseVersion(text) {
  const match = typeof text === "string" ? /^(\d+)\.(\d+)\.(\d+)/.exec(text) : null;
  return match ? match.slice(1).map(Number) : null;
}

// True only when both versions can be read and `version` is not older.
export function versionAtLeast(version, minimum) {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (!have || !need) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) {
      return have[index] > need[index];
    }
  }
  return true;
}

// The Claude Code version that wrote the newest line of the session transcript.
// A line of a transcript is one JSON object. Lines of a message, an attachment
// or an API request carry a top-level `version`; bookkeeping lines carry none
// and are skipped. Only that top-level field counts: the word "version" inside a
// message or a tool result is text of the conversation and must not be able to
// open the gate. The newest line that has the field decides alone: when its
// value is not a version, the answer is null, and no older line is asked.
// Returns null too when no complete line with the field is in the tail.
export function claudeCodeVersion(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") {
    return null;
  }
  let tail;
  try {
    const handle = fs.openSync(transcriptPath, "r");
    try {
      const size = fs.fstatSync(handle).size;
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      fs.readSync(handle, buffer, 0, length, size - length);
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // The first line of the tail is usually cut in the middle.
      continue;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry) && Object.prototype.hasOwnProperty.call(entry, "version")) {
      return parseVersion(entry.version) ? entry.version : null;
    }
  }
  return null;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Takes the ledger lock, or returns false. A lock that a dead hook left behind
// is never broken here: two hooks that break the same old lock can remove each
// other's new lock, and then both pass the limit. So an old lock keeps the route
// off, the log says "ledger_busy", and the setup check names the file to remove.
function takeLock(lock) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, "wx", 0o600));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        return false;
      }
    }
    if (Date.now() >= deadline) {
      return false;
    }
    sleepSync(LOCK_POLL_MS);
  }
}

function dropLock(lock) {
  try {
    fs.unlinkSync(lock);
  } catch {
    // Already gone. Nothing to do.
  }
}

// Returns the launches of the last 7 days, or null when the file cannot be
// trusted. A missing file is an empty ledger: that is the state before the first
// launch. A file that exists but cannot be read as a ledger gives null, so damage
// never frees capacity.
function readLedger(file, now) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    return error.code === "ENOENT" ? [] : null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.launches) || parsed.launches.length > LEDGER_MAX_ENTRIES) {
    return null;
  }
  const kept = [];
  for (const launch of parsed.launches) {
    const at = Date.parse(launch?.ts);
    if (!launch || typeof launch !== "object" || !Number.isFinite(at)) {
      return null;
    }
    // A time in the future counts until the window has passed it, so a wrong
    // clock cannot make an entry disappear early.
    if (now - at < WINDOW_MS) {
      kept.push({ ts: launch.ts, session_id: launch.session_id ?? null, tool_use_id: launch.tool_use_id ?? null });
    }
  }
  return kept;
}

// Checks the count and reserves one launch in a single locked step, so two hooks
// that run at the same time cannot both take the last place.
// Returns { ok: true, count, limit } when this launch has a place, where `count`
// includes it. Returns { ok: false, reason, ... } otherwise:
//   limit_zero     the limit is 0 or not a whole number of 1 or more
//   ledger_busy    the lock could not be taken in time
//   ledger_damaged the file exists but is not a ledger
//   limit_reached  the last 7 days already hold `limit` launches
//   ledger_error   the file could not be written
// The same tool call asks only once: a second request with the same session and
// tool use id answers from the first reservation.
export function reserveFableLaunch({ limit, sessionId = null, toolUseId = null }, env = process.env, now = Date.now()) {
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, reason: "limit_zero", limit: Number.isInteger(limit) ? limit : null };
  }
  const file = fableLedgerFile(env);
  const lock = `${file}.lock`;
  try {
    ensurePrivateDir(path.dirname(file));
  } catch {
    return { ok: false, reason: "ledger_error", limit };
  }
  if (!takeLock(lock)) {
    return { ok: false, reason: "ledger_busy", limit };
  }
  try {
    const launches = readLedger(file, now);
    if (!launches) {
      return { ok: false, reason: "ledger_damaged", limit };
    }
    if (toolUseId && launches.some((launch) => launch.tool_use_id === toolUseId && launch.session_id === sessionId)) {
      return { ok: true, count: launches.length, limit, repeated: true };
    }
    if (launches.length >= limit) {
      return { ok: false, reason: "limit_reached", count: launches.length, limit };
    }
    launches.push({ ts: new Date(now).toISOString(), session_id: sessionId, tool_use_id: toolUseId });
    const fresh = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(fresh, `${JSON.stringify({ launches })}\n`, { mode: 0o600 });
      makeFilePrivate(fresh);
      fs.renameSync(fresh, file);
    } catch {
      try {
        fs.unlinkSync(fresh);
      } catch {
        // The temporary file was never written.
      }
      return { ok: false, reason: "ledger_error", limit };
    }
    return { ok: true, count: launches.length, limit };
  } finally {
    dropLock(lock);
  }
}

// How many launches the last 7 days hold, for the report and the setup check.
// null when the file cannot be trusted.
export function fableLaunchCount(env = process.env, now = Date.now()) {
  const launches = readLedger(fableLedgerFile(env), now);
  return launches ? launches.length : null;
}

// The lock file, when one has been lying there for longer than a hook normally
// runs. A hook holds the lock for a few milliseconds. The age does not prove that
// the owner is gone: a suspended hook can still hold it. So the setup check asks
// the person to make sure that no session starts an agent before removing it.
// Returns the path, or null.
export function fableStaleLock(env = process.env, now = Date.now()) {
  const lock = `${fableLedgerFile(env)}.lock`;
  try {
    return now - fs.statSync(lock).mtimeMs > 60 * 1000 ? lock : null;
  } catch {
    return null;
  }
}
