#!/usr/bin/env node
// Command line for the two Codex workers.
//
//   orch-codex.mjs run <request id> [--wait S]
//     Starts the task that the routing hook stored. This is what the workers use.
//   orch-codex.mjs wait <job id> [--wait S]
//     Waits for a job that is still running.
//   orch-codex.mjs cancel <job id>
//     Stops a running job and frees the writer lock of its folder.
//
// For manual use and for the tests, the task text comes from stdin or from a file:
//   orch-codex.mjs implement [--brief FILE] [--model M] [--effort E] [--wait S]
//   orch-codex.mjs review [--uncommitted | --base B | --commit SHA | --custom]
//                         [--brief FILE] [--model M] [--effort E] [--wait S]
//     With a scope flag, Codex reviews that diff with its own rules and takes no task text.
//     With --custom, Codex gets the text as its review instructions and no scope flag.
//   orch-codex.mjs consult [--brief FILE] [--model M] [--effort E] [--wait S]
//     Asks Codex a question that is not a code review, such as a design question.
//     Codex reads the project in a read-only sandbox and takes no writer lock.
//
// --brief FILE reads the task text from FILE instead of stdin. A call with the
// option and no redirect can match an entry of Claude Code's sandbox setting
// excludedCommands; a call with `< FILE` never leaves the sandbox. The file must
// lie under the system temp folder, because an excluded call runs with the
// user's full access and the text goes to Codex.
//
// A Codex task can run longer than the 10-minute maximum of the Bash tool.
// So the job runs as a detached process, and this command only waits for it.
// When the wait ends first, it prints STILL_RUNNING and the command to wait again.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tty from "node:tty";
import { fileURLToPath } from "node:url";

import { claudeRules } from "./lib/claude-rules.mjs";
import { UsageError, briefContract, parseOptions, runsReadOnlyExec, sendsBriefToCodex, stripCodexApiKeys } from "./lib/codex-args.mjs";
import { holdsPrivateKey, isSensitivePath } from "./lib/secret-patterns.mjs";
import { isUsageLimitMessage } from "./lib/codex-availability.mjs";
import { earlierLongMessages, readEvents } from "./lib/codex-events.mjs";
import { readLimitsOfThread } from "./lib/codex-limits.mjs";
import { REQUEST_ID_PATTERN, claimRequest, recordJobOfRequest, restoreRequest } from "./lib/codex-request.mjs";
import { dataDir, loadConfig } from "./lib/config.mjs";
import { ensurePrivateDir } from "./lib/log.mjs";
import { briefOpenRefusal, openWithoutLinks, systemTempFolder } from "./lib/open-no-links.mjs";
import { claimRefusedMessage, isPermissionError } from "./lib/protected-copy.mjs";
import { resolveCommitWithReason, worktreeDirty } from "./lib/evidence.mjs";
import { removeSweepSince, sharedEnv, sweepSince } from "./lib/sweep.mjs";
import { triageOn } from "./lib/triage-core.mjs";
import { codexPlatformSupported } from "./lib/provider-state.mjs";
import {
  UNKNOWN_WRITER,
  acquireWriterLock,
  codexIsAlive,
  isClaudeWriter,
  jobsDir,
  pidJobState,
  readPidFile,
  releaseWriterLock,
  runnerIsAlive,
  writerLockPath
} from "./lib/writer-lock.mjs";

const SELF = fileURLToPath(import.meta.url);
const RUNNER = path.join(path.dirname(SELF), "codex-job-runner.mjs");
const PLUGIN_ROOT = path.dirname(path.dirname(SELF));
const DEFAULT_WAIT_SECONDS = 540;
const KEEP_MS = 14 * 24 * 3600 * 1000;
const JOB_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

// The text on stdin, read to its end. tty.isatty does not touch process.stdin:
// reading process.stdin.isTTY creates Node's stdin stream, which turns fd 0
// non-blocking, and a read that came before the caller's text then failed with
// EAGAIN. The old catch turned that into an empty text, so a slow pipe gave
// "needs a brief" (seen on a macOS CI runner). EAGAIN from a pipe that a caller
// opened non-blocking waits a moment and reads again. Only a missing stdin
// (EBADF) counts as no text; any other error stays visible.
function readStdin() {
  if (tty.isatty(0)) {
    return "";
  }
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let count;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      if (error.code === "EAGAIN") {
        Atomics.wait(pause, 0, 0, 10);
        continue;
      }
      if (error.code === "EBADF") return "";
      throw error;
    }
    if (count === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The folders a brief file may come from: the temp folders where a session
// writes its briefs, never the working folder. The session picks its working
// folder, and the environment picks os.tmpdir() (TMPDIR): either at the home
// folder would make every file under it, token stores included, a possible
// brief. So a folder counts only when its real path is a system temp folder
// (systemTempFolder). Real paths, so a link cannot point elsewhere.
function briefRoots() {
  const roots = new Set();
  for (const folder of [os.tmpdir(), "/tmp"]) {
    let real;
    try {
      real = fs.realpathSync(folder);
    } catch {
      // A folder that does not exist on this machine cannot hold the file.
      continue;
    }
    if (systemTempFolder(real)) roots.add(real);
  }
  return [...roots];
}

function readBriefFile(file, cwd) {
  const given = path.resolve(cwd, file);
  // A credential file must never become a brief: its whole content would go to
  // Codex. The instruction collector refuses the same conventional names. This
  // runs before any file is opened, so a refused path is never even read.
  if (isSensitivePath(given)) {
    throw new UsageError(`--brief: ${file} looks like a credential file, which must not be sent as a brief`);
  }
  // Resolve links and check the real location and name before opening anything,
  // so a file outside the allowed folders is refused without a read.
  let real;
  try {
    real = fs.realpathSync(given);
  } catch (error) {
    throw new UsageError(`--brief: the file ${file} cannot be read: ${error.message}`);
  }
  if (isSensitivePath(real)) {
    throw new UsageError(`--brief: ${file} resolves to a credential file, which must not be sent as a brief`);
  }
  const roots = briefRoots();
  if (roots.length === 0) {
    throw new UsageError(`--brief: no temp folder of this system lies in a system temp folder (TMPDIR is ${os.tmpdir()}), so no brief file can be read. Give the text on stdin instead`);
  }
  if (!roots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
    throw new UsageError(`--brief: ${file} lies outside the temp folder. Put the brief under one of these: ${roots.join(", ")}`);
  }
  // Open the resolved real path, not the name. This command can run outside the
  // sandbox, so a concurrent process must not be able to swap the checked path,
  // or any folder in it, for a link between the check and the open (a
  // time-of-check/time-of-use race). openWithoutLinks refuses a link in any
  // part of the path at the moment of the open, and opens without blocking on
  // a named pipe (FIFO); the file-type check below then rejects a pipe. The
  // read is through the descriptor, so it is the file that was just checked.
  let fd;
  try {
    fd = openWithoutLinks(real);
  } catch (error) {
    throw new UsageError(briefOpenRefusal(error, file));
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) {
      throw new UsageError(`--brief: ${file} is not a regular file`);
    }
    // A second hard link is the one way to make a file from elsewhere look like
    // a file under the allowed folders, because a real path does not show it.
    if (opened.nlink > 1) {
      throw new UsageError(`--brief: ${file} has more than one hard link, so it may be a file from elsewhere. Copy it instead.`);
    }
    let text;
    try {
      text = fs.readFileSync(fd, "utf8");
    } catch (error) {
      throw new UsageError(`--brief: the file ${file} cannot be read: ${error.message}`);
    }
    // A brief that holds a private key, whatever its name, is held back too.
    if (holdsPrivateKey(text)) {
      throw new UsageError(`--brief: ${file} holds what looks like a private key, which must not be sent as a brief`);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

// The task text of a manual implement, review or consult: from --brief FILE, or
// from stdin. Both at once is a mistake, so it is refused.
function readBrief(options, cwd) {
  const fromStdin = readStdin();
  if (options.briefFile === null) {
    return fromStdin;
  }
  if (fromStdin.trim().length > 0) {
    throw new UsageError("--brief and stdin both carry a task text. Give the text in one of them.");
  }
  return readBriefFile(options.briefFile, cwd);
}

function newJobId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

// Removes job folders and request files that are older than two weeks.
// One entry that cannot be removed must not stop the clean-up of the others.
function pruneOld() {
  for (const dir of [jobsDir(), path.join(dataDir(), "codex-requests")]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error.code !== "ENOENT") {
        process.stderr.write(`subagent-router: cannot list ${dir}: ${error.message}\n`);
      }
      continue;
    }
    for (const name of names) {
      const entry = path.join(dir, name);
      try {
        if (Date.now() - fs.statSync(entry).mtimeMs > KEEP_MS) {
          fs.rmSync(entry, { recursive: true, force: true });
        }
      } catch (error) {
        if (error.code !== "ENOENT") {
          process.stderr.write(`subagent-router: cannot remove the old entry ${entry}: ${error.message}\n`);
        }
      }
    }
  }
}

// Why a start was refused. A holder that cannot be named gets no `wait` or
// `cancel` command, because those commands refuse an id that is not a job id.
function busyText(holder, cwd) {
  if (isClaudeWriter(holder)) {
    return `a Claude writer of a Claude Code session is still changing files in the checkout of ${cwd}. Wait until it has finished, then try again. If you are sure that no writer runs, remove the lock file: ${writerLockPath(cwd)}`;
  }
  if (holder === UNKNOWN_WRITER) {
    return (
      `the writer lock of ${cwd} is held, but its job cannot be named: the lock cannot be read, or another start was removing an old lock. ` +
      `Try again in a minute. A lock that cannot be read stops counting 15 minutes after it was written: ${writerLockPath(cwd)}`
    );
  }
  return `the Codex job ${holder} is still changing files in ${cwd}. Wait for it with "wait ${holder}" or stop it with "cancel ${holder}"`;
}

// Where a review came from and which code it saw, written before the runner
// starts. The finding triage reads it later to tell the reviewed code from code
// that changed since; a lookup that fails leaves null and never stops the job.
function provenanceOf({ kind, scope, cwd, origin, requestId }) {
  const head = resolveCommitWithReason(cwd, "HEAD");
  const scoped = kind === "review" && (scope?.type === "commit" || scope?.type === "base") ? resolveCommitWithReason(cwd, scope.value) : { id: null, error: null };
  return {
    provenance: 1,
    origin,
    request_id: requestId ?? null,
    session_id: process.env.CLAUDE_CODE_SESSION_ID || null,
    head: head.id,
    dirty: head.id ? worktreeDirty(cwd) : null,
    scope_commit: scope?.type === "commit" ? scoped.id : null,
    base_commit: scope?.type === "base" ? scoped.id : null,
    provenance_error: head.error ?? scoped.error ?? null
  };
}

// The finding triage takes only jobs that end after its start time. The
// launcher publishes that time at turn ends; a review started earlier in the
// first turn after the switch-on would end before it, so the start of a review
// publishes it too. It follows the shared settings only, and a failure never
// stops the job.
function publishTriageStart() {
  try {
    const { config } = loadConfig(sharedEnv());
    if (triageOn(config) && config.triageProjects.length > 0) {
      sweepSince();
    }
  } catch (error) {
    process.stderr.write(`subagent-router: the triage start time could not be published: ${error.message}\n`);
  }
}

function startJob({ kind, model, effort, scope, brief, cwd, origin = "direct", requestId = null }) {
  if (!codexPlatformSupported()) {
    throw new UsageError("Codex jobs need macOS or Linux: they use `ps` and process groups to know when a job has ended");
  }
  const { config, warnings } = loadConfig();
  for (const warning of warnings) {
    process.stderr.write(`subagent-router config: ${warning}\n`);
  }

  // Before the job takes its start time, so the triage's start time is never
  // later than it.
  if (kind === "review") {
    publishTriageStart();
  }
  const job = {
    id: newJobId(),
    kind,
    cwd,
    model: model ?? null,
    effort: effort ?? null,
    scope: kind === "review" ? scope ?? { type: "uncommitted" } : null,
    has_brief: brief.trim().length > 0,
    created_at: new Date().toISOString()
  };
  Object.assign(job, provenanceOf({ kind, scope: job.scope, cwd, origin, requestId }));
  if (sendsBriefToCodex(job) && !job.has_brief) {
    const missing = { implement: "implement needs the task text", consult: "consult needs the question" };
    throw new UsageError(missing[kind] ?? "review --custom needs the review instructions");
  }
  pruneOld();

  // The job folder holds the brief and the result, so only this user may enter it.
  const dir = path.join(jobsDir(), job.id);
  ensurePrivateDir(jobsDir());
  ensurePrivateDir(dir);
  if (kind === "implement") {
    // Only one Codex job may change files in a folder at a time.
    const holder = acquireWriterLock(cwd, job.id);
    if (holder) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new UsageError(`writer_busy: ${busyText(holder, cwd)}`);
    }
  }
  if (job.has_brief) {
    let extras = "";
    if (sendsBriefToCodex(job)) {
      const rules = claudeRules(cwd, config);
      job.rules = rules.notes;
      extras = `${briefContract(job)}${rules.text}`;
    }
    fs.writeFileSync(path.join(dir, "brief.md"), `${brief}${extras}`, { mode: 0o600 });
  }
  // Through a temporary file and a rename, so a reader never sees half a job.
  const jobFile = path.join(dir, "job.json");
  fs.writeFileSync(`${jobFile}.tmp`, JSON.stringify(job, null, 2), { mode: 0o600 });
  fs.renameSync(`${jobFile}.tmp`, jobFile);

  // The output of the runner goes to a file, so a crash of the runner leaves a reason.
  const runnerLog = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
  const child = spawn(process.execPath, [RUNNER, dir], { detached: true, stdio: ["ignore", runnerLog, runnerLog], cwd });
  child.on("error", (error) => {
    fs.appendFileSync(path.join(dir, "runner.log"), `the runner could not start: ${error.message}\n`);
  });
  // From here on the job runs, so nothing below may throw: a caller that sees an
  // error from this function must be able to assume that no runner was started.
  try {
    // The pid lets a later `wait` see that the runner died without a result.
    fs.writeFileSync(path.join(dir, "runner.pid"), String(child.pid ?? ""), { mode: 0o600 });
  } catch (error) {
    process.stderr.write(`subagent-router: runner.pid could not be written for the job ${job.id}: ${error.message}\n`);
  }
  child.unref();
  return dir;
}

// Returns "done", "timeout" or "dead". "dead" means that no process of the job
// is alive and there is no exit code, so nothing can finish this job any more.
async function waitForJob(dir, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  const marker = path.join(dir, "exit-code");
  let checksWithoutProcess = 0;
  for (;;) {
    if (fs.existsSync(marker)) {
      return "done";
    }
    // Two checks in a row, so a runner that exits right after writing the
    // marker is not mistaken for a dead one.
    checksWithoutProcess = runnerIsAlive(dir) || codexIsAlive(dir) ? 0 : checksWithoutProcess + 1;
    if (checksWithoutProcess >= 2) {
      return fs.existsSync(marker) ? "done" : "dead";
    }
    if (Date.now() >= deadline) {
      return "timeout";
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function tail(file, lineCount) {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lineCount).join("\n");
  } catch {
    return "";
  }
}

function readJob(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "job.json"), "utf8"));
  } catch {
    return {};
  }
}

function describeJob(job) {
  if (job.kind === "consult") {
    return " kind=consult";
  }
  if (job.kind !== "review") {
    return "";
  }
  const scope = job.scope ?? { type: "uncommitted" };
  return ` scope=${scope.type}${scope.value ? `:${scope.value}` : ""}`;
}

// The answer of a read-only job, with any earlier agent message that may hold
// the real answer. See earlierLongMessages() in codex-events.mjs.
function fullAnswer(job, result, events) {
  if (!runsReadOnlyExec(job)) {
    return result;
  }
  const earlier = earlierLongMessages(events.messages, result);
  if (earlier.length === 0) {
    return result;
  }
  const label = "--- Codex wrote this earlier message, longer than its final message. It may hold the answer: ---";
  return [result, ...earlier.map((text) => `\n${label}\n${text}`)].join("\n");
}

function readResult(dir) {
  const file = path.join(dir, "result.md");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

// Prints the outcome of a finished job. Returns the exit code for this command.
function printResult(dir) {
  const id = path.basename(dir);
  const code = Number(fs.readFileSync(path.join(dir, "exit-code"), "utf8").trim());
  const result = readResult(dir);
  const job = readJob(dir);
  const events = readEvents(dir);

  // Codex writes its limit numbers only into its own session file. The runner
  // saved them when Codex ended (see codex-events.mjs); here they are only shown.
  const limits = readLimitsOfThread(events.threadId);
  const used = limits ? ` codex_used=${Math.round(limits.usedPercent)}%` : "";

  if (code === 0 && result) {
    // Codex reports zero tokens for a review run, so show the numbers only when they are real.
    const tokens = events.usage?.input_tokens > 0 ? ` input_tokens=${events.usage.input_tokens} output_tokens=${events.usage.output_tokens ?? "?"}` : "";
    const credits =
      limits && limits.usedPercent >= 100
        ? `Note for the user: a Codex plan window is used up, so this run was paid from Codex credits. Balance now: ${limits.creditsBalance ?? "unknown"}.\n`
        : "";
    process.stdout.write(`CODEX_JOB ${id} exit=0${describeJob(job)}${tokens}${used}\n${credits}${fullAnswer(job, result, events)}\n`);
    return 0;
  }

  const reasons = [];
  // The runner has already started the routing pause for this case.
  if (isUsageLimitMessage(events.error)) {
    reasons.push("Codex has no capacity left. Tell the user in one sentence, and send this task to a Claude worker now: subagent-router:implementer, or subagent-router:reviewer for a review. The routing hook does the same for later Codex tasks until the plan resets.");
  }
  if (events.error) {
    reasons.push(`Codex reported: ${events.error}`);
  }
  if (code === 0) {
    reasons.push("Codex ended without a final message.");
  }
  const errorOutput = tail(path.join(dir, "stderr.log"), events.error ? 5 : 20);
  if (errorOutput) {
    reasons.push(errorOutput);
  }
  process.stdout.write(`CODEX_FAILED ${id} exit=${code}${describeJob(job)}\n${reasons.join("\n")}\nDetails: ${dir}\n`);
  return 1;
}

function printDead(dir) {
  const id = path.basename(dir);
  const result = readResult(dir);
  const lines = [
    `CODEX_FAILED ${id} runner_died`,
    "The process that ran Codex ended without an exit code, so this job cannot finish. Waiting again will not help."
  ];
  if (result) {
    lines.push("Codex had already written this final message. Its exit code is unknown:", result);
  }
  const runnerLog = tail(path.join(dir, "runner.log"), 10);
  const errorOutput = tail(path.join(dir, "stderr.log"), 10);
  if (runnerLog) {
    lines.push(`Output of the runner:\n${runnerLog}`);
  }
  if (errorOutput) {
    lines.push(`Error output of Codex:\n${errorOutput}`);
  }
  lines.push(`Details: ${dir}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  return 1;
}

function printStillRunning(dir) {
  const id = path.basename(dir);
  const job = readJob(dir);
  const minutes = job.created_at ? Math.round((Date.now() - Date.parse(job.created_at)) / 60000) : null;
  const orphan = !runnerIsAlive(dir) && codexIsAlive(dir);
  process.stdout.write(
    [
      `STILL_RUNNING ${id}${minutes === null ? "" : ` minutes=${minutes}`}`,
      orphan
        ? "The runner is gone, but Codex itself is still alive and may still change files. No exit code will appear. Stop it with the cancel command."
        : "Codex is still working. Run this command to wait for the result:",
      orphan ? `node "${SELF}" cancel ${id}` : `node "${SELF}" wait ${id}`,
      ""
    ].join("\n")
  );
}

// A wrong value must not become NaN: `Date.now() >= NaN` is never true, and the
// wait loop would then never end.
function waitSecondsFromEnv() {
  const raw = process.env.ORCH_CODEX_WAIT_SECONDS;
  if (raw === undefined || raw === "") {
    return DEFAULT_WAIT_SECONDS;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 570) {
    return seconds;
  }
  process.stderr.write(`subagent-router: ORCH_CODEX_WAIT_SECONDS="${raw}" is not a number from 0 to 570, so ${DEFAULT_WAIT_SECONDS} is used\n`);
  return DEFAULT_WAIT_SECONDS;
}

// `cancel` is no hook, so `ps` gets more time than in the route hook.
const CANCEL_PS_TIMEOUT_MS = 5000;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Stops the runner and Codex, and reports success only after both are gone.
async function cancelJob(dir) {
  const id = path.basename(dir);
  if (fs.existsSync(path.join(dir, "exit-code"))) {
    process.stdout.write(`CODEX_JOB ${id} had already ended. Nothing was cancelled.\n`);
    return 0;
  }
  // A pid can be reused by another program after the job ended. So a signal goes
  // out only when the command line of the pid still belongs to this job. When
  // `ps` cannot tell, nothing is stopped and the lock stays: freeing the folder
  // while the job may still run would let a second writer start next to it.
  const targets = [];
  const unknown = [];
  for (const [file, text] of [
    ["runner.pid", dir],
    ["codex.pid", path.join(dir, "result.md")]
  ]) {
    const pid = readPidFile(path.join(dir, file));
    const state = pid === null ? "other" : pidJobState(pid, text, CANCEL_PS_TIMEOUT_MS);
    if (state === "job") {
      targets.push(pid);
      if (file === "codex.pid") {
        // Codex leads its own process group, with the commands that it started.
        // A negative pid means the whole group. For a job started before the
        // runner made that group, the group does not exist and counts as gone.
        targets.push(-pid);
      }
    } else if (state === "unknown") {
      unknown.push(pid);
    }
  }
  if (unknown.length > 0) {
    process.stdout.write(
      `CODEX_FAILED ${id} cancel_failed\n` +
        `"ps" could not tell whether the processes ${unknown.join(", ")} belong to this job, so nothing was stopped. ` +
        "The writer lock stays in place. Run the cancel command again.\n"
    );
    return 1;
  }

  // The runner forwards SIGTERM to Codex and writes the exit code itself.
  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process ended between the check and the signal.
    }
  }
  const deadline = Date.now() + 8000;
  while (targets.some(isAlive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  for (const pid of targets.filter(isAlive)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 300));

  const survivors = targets.filter(isAlive);
  if (survivors.length > 0) {
    process.stdout.write(`CODEX_FAILED ${id} cancel_failed\nThese processes are still alive: ${survivors.map((pid) => (pid < 0 ? `the process group ${-pid}` : pid)).join(", ")}. The writer lock stays in place. Stop them by hand, then run the cancel command again.\n`);
    return 1;
  }

  const job = readJob(dir);
  // A lock that stays is no harm: the exit code below marks its job as ended,
  // and the next start removes it as dead.
  if (job.kind === "implement" && !releaseWriterLock(job.cwd, id)) {
    process.stderr.write(`subagent-router: the writer lock of the job ${id} was not given back, because another start held its breaker; the next start removes it\n`);
  }
  if (!fs.existsSync(path.join(dir, "exit-code"))) {
    // The finding triage sends only review jobs that end after its start time.
    // While the triage is off for everyone, the end of a job removes that time,
    // as the runner does, so a job that ended while the triage was off is never
    // sent once the triage is on again. Only the shared settings count, and a
    // failure here never stops the cancel.
    try {
      const { config: shared } = loadConfig(sharedEnv());
      if (!triageOn(shared) || shared.triageProjects.length === 0) {
        removeSweepSince();
      }
    } catch (error) {
      process.stderr.write(`subagent-router: the triage start time could not be checked or removed: ${error.message}\n`);
    }
    fs.appendFileSync(path.join(dir, "stderr.log"), "\nsubagent-router: the job was cancelled\n");
    fs.writeFileSync(path.join(dir, "exit-code"), "130");
  }
  process.stdout.write(`CODEX_CANCELLED ${id}\nThe job was stopped. Files that Codex had already changed stay changed.\n`);
  return 0;
}

function existingJobDir(id) {
  if (!id || !JOB_ID_PATTERN.test(id)) {
    throw new UsageError("this command needs a job id from a STILL_RUNNING line");
  }
  const dir = path.join(jobsDir(), id);
  if (!fs.existsSync(dir)) {
    throw new UsageError(`there is no job ${id}`);
  }
  return dir;
}

async function jobDirOfRequest(id) {
  if (!id || !REQUEST_ID_PATTERN.test(id)) {
    throw new UsageError("run needs a request id of the form req-<12 hex characters>");
  }
  // A second `run` for the same request must not start a second Codex job.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let claim;
    try {
      claim = claimRequest(id);
    } catch (error) {
      // Inside the Claude sandbox the claim rename fails with EPERM, before any
      // job starts. The text says what the owner can do, and it never asks to
      // exclude a copy that a session can change.
      if (isPermissionError(error)) {
        throw new UsageError(claimRefusedMessage(id, error.code, PLUGIN_ROOT));
      }
      throw error;
    }
    if (claim.request) {
      const request = claim.request;
      if (Array.isArray(request.directive_errors) && request.directive_errors.length > 0) {
        throw new UsageError(`the brief has a line that is not valid, so nothing was started: ${request.directive_errors.join("; ")}`);
      }
      // Codex must work in the folder of the session, never in whatever folder this shell is in.
      if (!request.cwd || !fs.existsSync(request.cwd)) {
        throw new UsageError(`the folder of the task does not exist: ${request.cwd ?? "(none)"}`);
      }
      let dir;
      try {
        dir = startJob({ kind: request.kind, model: request.model, effort: request.effort, scope: request.scope, brief: request.brief ?? "", cwd: request.cwd, origin: "routed", requestId: id });
      } catch (error) {
        // startJob() throws only before it starts a runner. So the request goes
        // back to its stored form, and a later `run` can try again, for example
        // after the busy writer has ended. Before this, the claim stayed, and
        // every later `run` failed with "no job was recorded".
        restoreRequest(id);
        throw error;
      }
      try {
        recordJobOfRequest(id, path.basename(dir));
      } catch (error) {
        // The job runs. A later `run` then finds the claim without a job and
        // gives up, which is better than a second job for the same task.
        process.stderr.write(`subagent-router: the job ${path.basename(dir)} could not be recorded for the request ${id}: ${error.message}\n`);
      }
      return dir;
    }
    if (claim.jobId) {
      return existingJobDir(claim.jobId);
    }
    if (claim.unreadableJob) {
      throw new UsageError(`the request ${id} has a job record that cannot be read (${claim.unreadableJob}), so nothing was started. Its job may still run; look under ${jobsDir()}`);
    }
    if (claim.missing) {
      throw new UsageError(`there is no request ${id}. The routing hook did not store this task`);
    }
    // Another call claimed the request and has not recorded its job yet.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new UsageError(`the request ${id} was claimed, but no job was recorded for it`);
}

async function main() {
  // Before anything else, so neither the runner nor Codex ever sees an API key.
  // The caller then needs no `env -u` in front of this command.
  const removedKeys = stripCodexApiKeys(process.env);
  if (removedKeys.length > 0) {
    process.stderr.write(`subagent-router: ${removedKeys.join(" and ")} removed from the environment of this run, because Codex must use the ChatGPT login\n`);
  }

  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const waitSeconds = options.waitSeconds ?? waitSecondsFromEnv();

  let dir;
  if (command === "run" || command === "wait" || command === "cancel") {
    if (options.briefFile !== null) {
      throw new UsageError("--brief applies to implement, review and consult only");
    }
  }
  if (command === "run") {
    dir = await jobDirOfRequest(options.positionals[0]);
  } else if (command === "wait") {
    dir = existingJobDir(options.positionals[0]);
  } else if (command === "cancel") {
    process.exitCode = await cancelJob(existingJobDir(options.positionals[0]));
    return;
  } else if (command === "implement" || command === "review" || command === "consult") {
    if (options.positionals.length > 0) {
      throw new UsageError(`unexpected argument "${options.positionals[0]}". The task text comes from stdin or from --brief FILE.`);
    }
    if (command === "consult" && options.scope) {
      throw new UsageError("consult takes no review scope. Use review for a review of a diff.");
    }
    if (command === "review" && options.briefFile !== null && options.scope?.type !== "custom") {
      throw new UsageError("review reads a brief only with --custom. A review with a scope flag takes no task text.");
    }
    dir = startJob({ kind: command, model: options.model, effort: options.effort, scope: options.scope, brief: readBrief(options, process.cwd()), cwd: process.cwd() });
  } else {
    throw new UsageError("the command must be run, wait, cancel, implement, review or consult");
  }

  const state = await waitForJob(dir, waitSeconds);
  if (state === "done") {
    process.exitCode = printResult(dir);
  } else if (state === "dead") {
    process.exitCode = printDead(dir);
  } else {
    printStillRunning(dir);
  }
}

main().catch((error) => {
  const prefix = error instanceof UsageError ? "usage error" : "error";
  process.stdout.write(`CODEX_FAILED ${prefix}: ${error.message}\n`);
  if (!(error instanceof UsageError)) {
    process.stderr.write(`${error?.stack ?? error}\n`);
  }
  process.exitCode = 2;
});
