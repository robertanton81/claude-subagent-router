#!/usr/bin/env node
// Prints the numbers of the measurement store in ~/.claude/orchestrator/
// (ORCH_DATA_DIR): what the hook changed, what Jev answered, the labels for a
// wrong route that the log gives for free, the durations, the review findings
// by author family, and Claude usage over time. Counts only: no brief, no
// description and no worker result reaches the output.
//
//   node scripts/orch-report.mjs [--json] [--since <date>] [--project <text>]
//
// This file always runs its main function. It has no "am I the entry script"
// check, because such a check breaks for plugin paths with spaces and under
// symbolic links. The functions live in lib/report.mjs, which the tests import.

import { parseArgs } from "node:util";

import { buildReport, loadStore, renderText } from "./lib/report.mjs";

function main() {
  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: { json: { type: "boolean" }, since: { type: "string" }, project: { type: "string" } },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    process.stderr.write(`orch-report: ${error.message}\nUsage: node scripts/orch-report.mjs [--json] [--since <date>] [--project <text>]\n`);
    process.exitCode = 2;
    return;
  }
  let since = null;
  if (values.since !== undefined) {
    since = Date.parse(values.since);
    if (!Number.isFinite(since)) {
      process.stderr.write(`orch-report: --since needs a date, for example 2026-09-22 or 2026-09-22T10:00:00Z, not "${values.since}"\n`);
      process.exitCode = 2;
      return;
    }
  }
  const report = buildReport(loadStore(), { since, project: values.project ?? null });
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
}

main();
