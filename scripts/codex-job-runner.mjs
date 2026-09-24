#!/usr/bin/env node
// Runs one Codex job to its end. orch-codex.mjs starts this script as a detached
// process, so the job survives when the Bash call that started it returns.
//
// Files in the job folder:
//   job.json      what to run (written by orch-codex.mjs)
//   brief.md      the task text, sent to Codex on stdin
//   events.jsonl  the JSON events that Codex prints
//   stderr.log    the error output of Codex
//   runner.log    the output of this script, for the case that it crashes
//   result.md     the final message of Codex
//   exit-code     written last; its presence means "the job is done"

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildCodexArgs, sendsBriefToCodex } from "./lib/codex-args.mjs";
import { codexUnavailableUntil } from "./lib/codex-availability.mjs";
import { codexPlanIsUsedUp, readCodexLimits } from "./lib/codex-limits.mjs";
import { loadConfig } from "./lib/config.mjs";
import { makeFilePrivate } from "./lib/log.mjs";
import { describeTime } from "./lib/provider-state.mjs";
import { releaseWriterLock } from "./lib/writer-lock.mjs";

const jobDir = process.argv[2];
if (!jobDir) {
  process.stderr.write("usage: codex-job-runner.mjs <job folder>\n");
  process.exit(2);
}

const DEFAULT_MAX_RUN_MINUTES = 120;

let finished = false;
let lockedCwd = null;
let child = null;
// Set before this script stops Codex itself, so the exit handler reports the real reason.
let stopReason = null;

// Codex runs as the leader of its own process group, so the commands that it
// starts are in that group too. A signal to the group reaches all of them.
// Before, only Codex got the signal, and a command that it had started could
// go on changing files after the job had ended and the folder was free.
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has no members any more.
  }
}

function groupIsAlive() {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Stops Codex and lets its exit handler end the job. So the exit code appears
// only after Codex is gone, and the folder is never freed while Codex still writes.
function stopCodex(code, note) {
  stopReason = { code, note };
  signalGroup("SIGTERM");
  setTimeout(() => groupIsAlive() && signalGroup("SIGKILL"), 3000).unref();
}

// After Codex has ended, a command that it started can still run in its group.
// It is stopped before the job ends, because the end frees the folder.
async function stopLeftovers() {
  if (!groupIsAlive()) {
    return null;
  }
  signalGroup("SIGTERM");
  for (const [signal, waitMs] of [["SIGKILL", 3000], [null, 2000]]) {
    const deadline = Date.now() + waitMs;
    while (groupIsAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!groupIsAlive()) {
      return "commands that Codex had started were still running and were stopped";
    }
    if (signal) {
      signalGroup(signal);
    }
  }
  return "commands that Codex had started still run after SIGKILL; stop them by hand";
}

// True while Codex was started and has not ended. `pid` is set only after a
// successful start, so a Codex that could not start does not count.
function codexRuns() {
  return Boolean(child && child.pid && child.exitCode === null);
}

// Ends the job because of an error in this script. With a live Codex, the end
// waits for its exit; without one, the job ends at once. Before this, an error
// after the start wrote the exit code and freed the folder while Codex ran on.
function fail(code, note) {
  if (codexRuns()) {
    stopCodex(code, note);
  } else {
    finish(code, note);
  }
}

// The exit code is the one fact that the waiter needs, so it is written first.
// The note and the lock come after it, each guarded, so a full disk cannot lose the code.
function finish(code, note) {
  if (finished) {
    return;
  }
  finished = true;
  try {
    const temporary = path.join(jobDir, "exit-code.tmp");
    fs.writeFileSync(temporary, String(code));
    fs.renameSync(temporary, path.join(jobDir, "exit-code"));
  } catch (error) {
    process.stderr.write(`the exit code ${code} could not be written: ${error.message}\n`);
  }
  if (note) {
    try {
      fs.appendFileSync(path.join(jobDir, "stderr.log"), `\norchestrator runner: ${note}\n`, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(`the note could not be written: ${error.message}. The note was: ${note}\n`);
    }
  }
  // Codex writes the result file itself, with whatever mode it likes.
  try {
    makeFilePrivate(path.join(jobDir, "result.md"));
  } catch (error) {
    process.stderr.write(`the result file could not be made private: ${error.message}\n`);
  }
  // A lock that stays is no harm: the exit code above marks its job as ended, and
  // the next start removes it as dead.
  if (lockedCwd) {
    try {
      if (!releaseWriterLock(lockedCwd, path.basename(jobDir))) {
        process.stderr.write("the writer lock was not given back, because another start held its breaker; the next start removes it\n");
      }
    } catch (error) {
      process.stderr.write(`the writer lock could not be given back: ${error.message}\n`);
    }
  }
}

// Hides anything that looks like an API key before text goes into a log.
function maskKeys(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<hidden>");
}

// A signal to the runner must also stop Codex. Otherwise Codex would keep
// changing files while the job already counts as ended.
function stopOnSignal(signal, code) {
  process.on(signal, () => {
    if (child && child.pid && groupIsAlive()) {
      // The exit handler of the child writes the exit code, and then this script ends.
      stopCodex(code, `the runner received ${signal} and stopped Codex`);
    } else {
      finish(code, `the runner received ${signal}`);
      process.exit(0);
    }
  });
}
stopOnSignal("SIGTERM", 143);
stopOnSignal("SIGINT", 130);
stopOnSignal("SIGHUP", 129);

process.on("uncaughtException", (error) => {
  process.stderr.write(`uncaught error: ${error?.stack ?? error}\n`);
  fail(125, `the runner crashed: ${error?.message ?? error}`);
  // With a live Codex this script stays alive until Codex has ended, and the
  // exit handler of Codex writes the exit code then.
  if (!codexRuns()) {
    process.exit(1);
  }
});

try {
  const job = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
  lockedCwd = job.kind === "implement" ? job.cwd : null;
  const bin = process.env.ORCH_CODEX_BIN || "codex";
  const args = buildCodexArgs(job, path.join(jobDir, "result.md"));

  // Codex must use the saved ChatGPT login. An API key in the environment would
  // win over that login and move the run to paid API billing, so drop such keys.
  // The TypeSafe key is of no use to Codex either, so it does not travel along.
  const env = { ...process.env };
  for (const name of ["CODEX_API_KEY", "OPENAI_API_KEY", "TYPESAFE_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY"]) {
    delete env[name];
  }

  // "Subscriptions only" is a hard rule, so check the login at every launch and
  // refuse to run when Codex would not use the ChatGPT plan.
  const { config } = loadConfig();
  // While Codex is off, do not even start `codex login status`.
  const login = config.codexEnabled ? spawnSync(bin, ["login", "status"], { env, encoding: "utf8", timeout: 15000 }) : {};
  const loginText = `${login.stdout ?? ""}${login.stderr ?? ""}`.trim();

  // At 100 percent Codex pays from bought credits, and that needs a clear yes from the user.
  // Read the plan numbers directly. codexState() reports a routing pause first,
  // and the pause would hide a used-up plan.
  const limits = readCodexLimits();
  // A pause starts when a Codex job fails with a usage limit. Codex reports that
  // when the plan and the credits are both empty. So before the pause ends, a run
  // that works is most likely paid from credits bought since then. The saved plan
  // numbers can miss this, because only the jobs of this plugin update them.
  const pausedUntil = codexUnavailableUntil();
  if (!config.codexEnabled) {
    // The hook moves Codex tasks to Claude only in enforce mode. This check holds in every mode.
    finish(
      78,
      "Codex is off in the orchestrator plugin, so this job was not started. " +
        "Send the task to a Claude worker: orchestrator:implementer, or orchestrator:reviewer for a review. " +
        'To use Codex, set "codexEnabled": true in ~/.claude/orchestrator/config.json.'
    );
  } else if (login.error) {
    const timedOut = login.error.code === "ETIMEDOUT";
    finish(timedOut ? 124 : 127, timedOut ? `"${bin} login status" did not answer within 15 seconds` : `could not start "${bin}": ${login.error.message}`);
  } else if (codexPlanIsUsedUp(limits) && !config.codexSpendCredits) {
    finish(
      75,
      `The weekly Codex allowance of the ChatGPT plan is used up until ${describeTime(limits.resetsAt)}, so this job was not started. ` +
        `Codex would pay for it from bought credits (balance ${limits.creditsBalance ?? "unknown"}). ` +
        "Send the task to a Claude worker: orchestrator:implementer, or orchestrator:reviewer for a review. " +
        'To allow credits, set "codexSpendCredits": true in ~/.claude/orchestrator/config.json.'
    );
  } else if (pausedUntil && !config.codexSpendCredits) {
    finish(
      75,
      `An earlier Codex job failed with a usage limit, so Codex is paused until ${describeTime(pausedUntil)}. ` +
        "This job was not started, because before that time a run would most likely be paid from bought credits. " +
        "Send the task to a Claude worker: orchestrator:implementer, or orchestrator:reviewer for a review. " +
        "To end the pause early, delete ~/.claude/orchestrator/codex-unavailable.json. " +
        'To allow credits, set "codexSpendCredits": true in ~/.claude/orchestrator/config.json.'
    );
  } else if (!/chatgpt/i.test(loginText)) {
    finish(
      78,
      `"${bin} login status" did not report a ChatGPT login, so this run could be billed at API rates and was not started. ` +
        `Run \`codex login\`. Exit status ${login.status}. Its answer was: ${maskKeys(loginText).slice(0, 300) || "(empty)"}`
    );
  } else {
    const stdin = sendsBriefToCodex(job) ? fs.openSync(path.join(jobDir, "brief.md"), "r") : "ignore";
    const stdout = fs.openSync(path.join(jobDir, "events.jsonl"), "a", 0o600);
    const stderr = fs.openSync(path.join(jobDir, "stderr.log"), "a", 0o600);

    // `detached` makes Codex the leader of a new process group (see signalGroup).
    child = spawn(bin, args, { cwd: job.cwd, env, stdio: [stdin, stdout, stderr], detached: true });
    // Attach the handlers before any other work, so no exit can be missed.
    child.on("error", (error) => {
      finish(127, `could not start "${bin}": ${error.message}`);
    });
    child.on("exit", async (code, signal) => {
      const leftovers = await stopLeftovers();
      const join = (note) => [note, leftovers].filter(Boolean).join("; ") || null;
      if (stopReason) {
        finish(stopReason.code, join(stopReason.note));
      } else {
        finish(code ?? 1, join(signal ? `Codex was stopped by the signal ${signal}` : null));
      }
    });
    try {
      fs.writeFileSync(path.join(jobDir, "codex.pid"), String(child.pid ?? ""), { mode: 0o600 });
    } catch (error) {
      // Without this file a `cancel` cannot find Codex, so the job must not go on.
      fail(126, `codex.pid could not be written, so Codex was stopped: ${error.message}`);
    }

    // A hung Codex must not hold the folder for ever.
    const maxMinutes = Number(job.max_run_minutes) > 0 ? Number(job.max_run_minutes) : DEFAULT_MAX_RUN_MINUTES;
    setTimeout(() => {
      if (child.exitCode === null) {
        stopCodex(124, `Codex ran longer than ${maxMinutes} minutes and was stopped`);
      }
    }, maxMinutes * 60 * 1000).unref();
  }
} catch (error) {
  process.stderr.write(`${error?.stack ?? error}\n`);
  fail(126, `the job could not be prepared: ${error.message}`);
}
