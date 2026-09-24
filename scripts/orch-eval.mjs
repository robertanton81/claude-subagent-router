#!/usr/bin/env node
// Runs the tasks of a task set in several arms through `claude -p` and saves
// the numbers of every run: cost, turns, duration, the models that ran, and
// the dispatches that the plugin's hook logged. It grades nothing; see
// scripts/lib/eval.mjs.
//
//   node scripts/orch-eval.mjs <task set.json> [--arms off,sonnet,shadow,jev] [--runs 1]
//        [--max-total-usd 5] [--config <file>] [--out <folder>] [--result-chars 4000] [--dry-run]
//
// The arms without --arms: off, sonnet, shadow, jev. Two more run only when named:
// low and medium, the single-model baselines at a lower effort.
//
// Every run counts against the Claude plan. The command prints the plan first.
// With --dry-run it prints the plan and the command line of each arm and stops.
// ORCH_EVAL_CLAUDE_BIN names another `claude` binary; the tests use a stand-in.
//
// This file always runs its main function. It has no "am I the entry script"
// check, because such a check breaks for plugin paths with spaces and under
// symbolic links.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { dataDir } from "./lib/config.mjs";
import { ensurePrivateDir, makeFilePrivate } from "./lib/log.mjs";
import {
  ARMS,
  DEFAULT_ARMS,
  buildInvocation,
  exportWorkspace,
  loadTaskSet,
  makeRecord,
  prepareDataDir,
  renderPlan,
  renderSummary,
  rotateArms,
  runOne,
  summarize
} from "./lib/eval.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USAGE =
  "Usage: node scripts/orch-eval.mjs <task set.json> [--arms off,sonnet,shadow,jev] [--runs 1] [--max-total-usd 5] [--config <file>] [--out <folder>] [--result-chars 4000] [--dry-run] [--regrade <folder>] [--task <name>]\n  arms: off, sonnet, shadow, jev (the default), low, medium\n";

function fail(message, code = 2) {
  process.stderr.write(`orch-eval: ${message}\n${USAGE}`);
  process.exitCode = code;
}

function integer(value, name, min) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`--${name} needs a whole number of at least ${min}, not "${value}"`);
  }
  return parsed;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

async function main() {
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: process.argv.slice(2),
      options: {
        arms: { type: "string" },
        runs: { type: "string" },
        "max-total-usd": { type: "string" },
        config: { type: "string" },
        out: { type: "string" },
        "result-chars": { type: "string" },
        "dry-run": { type: "boolean" },
        regrade: { type: "string" },
        task: { type: "string", multiple: true }
      },
      strict: true,
      allowPositionals: true
    }));
    if (positionals.length !== 1) {
      throw new Error("give exactly one task set file");
    }
  } catch (error) {
    fail(error.message);
    return;
  }

  let taskSet;
  let arms;
  let runs;
  let maxTotalUsd = null;
  let resultChars;
  try {
    taskSet = loadTaskSet(path.resolve(positionals[0]));
    // --task runs part of a set. An unknown name is an error, not an empty run:
    // a typo would otherwise look like a set with nothing in it.
    if (values.task !== undefined) {
      const wanted = new Set(values.task);
      const known = new Set(taskSet.tasks.map((task) => task.name));
      const missing = [...wanted].filter((name) => !known.has(name));
      if (missing.length > 0) {
        throw new Error(`no task named ${missing.map((name) => `"${name}"`).join(", ")} in this set; it has ${[...known].join(", ")}`);
      }
      taskSet = { ...taskSet, tasks: taskSet.tasks.filter((task) => wanted.has(task.name)) };
    }
    arms = values.arms === undefined ? DEFAULT_ARMS : values.arms.split(",").map((arm) => arm.trim()).filter(Boolean);
    for (const arm of arms) {
      if (!ARMS[arm]) {
        throw new Error(`unknown arm "${arm}"; the arms are ${Object.keys(ARMS).join(", ")}`);
      }
    }
    if (arms.length === 0) {
      throw new Error("--arms needs at least one arm");
    }
    runs = values.runs === undefined ? 1 : integer(values.runs, "runs", 1);
    resultChars = values["result-chars"] === undefined ? 4000 : integer(values["result-chars"], "result-chars", 0);
    if (values["max-total-usd"] !== undefined) {
      maxTotalUsd = Number(values["max-total-usd"]);
      if (!Number.isFinite(maxTotalUsd) || maxTotalUsd <= 0) {
        throw new Error(`--max-total-usd needs an amount above 0, not "${values["max-total-usd"]}"`);
      }
    }
    if (values.config !== undefined && !fs.existsSync(values.config)) {
      throw new Error(`the config file ${values.config} does not exist`);
    }
  } catch (error) {
    fail(error.message);
    return;
  }

  // Grading reads the saved records only, so a changed grader or a changed task
  // set can be applied to an old run without starting anything.
  if (values.regrade !== undefined) {
    const from = path.resolve(values.regrade);
    const runsFile = fs.statSync(from, { throwIfNoEntry: false })?.isDirectory() ? path.join(from, "runs.jsonl") : from;
    if (!fs.existsSync(runsFile)) {
      fail(`no runs.jsonl at ${runsFile}`);
      return;
    }
    const saved = fs
      .readFileSync(runsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    process.stdout.write(`Graded again from ${runsFile}, ${saved.length} saved runs. Nothing was started.\n`);
    process.stdout.write(renderSummary(summarize(saved, taskSet.tasks)));
    return;
  }

  const outDir = path.resolve(values.out ?? path.join(dataDir(), "eval", stamp()));
  const claudeBin = process.env.ORCH_EVAL_CLAUDE_BIN || "claude";
  process.stdout.write(renderPlan(taskSet, arms, runs, { outDir, maxTotalUsd }));

  if (values["dry-run"]) {
    process.stdout.write("Command lines (the prompt is left out):\n");
    for (const arm of arms) {
      const invocation = buildInvocation(taskSet.tasks[0], arm, { claudeBin, pluginDir: ROOT, dataDir: path.join(outDir, "<task>", arm, "run-1", "data") });
      const shown = invocation.argv.map((part, index) => (index === 2 ? "<prompt>" : part));
      const switches = Object.entries(ARMS[arm].env)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ");
      process.stdout.write(`  ${arm}: ${switches ? `${switches} ` : ""}${shown.join(" ")}\n`);
    }
    process.stdout.write("Dry run: nothing was started.\n");
    return;
  }

  // The records hold the answers the runs produced, and the error output of a
  // run that failed. They are kept as privately as the plugin's own store.
  ensurePrivateDir(outDir);
  const runsFile = path.join(outDir, "runs.jsonl");
  const records = [];
  let spent = 0;
  let stoppedByCap = false;

  for (const task of taskSet.tasks) {
    for (let run = 1; run <= runs && !stoppedByCap; run += 1) {
      for (const arm of rotateArms(arms, run)) {
        if (maxTotalUsd !== null && spent >= maxTotalUsd) {
          stoppedByCap = true;
          break;
        }
        const runDir = path.join(outDir, task.name, arm, `run-${run}`);
        const runData = path.join(runDir, "data");
        prepareDataDir(runData, values.config ?? null);
        let cwd = task.cwd;
        if (task.export) {
          cwd = exportWorkspace(task.cwd, path.join(runDir, "workspace"));
        }
        const invocation = buildInvocation(task, arm, { claudeBin, pluginDir: ROOT, dataDir: runData, cwd });
        process.stderr.write(`${task.name} / ${arm} / run ${run}: started\n`);
        const outcome = await runOne(invocation, { timeoutMs: task.timeoutS * 1000 });
        const record = makeRecord({ task, arm, run, invocation, outcome, dataDir: runData, resultChars });
        records.push(record);
        fs.appendFileSync(runsFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        makeFilePrivate(runsFile);
        spent += record.cost_usd ?? 0;
        const state = record.timed_out ? "timeout" : record.is_error ? "error" : "ok";
        const cost = record.cost_usd === null ? "cost unknown" : `$${record.cost_usd.toFixed(3)}`;
        process.stderr.write(`${task.name} / ${arm} / run ${run}: ${state}, ${cost}, ${(record.wall_ms / 1000).toFixed(1)} s\n`);
      }
    }
    if (stoppedByCap) {
      break;
    }
  }

  const summary = summarize(records, taskSet.tasks);
  fs.writeFileSync(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(renderSummary(summary));
  process.stdout.write(`Records: ${runsFile}\n`);
  if (stoppedByCap) {
    process.stderr.write(`orch-eval: stopped by --max-total-usd after $${spent.toFixed(3)}; the runs so far are saved\n`);
    process.exitCode = 3;
  } else if (summary.errors > 0 || summary.timeouts > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`orch-eval failed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});
