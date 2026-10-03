#!/usr/bin/env node
// The Codex job scan of the finding triage.
//
// Without arguments this is the launcher, registered on Stop and SessionStart.
// It returns at once: when the triage is on, no worker runs and a finished
// review job is waiting, it starts the worker as a detached process (one that
// the end of the session does not stop) and ends. It prints nothing on its
// output (settings warnings go to its error output), because a
// Stop hook's output can be read as a decision, and it always exits with 0.
//
// With --worker it is the worker: it scans the Codex job folders and triages
// each finished review job once (scripts/lib/sweep.mjs).

import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "./lib/config.mjs";
import { appendLog } from "./lib/log.mjs";
import { removeSweepSince, reportNoKey, runWorker, sharedEnv, startSweepWorker, sweepRunning, sweepSince } from "./lib/sweep.mjs";
import { triageOn } from "./lib/triage-core.mjs";
import { deferral, isDone, isSkipped } from "./lib/triage-state.mjs";
import { findApiKey } from "./lib/typesafe.mjs";
import { jobsDir } from "./lib/writer-lock.mjs";

// True when at least one job has ended (a numeric exit-code) and is neither
// done, skipped nor postponed. A few file reads per job, so a turn end without
// work starts no worker. The launcher itself is one short Node process.
function jobWaiting(now = Date.now()) {
  const root = jobsDir();
  if (!fs.existsSync(root)) return false;
  return fs.readdirSync(root).some((id) => {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return false;
    const key = `job-${id}`;
    if (isDone(key) || isSkipped(key) || Number(deferral(key)?.until) > now) return false;
    try {
      return /^\d+$/.test(fs.readFileSync(path.join(root, id, "exit-code"), "utf8").trim());
    } catch {
      // No exit-code: the job has not ended.
      return false;
    }
  });
}

function launch() {
  const { config, warnings } = loadConfig();
  // A broken settings file turns the triage off; the reason must stay visible.
  for (const warning of warnings) {
    process.stderr.write(`subagent-router config: ${warning}\n`);
  }
  // Only the settings that all sessions share may move the shared start time.
  const shared = loadConfig(sharedEnv()).config;
  if (!triageOn(shared) || shared.triageProjects.length === 0) {
    // While the triage is off for everyone (or no project may send), there is no
    // start time, so a job
    // that ends now is never sent once the triage is switched on again.
    removeSweepSince();
    return;
  }
  // Off for this session only: the shared start time stays for the others.
  if (!triageOn(config) || config.triageProjects.length === 0) return;
  // Published here, before any job ends, so the first job after the switch-on
  // is not older than the start time.
  sweepSince();
  if (sweepRunning() || !jobWaiting()) return;
  // A session without the key (a session-only copy of the plugin) starts no
  // worker, which would only stop again; it says so once a day.
  if (!findApiKey().key) {
    reportNoKey();
    return;
  }
  startSweepWorker();
}

const worker = process.argv.includes("--worker");
try {
  if (worker) {
    // A worker started by the launcher gets the key through its input pipe.
    const piped = process.env.ORCH_SWEEP_KEY_ON_STDIN === "1" ? fs.readFileSync(0, "utf8").trim() : "";
    await runWorker(process.env, piped || null);
  } else {
    launch();
  }
} catch (error) {
  process.stderr.write(`subagent-router triage sweep failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: worker ? "triage-sweep-worker" : "triage-sweep", error: String(error?.message ?? error) });
}
process.exitCode = 0;
