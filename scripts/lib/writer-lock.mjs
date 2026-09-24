// One lock per working folder for Codex jobs that change files.
//
// A Codex job runs as a detached process. It keeps writing even when the worker
// that started it has stopped. Without a lock the orchestrator could start a
// second writer, or a review, in the same folder while Codex still edits it.
//
// The lock names the job and the process that started it. It counts as held
// while the job has no exit code and one of three processes is alive: the
// process that started the job, the runner, or Codex itself. So a crash never
// blocks the folder, and the moment between the start of a job and its first
// pid file is covered too. Before this, a second start in that moment took the
// lock as stale, and two jobs could write in the same folder.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";

export function jobsDir(env = process.env) {
  return path.join(dataDir(env), "codex-jobs");
}

// The job id that stands for a lock whose job cannot be read. It is never a real
// job id, so no `wait` or `cancel` command can take it; messages say so instead.
export const UNKNOWN_WRITER = "unknown";

// The path of the lock file of `cwd`, for messages that name it.
export function writerLockPath(cwd, env = process.env) {
  return lockFile(cwd, env);
}

// Waits without an event loop. The lock steps are synchronous, and they wait
// only while another start holds the breaker, which takes at most two `ps` calls.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockFile(cwd, env) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {
    // The folder is gone. Use the path as it was given.
  }
  const name = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(dataDir(env), "locks", `${name}.json`);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means that the process exists but belongs to another user.
    return error.code === "EPERM";
  }
}

// True when the pid in `file` is alive and its command line holds `text`.
// A pid alone is not enough: after the runner and Codex are killed with SIGKILL
// no exit code appears, and a later program can get the same pid. Without this
// look at the command line, that program would hold the folder until the job
// folder is pruned after 14 days. `ps` runs only when a lock exists and its pid
// is alive, so a dispatch in a folder without a Codex job pays nothing for it.
// `ps` answers in milliseconds. The route hook can call it twice in one
// dispatch (runner, then Codex), and its timeout in hooks/hooks.json counts both;
// a test checks that.
export const PS_TIMEOUT_MS = 1000;

// What is known about `pid`: "job" when it is alive and its command line holds
// `text`, "other" when it is gone or runs another program, and "unknown" when
// `ps` could not answer. Each caller decides what "unknown" means for it; none
// may read it as "other", because that frees a folder while Codex may still write.
export function pidJobState(pid, text, timeoutMs = PS_TIMEOUT_MS) {
  if (!processIsAlive(pid)) {
    return "other";
  }
  // `-ww` asks for the whole line, whatever width the environment names.
  const result = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: timeoutMs });
  // `ps -p` with a pid that no longer exists ends with 1 and prints nothing.
  // Anything else that is not a clean answer is a failure of `ps` itself.
  if (result.error || result.status === null || (result.status !== 0 && (result.stderr ?? "").trim() !== "")) {
    return "unknown";
  }
  // A pid that ended between the two looks makes `ps` answer with nothing.
  return result.stdout.includes(text) ? "job" : "other";
}

// The pid in `file`, or null when the file is missing or holds no usable pid.
export function readPidFile(file) {
  try {
    const pid = Number(fs.readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

function pidRunsJob(file, text) {
  const pid = readPidFile(file);
  // When `ps` could not answer, the process counts as alive: a folder held too
  // long is safer than two writers.
  return pid !== null && pidJobState(pid, text) !== "other";
}

// The runner is started with the job folder as its argument, and the folder is
// named by the job id.
export function runnerIsAlive(jobDir) {
  return pidRunsJob(path.join(jobDir, "runner.pid"), path.basename(jobDir));
}

// Codex can outlive its runner, for example after `kill -9` on the runner.
// Then no exit code will ever appear, but Codex may still change files. Every
// Codex job is started with `-o <job folder>/result.md`.
export function codexIsAlive(jobDir) {
  return pidRunsJob(path.join(jobDir, "codex.pid"), path.join(path.basename(jobDir), "result.md"));
}

// A starter waits at most 570 seconds for its job and then prints. A lock older
// than this cannot belong to a live starter any more, and a pid that a later
// program reuses must not hold the folder until the job folder is pruned.
const STARTER_MAX_MS = 15 * 60 * 1000;

// A job is active while it has no exit code and one of its processes is alive.
// The starter counts too, while the lock is young: it holds the lock from the
// moment it took it, before the runner exists, and it stays alive while it
// waits for the job.
// One gap stays, accepted on 2026-09-22: when the runner dies between the spawn
// and its write of codex.pid, and the starter is gone in the same moment, nothing
// here can see an orphaned Codex. Two failures in one millisecond.
function jobIsActive(lock, env, now = Date.now()) {
  // A lock that could not be read names no job to look up. It counts as held
  // while it is young; `unreadableLockHolder` has already judged that.
  if (lock.unreadable) {
    return true;
  }
  const dir = path.join(jobsDir(env), lock.job_id);
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, "exit-code"))) {
    return false;
  }
  if (runnerIsAlive(dir) || codexIsAlive(dir)) {
    return true;
  }
  const age = now - Date.parse(lock.created_at);
  return Number.isFinite(age) && age < STARTER_MAX_MS && processIsAlive(lock.starter_pid);
}

// A lock that exists but cannot be read. This plugin writes a lock elsewhere and
// links it into place, so its own locks never look like this. Another version of
// the plugin, or a half-finished write by anything else, still can. Such a file
// is treated as held while it is young, because the alternative is to take the
// checkout from a writer that is very probably running. After the longest a
// starter can live it is treated as stale, so a damaged lock cannot block the
// folder for ever.
function unreadableLockHolder(file, now = Date.now()) {
  try {
    // A file written a moment ago can carry a timestamp a shade ahead of this
    // clock, so a negative age means "just now", not "not yet".
    const age = now - fs.statSync(file).mtimeMs;
    return Number.isFinite(age) && age < STARTER_MAX_MS ? { job_id: "unknown", unreadable: true } : null;
  } catch {
    return null;
  }
}

function readLock(file) {
  try {
    const lock = JSON.parse(fs.readFileSync(file, "utf8"));
    if (lock && typeof lock.job_id === "string") {
      return lock;
    }
  } catch {
    // Falls through: either there is no file, or it cannot be read.
  }
  return fs.existsSync(file) ? unreadableLockHolder(file) : null;
}

// The id of the Codex job that is changing files in `cwd` right now, or null.
export function activeCodexWriter(cwd, env = process.env) {
  if (!cwd) {
    return null;
  }
  const lock = readLock(lockFile(cwd, env));
  return lock && jobIsActive(lock, env) ? lock.job_id : null;
}

// A start holds this only while it removes one dead lock, which takes
// microseconds. Anything older belonged to a start that died inside that step.
const BREAK_MAX_MS = 30 * 1000;

// Takes the breaker of `file`, the second lock under which a lock file is
// removed. Returns true when this process holds it now, false when another
// process is removing a lock at this moment. A breaker older than BREAK_MAX_MS
// belonged to a process that died inside that step, and is taken over.
function takeBreaker(file) {
  const breaker = `${file}.break`;
  const fresh = `${breaker}.new-${process.pid}`;
  try {
    fs.writeFileSync(fresh, new Date().toISOString(), { mode: 0o600 });
    try {
      fs.linkSync(fresh, breaker);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    }
    let age = Number.POSITIVE_INFINITY;
    try {
      age = Date.now() - fs.statSync(breaker).mtimeMs;
    } catch {
      // It went away while being read. The next attempt will see that.
    }
    if (age < BREAK_MAX_MS) {
      return false;
    }
    fs.rmSync(breaker, { force: true });
    try {
      fs.linkSync(fresh, breaker);
      return true;
    } catch {
      return false;
    }
  } finally {
    fs.rmSync(fresh, { force: true });
  }
}

function dropBreaker(file) {
  fs.rmSync(`${file}.break`, { force: true });
}

// Removes a dead lock, and only a dead one. Breaking and taking are one
// protocol: a lock is taken by linking onto a free path, so while a lock file
// exists nobody can put another in its place, and a lock file is only ever
// removed under the breaker: here, or by its own job in releaseWriterLock().
// Two starts that both judge a lock dead therefore cannot both remove it, which
// is what used to let the second remove the fresh lock that the first had
// already written and leave two writers in one checkout.
// Returns "removed", "busy" (another process holds the breaker) or "held" (the
// second look found a live job).
function breakStaleLock(file, env) {
  if (!takeBreaker(file)) {
    return "busy";
  }
  try {
    // Look again. Between the judgement outside this step and this moment, the
    // dead job's lock may have been broken by someone else and the checkout
    // taken by a job that is very much alive.
    const lock = readLock(file);
    if (lock && jobIsActive(lock, env)) {
      return "held";
    }
    fs.rmSync(file, { force: true });
    return "removed";
  } finally {
    dropBreaker(file);
  }
}

// How long a lock step waits while another process holds the breaker. A holder
// needs at most two `ps` calls of PS_TIMEOUT_MS each.
const BREAKER_WAIT_MS = 3 * PS_TIMEOUT_MS;
const BREAKER_POLL_MS = 50;

// Takes the lock for a job. Returns null on success, or the id of the job that
// holds it: UNKNOWN_WRITER when that job cannot be named, because the lock
// cannot be read or another start was still breaking a dead lock at the end.
// The lock is held from this moment on, because it records the pid of the process
// that took it. The caller's job folder must exist already.
export function acquireWriterLock(cwd, jobId, env = process.env, starterPid = process.pid) {
  const file = lockFile(cwd, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + BREAKER_WAIT_MS;
  for (let attempt = 0; ; attempt += 1) {
    // The lock is written somewhere else first and then linked into place.
    // Writing straight to the lock path would create the file and fill it in two
    // steps, and another start that looked in between would read an empty file,
    // judge the lock damaged, and take it while this one believed it held it.
    // `link` fails when the target exists, so two starts still cannot both win,
    // and the lock path never exists with anything but its whole content.
    const fresh = `${file}.new-${process.pid}-${attempt}`;
    try {
      fs.writeFileSync(fresh, JSON.stringify({ job_id: jobId, cwd, starter_pid: starterPid, created_at: new Date().toISOString() }), { mode: 0o600 });
      fs.linkSync(fresh, file);
      return null;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
    } finally {
      fs.rmSync(fresh, { force: true });
    }
    const lock = readLock(file);
    if (lock && jobIsActive(lock, env)) {
      return lock.job_id;
    }
    // The lock belongs to a finished or dead job, or it is damaged. Breaking it
    // happens under the breaker, and the next attempt then takes the free path.
    // While another start holds the breaker, wait for it, but not for ever.
    const outcome = breakStaleLock(file, env);
    if (Date.now() >= deadline) {
      break;
    }
    if (outcome === "busy") {
      sleepSync(BREAKER_POLL_MS);
    }
  }
  return activeCodexWriter(cwd, env) ?? UNKNOWN_WRITER;
}

// Gives back the lock of `jobId`, and only that lock. The look and the removal
// happen under the breaker: without it, another start could break this lock
// (its job has ended) and link its own between the look and the removal, and
// the removal would then delete the new job's lock. Returns false when the
// breaker stayed busy; the lock then stays, and since its job has ended, the
// next start removes it as dead.
export function releaseWriterLock(cwd, jobId, env = process.env) {
  const file = lockFile(cwd, env);
  // No lock, nothing to give back. A lock of this job cannot appear later.
  if (!fs.existsSync(file)) {
    return true;
  }
  const deadline = Date.now() + BREAKER_WAIT_MS;
  while (!takeBreaker(file)) {
    if (Date.now() >= deadline) {
      return false;
    }
    sleepSync(BREAKER_POLL_MS);
  }
  try {
    const lock = readLock(file);
    if (lock && lock.job_id === jobId) {
      fs.rmSync(file, { force: true });
    }
    return true;
  } finally {
    dropBreaker(file);
  }
}
