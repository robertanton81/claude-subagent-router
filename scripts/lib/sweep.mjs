// The Codex job worker of the finding triage. It scans the Codex job folders
// for finished review jobs, whoever started them, and triages each one once:
// the same parsing, consent and redaction as the SubagentStop hook, but the
// evidence must provably equal the code that Codex reviewed.
//
// A short launcher (scripts/triage-sweep.mjs, on Stop and SessionStart) starts
// the worker as a detached process, so the end of a session cannot cut it. The
// worker gets only the shared settings in its environment, without the
// TypeSafe key; the launcher passes the key through the worker's input pipe.
// The key goes to no file, no command line and no environment.

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.mjs";
import { readJobResult } from "./codex-result.mjs";
import { changeGroup, readCheckedExcerpt, repoState } from "./evidence.mjs";
import { parseFindings } from "./findings.mjs";
import { appendLog, ensurePrivateDir, registerSecret, registeredSecrets, truncate } from "./log.mjs";
import { poolOf, poolsReserved } from "./pools.mjs";
import { evalVersion } from "./questions.mjs";
import { redactSecrets } from "./secret-patterns.mjs";
import { askJev, consentDecision, prepareFinding, triageOn } from "./triage-core.mjs";
import {
  DEFER_MAX,
  claim,
  cleanup,
  clearDeferral,
  deferJob,
  deferral,
  isDone,
  isSkipped,
  markSkipped,
  ownsClaim,
  publishDoneOnce,
  releaseIfOwner,
  triageDir,
  writeDoneOnce
} from "./triage-state.mjs";
import { findApiKey } from "./typesafe.mjs";
import { jobsDir } from "./writer-lock.mjs";

const ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "triage-sweep.mjs");

export const LOCK_STALE_MS = 15 * 60 * 1000;
// Job folders are pruned after 14 days and done records kept for 30, so a job
// older than 13 days is never taken: its record can never vanish while the job
// can still be found.
export const JOB_MAX_AGE_MS = 13 * 24 * 60 * 60 * 1000;
export const RUN_MAX_JOBS = 25;
export const RUN_MAX_MS = 10 * 60 * 1000;
const NO_KEY_LOG_MS = 24 * 60 * 60 * 1000;
const CODEX_REVIEWER = "subagent-router:codex-reviewer";

const lockFile = (env) => path.join(triageDir(env), "sweep.lock");
const sinceFile = (env) => path.join(triageDir(env), "sweep-since.json");

function hookError(hook, error, extra = {}, env = process.env) {
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook, error: String(error?.message ?? error), ...extra }, env);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temp, file);
}

// A process that is gone answers ESRCH; one of another user answers EPERM and
// counts as alive.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function lockIsLive(lock, now) {
  return Boolean(lock) && pidAlive(lock.pid) && now - Number(lock.startedAt) < LOCK_STALE_MS;
}

// True when a worker holds a live lock, so a launcher need not start another.
export function sweepRunning(env = process.env, now = Date.now()) {
  try {
    return lockIsLive(readJson(lockFile(env)), now);
  } catch {
    // No lock, or one that cannot be read: a worker started now takes it over.
    return false;
  }
}

const ERR_MAX_BYTES = 256 * 1024;

// The settings that all sessions share: the environment without the variables
// that switch something for one session only (ORCH_MODE, ORCH_JEV_ENABLED,
// ORCH_TYPESAFE_URL and the like). The data folder variable stays, because it
// names the settings file. The worker serves every session, so it must never
// follow one session's switches, and least of all one session's address for
// Jev.
export function sharedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("ORCH_") || name === "ORCH_DATA_DIR"));
}

const KEY_NAMES = ["CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY", "TYPESAFE_API_KEY"];

// Starts the worker as a detached process and returns at once. The worker's
// error output goes to a private file (cut when it grows past ERR_MAX_BYTES),
// so a failure that could not reach the dispatch log is still visible.
export function startSweepWorker(env = process.env) {
  // Tests of the hooks set this, so no worker outlives a test's folder.
  if (env.ORCH_TRIAGE_NO_WORKER === "1") return;
  ensurePrivateDir(triageDir(env));
  const errFile = path.join(triageDir(env), "sweep-worker.err");
  try {
    if (fs.statSync(errFile).size > ERR_MAX_BYTES) fs.truncateSync(errFile, 0);
  } catch {
    // No file yet.
  }
  // The key goes to the worker through a pipe, never through its environment:
  // the worker runs git in every job's checkout, and a program that a
  // repository's settings make git run could read its parent's environment
  // (ps -E on macOS, /proc on Linux). Its environment holds the shared
  // settings only.
  const { key } = findApiKey(env);
  const childEnv = Object.fromEntries(Object.entries(sharedEnv(env)).filter(([name]) => !KEY_NAMES.includes(name)));
  childEnv.ORCH_SWEEP_KEY_ON_STDIN = "1";
  const errors = fs.openSync(errFile, "a", 0o600);
  try {
    const child = spawn(process.execPath, [ENTRY, "--worker"], { detached: true, stdio: ["pipe", "ignore", errors], env: childEnv });
    child.on("error", (error) => hookError("triage-sweep", error, { stage: "start_worker" }, env));
    child.stdin.on("error", () => {
      // The worker ended before it read the key; it then claims nothing.
    });
    child.stdin.end(key ?? "");
    child.unref();
  } finally {
    fs.closeSync(errors);
  }
}

// One worker at a time. The lock holds a random token; a lock whose process is
// gone, or which is older than LOCK_STALE_MS, is taken over. A separate
// exclusive file decides between two takers, as for a stale triage claim.
export function takeLock(env = process.env, now = Date.now()) {
  ensurePrivateDir(triageDir(env));
  const file = lockFile(env);
  const token = randomUUID();
  const mine = { token, pid: process.pid, startedAt: now };
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify(mine));
    fs.closeSync(fd);
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  let current = null;
  try {
    current = readJson(file);
  } catch {
    // A lock that cannot be read is taken over like a stale one.
  }
  if (lockIsLive(current, now)) return null;
  const takeover = `${file}.takeover`;
  try {
    fs.closeSync(fs.openSync(takeover, "wx", 0o600));
  } catch (error) {
    if (error.code === "EEXIST") {
      // A taker that died leaves this file; after a minute it no longer blocks.
      try {
        if (now - fs.statSync(takeover).mtimeMs > 60 * 1000) fs.rmSync(takeover, { force: true });
      } catch {
        // Removed by another taker meanwhile; the next launcher tries again.
      }
      return null;
    }
    throw error;
  }
  try {
    let again = null;
    try {
      again = readJson(file);
    } catch {
      // Still unreadable: take it.
    }
    if (lockIsLive(again, now)) return null;
    writeAtomic(file, mine);
    return token;
  } finally {
    fs.rmSync(takeover, { force: true });
  }
}

export function ownsLock(token, env = process.env) {
  try {
    return readJson(lockFile(env)).token === token;
  } catch {
    // A lock that is gone or cannot be read is not ours: the worker stops.
    return false;
  }
}

function releaseLock(token, env) {
  if (ownsLock(token, env)) fs.rmSync(lockFile(env), { force: true });
}

// The start time: jobs that ended before it are never triaged, so old jobs
// are not judged against today's code and do not spend the key's balance at
// once. The launcher publishes it while the triage is on and removes it while
// the triage is off. The end of every Codex job removes it too while the
// triage is off, so a job that ended while the triage was off is never sent
// later, also when no launcher ran before the triage was switched on again. The whole file is written under a temporary name and linked to
// the final name; a link fails when the name exists, so exactly one complete
// start time is published.
export function sweepSince(env = process.env, now = Date.now()) {
  const file = sinceFile(env);
  if (!fs.existsSync(file)) {
    ensurePrivateDir(triageDir(env));
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ since: new Date(now).toISOString() }), { mode: 0o600 });
    try {
      fs.linkSync(temp, file);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }
  const since = Date.parse(readJson(file).since);
  if (!Number.isFinite(since)) throw new Error("sweep-since.json holds no valid time");
  return since;
}

export function removeSweepSince(env = process.env) {
  fs.rmSync(sinceFile(env), { force: true });
}

const JOB_ID = /^[A-Za-z0-9-]+$/;

// Finished review jobs that are neither done nor skipped, oldest first. A job
// that can never be used gets a skip marker, so later scans skip it.
export function scanJobs(sinceMs, env = process.env, now = Date.now()) {
  const root = jobsDir(env);
  if (!fs.existsSync(root)) return [];
  const found = [];
  for (const id of fs.readdirSync(root)) {
    if (!JOB_ID.test(id)) continue;
    const key = `job-${id}`;
    if (isDone(key, env) || isSkipped(key, env)) continue;
    if (Number(deferral(key, env)?.until) > now) continue;
    const dir = path.join(root, id);
    let job;
    try {
      job = readJson(path.join(dir, "job.json"));
    } catch (error) {
      // No job.json yet: the job is still being created. One that exists but
      // cannot be read never becomes readable, so it is skipped permanently.
      if (error.code !== "ENOENT") markSkipped(key, "unreadable_job", env);
      continue;
    }
    if (!job || typeof job !== "object") {
      markSkipped(key, "unreadable_job", env);
      continue;
    }
    if (job.kind !== "review") {
      markSkipped(key, "not_a_review", env);
      continue;
    }
    let marker;
    let endMs;
    try {
      marker = fs.readFileSync(path.join(dir, "exit-code"), "utf8").trim();
      endMs = fs.statSync(path.join(dir, "exit-code")).mtimeMs;
    } catch {
      // No exit-code: the job has not ended.
      continue;
    }
    // An empty or half-written marker means "not finished", never exit 0.
    if (!/^\d+$/.test(marker)) continue;
    if (endMs < sinceMs) {
      markSkipped(key, "before_start", env);
      continue;
    }
    if (now - endMs > JOB_MAX_AGE_MS) {
      markSkipped(key, "too_old", env);
      continue;
    }
    found.push({ id, key, job, endMs });
  }
  return found.sort((a, b) => a.endMs - b.endMs);
}

// The rule that the evidence of one job must pass, worked out once per job.
// Returns a function for prepareFinding. Evidence is sent only when its bytes
// provably equal the code that Codex reviewed, and only a commit review allows
// that proof: the bytes must have the git blob id (git's id for those exact
// bytes) of the reviewed commit's file. Codex reviews a base scope with
// "git diff <merge base>" against the working tree, and the working tree can
// change in ways that no later check reveals; an uncommitted scope is the
// working tree itself; a custom brief may name any commit. So those give
// "unverifiable_scope" and send nothing.
function evidenceReader(job, repo) {
  if (job.provenance !== 1) return () => ({ outcome: "missing_provenance" });
  if (job.scope?.type !== "commit") return () => ({ outcome: "unverifiable_scope" });
  if (!job.scope_commit) return () => ({ outcome: "stale_evidence" });
  return (citation) => readCheckedExcerpt(repo.root, citation, { mode: "blob", commit: job.scope_commit });
}

const TRANSIENT_JEV = /^(timeout|network|http_402|http_429|http_5\d\d|consent_unknown)$/;

const reportIdOf = (jobId) => createHash("sha256").update(`job\n${jobId}`).digest("hex").slice(0, 16);

// Triages one job under an owned claim. Returns true when the job counted
// against the run's budget (it was claimed), false when it was skipped or
// postponed.
export async function processJob(candidate, config, env = process.env, ownsRun = () => true, apiKey = null) {
  const { id, key, job } = candidate;
  const claimed = claim(key, { env });
  if (!claimed.claimed) {
    if (claimed.reason === "abandoned") {
      // Published once: a result of an earlier attempt is never replaced.
      publishDoneOnce(key, { event: "triage", gate: "triage", job_id: id, agent_type: CODEX_REVIEWER, report_id: reportIdOf(id), error: "abandoned" }, env);
    }
    return false;
  }
  const { token } = claimed;
  const repo = repoState(job.cwd);
  const consent = consentDecision(repo, config);
  if (consent === "refused") {
    // Consent is judged once per job.
    markSkipped(key, "not_consented", env);
    releaseIfOwner(key, token, env);
    return false;
  }
  if (consent === "unknown") {
    // A missing checkout (an unmounted disk) or a failed git lookup may pass
    // later: try again in an hour, at most DEFER_MAX times.
    const reason = repo.root ? "consent_unknown" : "checkout_missing";
    if (deferJob(key, reason, env) >= DEFER_MAX) markSkipped(key, reason, env);
    releaseIfOwner(key, token, env);
    return false;
  }
  const result = readJobResult(id, env);
  const parse = parseFindings(typeof result.text === "string" ? result.text : null, { parser: "p_tags" });
  const secrets = registeredSecrets();
  const reportId = reportIdOf(id);
  const readEvidence = evidenceReader(job, repo);
  let redactions = 0;
  const findings = parse.items.map((item) => {
    const prepared = prepareFinding(item, repo, secrets, readEvidence);
    redactions += prepared.redactions;
    return { ...prepared.finding, finding_id: `${reportId}#${item.index}` };
  });
  const jev = await askJev(findings, job.cwd, config, { env, apiKey, beforeSend: () => ownsRun() && ownsClaim(key, token, env) });
  // This worker lost its lock or its claim: the owner now does the job.
  if (jev.error === "not_owner") {
    releaseIfOwner(key, token, env);
    return true;
  }
  // A Jev outage, a rate limit or a used-up balance may end: try again in an
  // hour, and keep the error only after DEFER_MAX tries.
  if (TRANSIENT_JEV.test(jev.error ?? "") && deferJob(key, `jev_${jev.error}`, env) < DEFER_MAX) {
    releaseIfOwner(key, token, env);
    return true;
  }
  for (const f of findings) {
    if (f.outcome === null) f.outcome = "error";
  }
  const snapshot = typeof result.text === "string" ? redactSecrets(result.text, registeredSecrets()) : null;
  const reviewedCommit = job.scope?.type === "commit" ? (job.scope_commit ?? null) : (job.head ?? null);
  const group = changeGroup({ commonDir: repo.commonDir, head: reviewedCommit }, "job", id);
  const version = evalVersion(config);
  const record = {
    ts: new Date().toISOString(),
    session_id: job.session_id ?? null,
    cwd: job.cwd ?? null,
    event: "triage",
    gate: "triage",
    mode: config.triageMode,
    report_id: reportId,
    job_id: id,
    agent_id: null,
    agent_type: CODEX_REVIEWER,
    origin: job.origin ?? null,
    scope: job.scope ?? null,
    reviewed_commit: reviewedCommit,
    attempt: claimed.attempts,
    source: typeof result.text === "string" ? "codex_job" : "unavailable",
    reason: typeof result.text === "string" ? null : result.reason,
    report_chars: typeof result.text === "string" ? result.text.length : 0,
    triage_version: version,
    eval_version: version,
    change_group: group.key,
    group_eligible: group.eligible,
    repo: { root: repo.root, common_dir: repo.commonDir, head: repo.head, dirty: repo.dirty, error: repo.error },
    parse: { state: parse.state, parser: parse.parser, count: parse.count },
    redactions: redactions + (snapshot?.count ?? 0),
    findings,
    jev
  };
  // Only the first result is kept; a worker that lost its claim, or came
  // second, writes no log record either.
  if (!writeDoneOnce(key, token, { ...record, snapshot: snapshot?.withheld ? null : (snapshot?.text ?? null) }, env)) {
    return true;
  }
  appendLog({ ...record, findings: findings.map((f) => ({ ...f, excerpt: truncate(f.excerpt, config.resultLogChars) })) }, env);
  clearDeferral(key, env);
  releaseIfOwner(key, token, env);
  return true;
}

// A keyless session (for example a session-only copy of the plugin, which gets
// no plugin options) must not mark jobs as done. It logs at most once a day.
export function reportNoKey(env = process.env) {
  const marker = path.join(triageDir(env), "no-key-logged");
  try {
    if (Date.now() - fs.statSync(marker).mtimeMs < NO_KEY_LOG_MS) return;
  } catch {
    // No marker yet.
  }
  hookError("triage-sweep-worker", "no TypeSafe key reached the worker; no job was claimed", { reason: "no_key" }, env);
  ensurePrivateDir(triageDir(env));
  fs.writeFileSync(marker, "", { mode: 0o600 });
}

// keyFromLauncher: the key that the launcher sent through the pipe, or null
// when the worker was started by hand (then the environment is used).
export async function runWorker(env = process.env, keyFromLauncher = null) {
  const { config, warnings } = loadConfig(env);
  // The worker's error output goes to triage/sweep-worker.err.
  for (const warning of warnings) {
    process.stderr.write(`subagent-router config: ${warning}\n`);
  }
  if (!triageOn(config)) return;
  const key = keyFromLauncher || findApiKey(env).key;
  // No copy of the key stays in this process's environment, so a child (git)
  // never inherits it.
  for (const name of KEY_NAMES) delete env[name];
  if (!key) {
    reportNoKey(env);
    return;
  }
  // Registered before any report or file is read, so every redaction masks it.
  registerSecret(key);
  const token = takeLock(env);
  if (!token) return;
  try {
    const since = sweepSince(env);
    const started = Date.now();
    const ownsRun = () => ownsLock(token, env);
    let processed = 0;
    // The launcher and the end of every Codex job remove the start time while
    // the triage is off, and the launcher publishes a new one when it is on again. A run that sees it change
    // stops, so a job that ended while the triage was off is never sent.
    const sameStart = () => {
      try {
        return Date.parse(readJson(sinceFile(env)).since) === since;
      } catch {
        // No start time any more: the triage was switched off.
        return false;
      }
    };
    for (;;) {
      let counted = 0;
      for (const candidate of scanJobs(since, env)) {
        if (processed >= RUN_MAX_JOBS || Date.now() - started >= RUN_MAX_MS || !ownsRun() || !sameStart()) return;
        try {
          if (await processJob(candidate, config, env, ownsRun, key)) {
            counted += 1;
            processed += 1;
          }
        } catch (error) {
          hookError("triage-sweep-worker", error, { job_id: candidate.id }, env);
        }
      }
      // Nothing new was claimed in this pass: the rest is busy or done.
      if (counted === 0) break;
    }
    cleanup({ env, keepDone: (_key, result) => poolsReserved(env) && result.group_eligible === true && poolOf(result.change_group) === "evaluation" });
  } finally {
    releaseLock(token, env);
  }
}
