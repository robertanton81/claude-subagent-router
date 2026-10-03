#!/usr/bin/env node
// The evaluation command of the finding triage.
//
//   node scripts/orch-label.mjs reserve                         split change groups into tuning and evaluation, once
//   node scripts/orch-label.mjs register --start <date> --end <date> [--seed <n>] [--agent-types <a,b>]
//   node scripts/orch-label.mjs status                          progress of the window, the day-7 tripwire, what to run next
//   node scripts/orch-label.mjs sample --name <name>            draw the blind samples after the window ends
//   node scripts/orch-label.mjs label <folder>                  label one item at a time; never shows Jev's answers
//   node scripts/orch-label.mjs score <folder>                  one scored look against the frozen bar
//
// It reads and writes local files only and sends nothing.

import readline from "node:readline";

import { describe, readItems, readLabels, register, reserve, sample, saveLabel, score, status, statusLine } from "./lib/labels.mjs";

function option(args, name) {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1];
}

function show(item) {
  if (item.kind === "report") {
    return [
      `Report (${item.agent_type}), parse state ${item.parse_state}`,
      "----- report -----",
      item.snapshot ?? "(no report text)",
      "----- what the parser found -----",
      // Each finding in full, so its boundaries can be judged.
      ...(item.items.length ? item.items.map((f, n) => `--- finding ${n + 1} [${f.label}] ---\n${f.text}`) : ["(nothing)"])
    ].join("\n");
  }
  return [
    `Finding (${item.agent_type}), label ${item.label}`,
    item.text,
    `----- ${item.path} lines ${item.lines}, commit ${item.head ?? "unknown"}${item.dirty ? " with uncommitted changes" : ""} -----`,
    item.excerpt
  ].join("\n");
}

async function label(dir) {
  const items = readItems(dir);
  const done = readLabels(dir);
  const open = items.filter((item) => !(item.id in done));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stdout.write(`${question} `);
    const next = await lines.next();
    return next.done ? null : next.value.trim();
  };
  // Asks again until the answer is valid. An answer that is not understood never
  // becomes a label. null means the input ended.
  const askUntil = async (question, valid, again) => {
    let answer = await ask(question);
    while (answer !== null && !valid(answer)) {
      answer = await ask(again);
    }
    return answer;
  };
  for (const [n, item] of open.entries()) {
    process.stdout.write(`\n=== ${n + 1} of ${open.length} ===\n${show(item)}\n`);
    if (item.kind === "report") {
      const all = await askUntil("Did the parser find every finding? (y/n, - to skip)", (a) => ["y", "n", "-"].includes(a), "Please type y, n or -:");
      if (all === null) break;
      if (all === "-") {
        saveLabel(dir, item.id, "skip");
        continue;
      }
      const bounds = await askUntil("Are the boundaries right? (y/n)", (a) => ["y", "n"].includes(a), "Please type y or n:");
      if (bounds === null) break;
      // After a "y" nothing was missed, so the question would only allow a contradiction.
      let missed = "0";
      if (all === "n") {
        missed = await askUntil("How many findings did it miss? (a number)", (a) => /^[1-9]\d*$/.test(a), "How many findings did it miss? Type a whole number of 1 or more:");
        if (missed === null) break;
      }
      saveLabel(dir, item.id, { allFound: all === "y", boundariesRight: bounds === "y", missed: Number(missed) });
      continue;
    }
    const answer = await askUntil(
      "Does the code support the finding? s = supported, c = contradicted, i = not enough context, - = skip:",
      (a) => ["s", "c", "i", "-"].includes(a),
      "Please type s, c, i or -:"
    );
    if (answer === null) break;
    saveLabel(dir, item.id, answer === "-" ? "skip" : answer);
  }
  rl.close();
  const left = items.filter((item) => !(item.id in readLabels(dir))).length;
  process.stdout.write(left ? `\n${left} items left; run label again to go on.\n` : `\nAll items are labelled. Run: node scripts/orch-label.mjs score ${dir}\n`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "reserve":
      reserve();
      process.stdout.write("The pools are reserved.\n");
      break;
    case "register": {
      const seed = option(args, "--seed");
      const types = option(args, "--agent-types");
      const reg = register({ start: option(args, "--start"), end: option(args, "--end"), seed: seed === null ? undefined : Number(seed), agentTypes: types ? types.split(",").map((t) => t.trim()).filter(Boolean) : undefined });
      process.stdout.write(`Registered the window ${reg.start} to ${reg.end}, seed ${reg.seed}, reviewers: ${reg.population.agentTypes.join(", ")}.\nCheckouts: ${reg.population.triageProjects.join(", ") || "none"}. Worktrees: ${reg.population.triageWorktrees ? `on, repositories ${reg.population.commonDirs.join(", ")}` : "off"}.\n`);
      break;
    }
    case "status": {
      const s = status();
      if (!s) {
        process.stdout.write('No window is registered. Run "register".\n');
      } else if (s.state === "scored") {
        const version = Object.entries(s.evalVersion).map(([part, value]) => `${part} ${value}`).join(", ");
        process.stdout.write(`The window ${s.start} to ${s.end} was scored. Evaluation version: ${version}. A new window needs a changed version.\n`);
      } else {
        process.stdout.write(`${statusLine(process.env, s)}\n${JSON.stringify(s, null, 2)}\n`);
      }
      break;
    }
    case "sample": {
      const name = option(args, "--name");
      if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("--name needs letters, digits, - or _.");
      const result = sample(name);
      process.stdout.write(`Drew ${result.findings} findings, ${result.precision} precision findings and ${result.reports} reports into ${result.dir}\n`);
      break;
    }
    case "label":
      await label(args[0]);
      break;
    case "score":
      process.stdout.write(`${describe(score(args[0]))}\n`);
      break;
    default:
      process.stdout.write("Commands: reserve, register, status, sample, label, score. See the top of this file.\n");
      process.exitCode = command ? 2 : 0;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`orch-label: ${error.message}\n`);
  process.exitCode = 1;
}
