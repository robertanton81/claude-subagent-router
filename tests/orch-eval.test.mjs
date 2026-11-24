import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { ARMS, DEFAULT_ARMS, buildInvocation, checkPassRule, compareEffortBaselines, gradeRecord, loadTaskSet, makeRecord, parseResult, readTrace, renderSummary, rotateArms, summarize } from "../scripts/lib/eval.mjs";
import { ROOT, cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

// A stand-in for `claude -p`. It records its command line, its switches and its
// folder, plays the plugin's hook when a plugin folder was given, and prints
// the one JSON object of `--output-format json`.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.FAKE_CLAUDE_LOG, JSON.stringify({
  args,
  cwd: process.cwd(),
  ORCH_MODE: env.ORCH_MODE ?? null,
  ORCH_DATA_DIR: env.ORCH_DATA_DIR ?? null,
  ORCH_LIMITS_FILE: env.ORCH_LIMITS_FILE ?? null,
  SUBAGENT_MODEL: env.CLAUDE_CODE_SUBAGENT_MODEL ?? null,
  SUBAGENT_FORCE: env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null,
  EFFORT_LEVEL: env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
  CLAUDE_EFFORT: env.CLAUDE_EFFORT ?? null
}) + "\\n");
if (args.includes("--plugin-dir")) {
  fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
  const enforce = env.ORCH_MODE === "enforce";
  fs.appendFileSync(path.join(env.ORCH_DATA_DIR, "dispatch-log.jsonl"),
    JSON.stringify({ event: "dispatch", tool_use_id: "t1", requested: { agent: "subagent-router:implementer", model: null },
      final: { agent: enforce ? "subagent-router:searcher" : "subagent-router:implementer", model: enforce ? "haiku" : null },
      action: enforce ? "rewrite" : "shadow", reason: "search", jev: { kind: "search", kindConfidence: 1, difficulty: 1.2 } }) + "\\n" +
    JSON.stringify({ event: "launched", tool_use_id: "t1", resolved_model: enforce ? "claude-haiku-4-5" : "claude-sonnet-5" }) + "\\n");
}
setTimeout(() => {
  if (env.FAKE_CLAUDE_EXIT) {
    process.stderr.write("fake claude failed\\n");
    process.exit(Number(env.FAKE_CLAUDE_EXIT));
  }
  const prompt = args[args.indexOf("-p") + 1];
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, total_cost_usd: Number(env.FAKE_CLAUDE_COST || 0.05), num_turns: 2,
    duration_ms: 1200, duration_api_ms: 900, result: "answer to: " + prompt,
    modelUsage: { [env.ORCH_MODE === "enforce" ? "claude-haiku-4-5" : "claude-sonnet-5"]: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 20, costUSD: 0.05 } },
    permission_denials: [] }) + "\\n");
}, Number(env.FAKE_CLAUDE_SLEEP_MS || 0));
`;

function setUp() {
  const tempDir = makeTempDir("orch-eval-");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  const fake = path.join(binDir, "claude");
  fs.writeFileSync(fake, FAKE_CLAUDE, { mode: 0o755 });
  const project = path.join(tempDir, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "a.mjs"), 'import fs from "node:fs";\n');
  const taskSetFile = path.join(tempDir, "tasks.json");
  const log = path.join(tempDir, "fake-claude.jsonl");
  const env = cleanEnv(tempDir, { ORCH_EVAL_CLAUDE_BIN: fake, FAKE_CLAUDE_LOG: log });
  return { tempDir, fake, project, taskSetFile, log, env };
}

function writeTaskSet(file, tasks, extra = {}) {
  fs.writeFileSync(file, JSON.stringify({ ...extra, tasks }));
}

function readLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test("loadTaskSet applies the defaults and rejects a bad set", () => {
  const { tempDir, project, taskSetFile } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "find files", cwd: "project", timeoutS: 30 }], { budgetUsd: 0.5 });
    const set = loadTaskSet(taskSetFile);
    const task = set.tasks[0];
    assert.deepEqual([task.cwd, task.model, task.budgetUsd, task.timeoutS, task.export], [project, "sonnet", 0.5, 30, false]);
    assert.deepEqual(task.allowedTools, ["Read", "Glob", "Grep", "Agent"]);

    writeTaskSet(taskSetFile, []);
    assert.throws(() => loadTaskSet(taskSetFile), /non-empty "tasks"/);
    writeTaskSet(taskSetFile, [{ name: "bad name!", prompt: "x", cwd: "project" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"name" must be/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "missing" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /does not exist/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project" }, { name: "one", prompt: "y", cwd: "project" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /appears twice/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", budgetUsd: 0 }]);
    assert.throws(() => loadTaskSet(taskSetFile), /budgetUsd must be a number above 0/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", budgetUsd: 0.004 }]);
    assert.throws(() => loadTaskSet(taskSetFile), /budgetUsd must be at least 0\.01/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", timeoutS: "10" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /timeoutS must be a number above 0/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", model: "" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"model" must be a model name/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", allowedTools: "Read" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"allowedTools" must be a list/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", export: "yes" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"export" must be true or false/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", trace: "yes" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"trace" must be true or false/);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: "project", trace: true }]);
    assert.equal(loadTaskSet(taskSetFile).tasks[0].trace, true);
    writeTaskSet(taskSetFile, [{ name: "one", prompt: " ", cwd: "project" }]);
    assert.throws(() => loadTaskSet(taskSetFile), /"prompt" must be a non-empty string/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a traced task asks for the stream format, and its record lists the skill and agent calls", () => {
  const task = { name: "t", prompt: "do it", cwd: "/work", model: "sonnet", budgetUsd: 1, timeoutS: 10, allowedTools: ["Read", "Skill"], export: false };
  const options = { claudeBin: "/fake/claude", pluginDir: "/plugin", dataDir: "/data", baseEnv: { PATH: "/bin" } };
  const format = (argv) => argv.slice(argv.indexOf("--output-format") + 1, argv.indexOf("--model"));
  assert.deepEqual(format(buildInvocation(task, "off", options).argv), ["json"]);
  assert.deepEqual(format(buildInvocation({ ...task, trace: true }, "off", options).argv), ["stream-json", "--verbose"]);

  const use = (name, input) => ({ type: "tool_use", id: "x", name, input });
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "ok" }, use("Skill", { skill: "p:verified-review" }), use("Read", { file_path: "a" })] } }),
    "not a json line",
    JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [use("Agent", { subagent_type: "p:reviewer", model: "sonnet", prompt: "x" }), use("Read", {})] } }),
    JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_1", message: { content: [use("Skill", { skill: "p:review" }), use("Skill", {})] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: JSON.stringify(use("Skill", { skill: "fake" })) }] } }),
    JSON.stringify({ type: "result", is_error: false, total_cost_usd: 0.3, num_turns: 4, result: "done" })
  ].join("\n");
  assert.deepEqual(readTrace(stdout), {
    tools: { Skill: 3, Read: 2, Agent: 1 },
    skills: [{ skill: "p:verified-review", main: true }, { skill: "p:review", main: false }, { skill: null, main: false }],
    agents: [{ agent: "p:reviewer", model: "sonnet", main: true }]
  });
  assert.equal(readTrace(""), null, "no message line is no trace, not an empty trace");
  assert.equal(readTrace(JSON.stringify({ is_error: false, result: "x" })), null);

  const outcome = { stdout, stderr: "", code: 0, signal: null, timedOut: false, durationMs: 5 };
  const traced = makeRecord({ task: { ...task, trace: true }, arm: "off", run: 1, invocation: { cwd: "/work" }, outcome, dataDir: "/nonexistent" });
  assert.deepEqual([traced.cost_usd, traced.is_error, traced.result, traced.trace.skills.length], [0.3, false, "done", 3]);
  assert.equal("trace" in makeRecord({ task, arm: "off", run: 1, invocation: { cwd: "/work" }, outcome, dataDir: "/nonexistent" }), false);

  // A traced run that was stopped before its result line has no result: the
  // last message line must not be read as one.
  const cut = stdout.split("\n").slice(0, -1).join("\n");
  assert.equal(parseResult(cut), null);
  assert.equal(parseResult(JSON.stringify({ type: "system", subtype: "init" })), null, "a stream that holds one line and no result has no result");
  assert.deepEqual(readTrace(JSON.stringify({ type: "assistant", message: { content: [use("Task", { subagent_type: "p:searcher" })] } })).agents, [{ agent: "p:searcher", model: null, main: true }], "the older tool name Task is an agent call too");
  const stopped = makeRecord({ task: { ...task, trace: true }, arm: "off", run: 1, invocation: { cwd: "/work" }, outcome: { ...outcome, stdout: cut, code: null, signal: "SIGKILL", timedOut: true }, dataDir: "/nonexistent" });
  assert.deepEqual([stopped.cost_usd, stopped.timed_out, stopped.trace.tools.Skill], [null, true, 3]);
});

test("buildInvocation gives each arm its switches and keeps the shell's own out", () => {
  const task = { name: "t", prompt: "do it", cwd: "/work", model: "sonnet", budgetUsd: 1, timeoutS: 10, allowedTools: ["Read", "Agent"], export: false };
  const baseEnv = { PATH: "/bin", HOME: "/home", ORCH_MODE: "enforce", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", ORCH_CODEX_ENABLED: "1" };
  const options = { claudeBin: "/fake/claude", pluginDir: "/plugin dir", dataDir: "/data", baseEnv };
  const off = buildInvocation(task, "off", options);
  const sonnet = buildInvocation(task, "sonnet", options);
  const shadow = buildInvocation(task, "shadow", options);
  const jev = buildInvocation(task, "jev", options);

  assert.ok(!off.argv.includes("--plugin-dir") && !sonnet.argv.includes("--plugin-dir"), "no plugin without the plugin arms");
  assert.equal(shadow.argv[shadow.argv.indexOf("--plugin-dir") + 1], "/plugin dir");
  assert.deepEqual(off.argv.slice(0, 5), ["/fake/claude", "-p", "do it", "--output-format", "json"]);
  assert.ok(off.argv.includes("--max-budget-usd") && off.argv[off.argv.indexOf("--max-budget-usd") + 1] === "1.00");
  assert.equal(off.argv[off.argv.indexOf("--allowedTools") + 1], "Read,Agent");

  assert.deepEqual([off.env.ORCH_MODE, off.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE], [undefined, undefined], "the shell's switches do not leak into the off arm");
  assert.deepEqual([sonnet.env.CLAUDE_CODE_SUBAGENT_MODEL, sonnet.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE], ["sonnet", "1"]);
  assert.deepEqual([shadow.env.ORCH_MODE, jev.env.ORCH_MODE], ["shadow", "enforce"]);
  assert.equal(jev.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined, "the forced subagent model must stay off in the plugin arms");
  assert.deepEqual([jev.env.ORCH_DATA_DIR, jev.env.ORCH_LIMITS_FILE, jev.env.ORCH_CODEX_ENABLED], ["/data", "/data/limits-latest.json", "1"]);
  assert.throws(() => buildInvocation(task, "nope", options), /unknown arm/);
  assert.throws(() => buildInvocation(task, "jev", { ...options, pluginDir: undefined }), /needs a plugin folder/);
  assert.deepEqual(Object.keys(ARMS), ["off", "sonnet", "shadow", "jev", "low", "medium"]);
  assert.deepEqual(DEFAULT_ARMS, ["off", "sonnet", "shadow", "jev"], "the effort baselines run only when named, so a plain run costs what it did");
});

test("the effort baselines set the session effort and no effort from the shell reaches any arm", () => {
  const task = { name: "t", prompt: "do it", cwd: "/work", model: "sonnet", budgetUsd: 1, timeoutS: 10, allowedTools: ["Read", "Agent"], export: false };
  const baseEnv = { PATH: "/bin", CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_EFFORT: "xhigh" };
  const options = { claudeBin: "/fake/claude", pluginDir: "/plugin dir", dataDir: "/data", baseEnv };
  const effortOf = (argv) => (argv.includes("--effort") ? argv[argv.indexOf("--effort") + 1] : null);
  for (const [arm, effort] of [["low", "low"], ["medium", "medium"], ["off", null], ["sonnet", null], ["jev", null]]) {
    const invocation = buildInvocation(task, arm, options);
    assert.equal(effortOf(invocation.argv), effort, `${arm} runs at ${effort ?? "the model's default"}`);
    assert.deepEqual([invocation.env.CLAUDE_CODE_EFFORT_LEVEL, invocation.env.CLAUDE_EFFORT], [undefined, undefined], `the shell's effort must not reach ${arm}`);
    assert.equal(invocation.argv[2], "do it", "the flag must not move the prompt");
  }
  const low = buildInvocation(task, "low", options);
  assert.ok(!low.argv.includes("--plugin-dir"), "a single-model baseline runs without the plugin");
  assert.equal(low.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined, "and without a forced subagent model");
});

test("gradeRecord grades the answer everywhere and the route only where the hook enforces", () => {
  const task = { name: "t", expect: { contains: ["exists.mjs", "reader.mjs"], notContains: ["paths.mjs"] }, expectRoute: { agent: "Explore", model: "haiku" } };
  const base = { task: "t", is_error: false, timed_out: false, result: "src/exists.mjs\nsrc/reader.mjs", dispatches: [{ final: { agent: "Explore", model: "haiku" } }] };

  const good = gradeRecord({ ...base, arm: "jev" }, task);
  assert.deepEqual([good.pass, good.scored, good.graders.length], [true, true, 3]);

  const wrongAnswer = gradeRecord({ ...base, arm: "jev", result: "src/exists.mjs\nsrc/paths.mjs" }, task);
  assert.equal(wrongAnswer.pass, false);
  assert.deepEqual(wrongAnswer.graders.filter((grader) => !grader.pass).map((grader) => grader.name), ["answer.contains", "answer.notContains"]);

  const wrongRoute = gradeRecord({ ...base, arm: "jev", dispatches: [{ final: { agent: "Explore", model: "sonnet" } }] }, task);
  assert.equal(wrongRoute.pass, false, "the right answer on the wrong route is still a failure");
  assert.deepEqual(wrongRoute.graders.find((grader) => grader.name === "route"), { name: "route", pass: false, detail: "0 of 1 dispatches as expected, at least 1 wanted" });

  // A session that dispatches several times must route all of them, not one.
  const many = { name: "t", expectRoute: { agent: "Explore", model: "haiku", min: 3 } };
  const right = { final: { agent: "Explore", model: "haiku" } };
  const wrong = { final: { agent: "Explore", model: "sonnet" } };
  assert.equal(gradeRecord({ ...base, arm: "jev", dispatches: [right, right, right] }, many).pass, true);
  assert.equal(gradeRecord({ ...base, arm: "jev", dispatches: [right, wrong, right] }, many).pass, false, "one wrong route among three fails the run");
  assert.equal(gradeRecord({ ...base, arm: "jev", dispatches: [right, right] }, many).pass, false, "too few dispatches fails, so a session that skipped one is caught");

  // The arms without the routing have no dispatch, so the route is not graded
  // there. Grading it would fail every baseline run for the wrong reason.
  for (const arm of ["off", "sonnet", "shadow"]) {
    const grade = gradeRecord({ ...base, arm, dispatches: [] }, task);
    assert.deepEqual([grade.pass, grade.graders.map((grader) => grader.name)], [true, ["answer.contains", "answer.notContains"]], `${arm} grades the answer only`);
  }
  assert.equal(gradeRecord({ ...base, arm: "jev", dispatches: [] }, task).pass, false, "the routing arm with no dispatch fails the route grader");

  const errored = gradeRecord({ ...base, arm: "jev", is_error: true }, task);
  assert.deepEqual([errored.scored, errored.pass], [false, null], "a failed run has no answer to grade");
  assert.equal(gradeRecord({ ...base, arm: "jev", timed_out: true }, task).pass, null, "a timed-out run is not graded");
  assert.equal(gradeRecord({ ...base, arm: "jev" }, { name: "t" }).pass, null, "a task without graders is ungraded, not a pass");
});

// The answer saved in a record is cut to --result-chars. Grading a cut answer
// reads both ways wrong, so such a run must not be graded at all.
test("an answer that was cut short is not graded either way", () => {
  const task = { name: "t", expect: { contains: ["needle"], notContains: ["forbidden"] } };
  const base = { task: "t", arm: "jev", is_error: false, timed_out: false, dispatches: [] };

  // The kept text stops before the expected string, which is really there.
  const lostAHit = gradeRecord({ ...base, result: "a".repeat(20), result_chars: 500 }, task);
  assert.deepEqual([lostAHit.cutOff, lostAHit.scored, lostAHit.pass], [true, false, null], "a missing string may simply be past the cut");

  // The kept text stops before a string that must not appear, which is there.
  const hidAMiss = gradeRecord({ ...base, result: "clean text", result_chars: 900 }, task);
  assert.deepEqual([hidAMiss.cutOff, hidAMiss.pass], [true, null], "an absent string may simply be past the cut");

  // A whole answer is graded as before.
  const whole = { ...base, result: "needle and nothing else", result_chars: "needle and nothing else".length };
  const graded = gradeRecord(whole, task);
  assert.deepEqual([graded.cutOff, graded.scored, graded.pass], [false, true, true]);
  // A record from before this field existed is graded, not thrown away.
  const older = gradeRecord({ ...base, result: "needle and nothing else" }, task);
  assert.deepEqual([older.cutOff, older.pass], [false, true]);
});

// One arm of a summary, as the pass rule reads it. In a task without `verify`, a run
// that errored or timed out is not graded, so the fixture derives the graded runs
// from the runs that survived rather than letting a test state an impossible arm.
function ruleArm(extra = {}) {
  const base = { runs: 3, errors: 0, timeouts: 0, tokens_mean: 1000, tokens_stderr: 5, wall_mean_ms: 10000, wall_stderr_ms: 50, cache_created_mean: 20000, route_failed: 0, failed_graders: {}, ...extra };
  const graded = extra.accuracy_graded ?? base.runs - base.errors - base.timeouts;
  const passed = extra.accuracy_passed ?? graded;
  return {
    tokens_known: base.runs,
    wall_known: base.runs,
    ...base,
    accuracy_graded: graded,
    accuracy_passed: passed,
    accuracy: extra.accuracy ?? (graded === 0 ? null : passed / graded)
  };
}
const ruleFor = (jev, sonnet = {}) => checkPassRule({ tasks: { t: { jev: ruleArm(jev), sonnet: ruleArm(sonnet) } } }).t;

test("an arm that fails more often than the baseline does not pass", () => {
  // Fewer tokens, and every run it finished was right, but half its runs fell over.
  const flaky = ruleFor({ runs: 6, errors: 2, timeouts: 1, tokens_mean: 500 }, { runs: 6 });
  assert.equal(flaky.verdict, "FAIL");
  assert.match(flaky.reasons[0], /failed in a larger share of its runs than the baseline \(3 of 6, 50%, against 0 of 6, 0%\)/);

  // The same number of failures over different totals. Counting them would call
  // these arms equal; as shares, the routing arm is three times worse. The arms
  // end up with different totals whenever a run stops early or an arm is rerun.
  const sameCountWorseShare = ruleFor({ runs: 6, errors: 2, tokens_mean: 500 }, { runs: 20, errors: 2 });
  assert.equal(sameCountWorseShare.verdict, "FAIL", "2 failures in 6 is worse than 2 in 20, though the counts are equal");
  assert.match(sameCountWorseShare.reasons[0], /2 of 6, 33%, against 2 of 20, 10%/);

  // The other way round: more failures, smaller share, so not a reason to fail.
  assert.equal(ruleFor({ runs: 20, errors: 2, tokens_mean: 500 }, { runs: 6, errors: 2 }).verdict, "PASS");
  // The same failure count on both arms is not evidence against the routing.
  assert.equal(ruleFor({ runs: 6, errors: 1, tokens_mean: 500 }, { runs: 6, errors: 1 }).verdict, "PASS");
});

test("the pass rule puts accuracy first, so a correct move to a larger model can pass", () => {
  // A clear win passes although it uses far more tokens and time.
  const win = ruleFor(
    { runs: 5, accuracy_graded: 5, accuracy_passed: 5, tokens_mean: 9000, wall_mean_ms: 90000 },
    { runs: 5, accuracy_graded: 5, accuracy_passed: 0, accuracy: 0 }
  );
  assert.equal(win.verdict, "PASS");
  assert.match(win.reasons[0], /clearly more accurate/);

  // 3 of 3 against 0 of 3: the ranges overlap, so this is no clear win, and at more
  // tokens it is neither a pass nor a failure.
  const notClear = ruleFor({ tokens_mean: 9000 }, { accuracy_passed: 0, accuracy: 0 });
  assert.equal(notClear.verdict, "NOT DECIDED");
  assert.match(notClear.reasons[0], /more accurate, not clearly, and uses more tokens/);
  assert.match(notClear.reasons[1], /jev 3 of 3 \(range 44% to 100%\), sonnet 0 of 3 \(range 0% to 56%\)/);
  // The same higher rate with fewer tokens passes.
  assert.equal(ruleFor({ tokens_mean: 500 }, { accuracy_passed: 0, accuracy: 0 }).verdict, "PASS");

  // Any loss that was seen fails, whatever the tokens and the time did.
  const loss = ruleFor({ accuracy_passed: 2, tokens_mean: 100, wall_mean_ms: 100 });
  assert.equal(loss.verdict, "FAIL");
  assert.match(loss.reasons[0], /answers worse than the baseline \(67% against 100%\)/);
  // A wrong route fails on its own, and it does not read as an accuracy loss.
  const route = ruleFor({ tokens_mean: 500, route_failed: 2 });
  assert.equal(route.verdict, "FAIL");
  assert.deepEqual(route.reasons, ["the route was not the expected one in 2 of 3 runs"]);
  // It fails even next to a clear accuracy win, and when neither arm answered right.
  const routeOnly = ["the route was not the expected one in 1 of 5 runs"];
  assert.deepEqual(ruleFor({ runs: 5, route_failed: 1 }, { runs: 5, accuracy_passed: 0, accuracy: 0 }), { verdict: "FAIL", reasons: routeOnly });
  assert.deepEqual(ruleFor({ runs: 5, accuracy_passed: 0, route_failed: 1 }, { runs: 5, accuracy_passed: 0 }), { verdict: "FAIL", reasons: routeOnly });
  // Every failure that was seen is named.
  const allThree = ruleFor({ runs: 6, errors: 2, accuracy_graded: 4, accuracy_passed: 2, route_failed: 1 }, { runs: 6 });
  assert.equal(allThree.verdict, "FAIL");
  assert.equal(allThree.reasons.length, 3);
  assert.match(allThree.reasons.join("\n"), /answers worse[^]*route was not[^]*larger share/);

  // Two arms that are both always wrong: fewer tokens must not make this a pass.
  const bothWrong = ruleFor({ accuracy_passed: 0, tokens_mean: 500 }, { accuracy_passed: 0 });
  assert.equal(bothWrong.verdict, "NOT DECIDED");
  assert.match(bothWrong.reasons[0], /neither arm answered right/);
});

test("the pass rule goes to tokens and then to time, each with a margin fixed in advance", () => {
  const pass = ruleFor({ tokens_mean: 500 });
  assert.equal(pass.verdict, "PASS");
  assert.match(pass.reasons[0], /fewer tokens \(jev 500, sonnet 1,000 tokens\)/);
  assert.match(pass.reasons[1], /no accuracy loss seen/, "the verdict says that this is no proof of equal accuracy");
  const more = ruleFor({ tokens_mean: 2000 });
  assert.equal(more.verdict, "FAIL");
  assert.match(more.reasons[0], /uses more tokens than the baseline/);

  // The margin is 10 percent of the baseline. The gap at exactly the margin, with
  // no noise, is the same; one token more is a real difference.
  const exact = (tokens) => ruleFor({ tokens_mean: tokens, tokens_stderr: 0, wall_mean_ms: 5000 }, { tokens_stderr: 0 });
  assert.match(exact(1100).reasons[0], /same tokens, and the jev arm is faster/);
  assert.equal(exact(1101).verdict, "FAIL");
  assert.equal(exact(899).verdict, "PASS");
  assert.match(exact(900).reasons[0], /same tokens, and the jev arm is faster/, "the margin holds on the low side too");
  assert.match(exact(899).reasons[0], /fewer tokens/);

  // A small gap in noisy runs is not the same as equal tokens, so time must not decide.
  const noisy = ruleFor({ tokens_mean: 7680, tokens_stderr: 700, wall_mean_ms: 100 }, { tokens_mean: 7440, tokens_stderr: 110 });
  assert.equal(noisy.verdict, "NOT DECIDED");
  assert.match(noisy.reasons[0], /tokens cannot be told apart from noise/);
  // A wrong route is still a failure, even when the tokens are pure noise.
  const noisyWrongRoute = ruleFor({ tokens_mean: 7680, tokens_stderr: 700, route_failed: 2 }, { tokens_mean: 7440, tokens_stderr: 110 });
  assert.equal(noisyWrongRoute.verdict, "FAIL");
  assert.match(noisyWrongRoute.reasons[0], /route was not the expected one in 2 of 3/);

  // Time decides only when the tokens are the same.
  assert.equal(ruleFor({ wall_mean_ms: 5000 }).verdict, "PASS");
  const slower = ruleFor({ wall_mean_ms: 20000 });
  assert.equal(slower.verdict, "FAIL");
  assert.match(slower.reasons[0], /uses more time than the baseline \(jev 20\.0 s, sonnet 10\.0 s\)/);
  const same = ruleFor({});
  assert.equal(same.verdict, "NOT DECIDED");
  assert.match(same.reasons[0], /no difference in tokens or time/);
  const noisyTime = ruleFor({ wall_mean_ms: 10500, wall_stderr_ms: 2000 });
  assert.equal(noisyTime.verdict, "NOT DECIDED");
  assert.match(noisyTime.reasons[0], /time cannot be told apart from noise/);

  // The time margin is 10 percent of the baseline too.
  const exactTime = (ms) => ruleFor({ wall_mean_ms: ms, wall_stderr_ms: 0 }, { wall_stderr_ms: 0 });
  assert.match(exactTime(11000).reasons[0], /no difference in tokens or time/);
  assert.equal(exactTime(11001).verdict, "FAIL");
  assert.equal(exactTime(8999).verdict, "PASS");
  // A higher accuracy that is no clear win turns more time into no verdict.
  const slowerButBetter = ruleFor({ wall_mean_ms: 20000 }, { accuracy_passed: 0, accuracy: 0 });
  assert.equal(slowerButBetter.verdict, "NOT DECIDED");
  assert.match(slowerButBetter.reasons[0], /more accurate, not clearly, and uses more time/);

  // Tokens that went up cannot be saved by time when the accuracy is no higher.
  assert.equal(ruleFor({ tokens_mean: 2000, wall_mean_ms: 100 }).verdict, "FAIL");

  // More runs must make a verdict easier, not harder.
  const scatter = 120;
  const decide = (runs) =>
    ruleFor({ runs, tokens_mean: 1700, tokens_stderr: scatter / Math.sqrt(runs) }, { runs, tokens_mean: 2450, tokens_stderr: scatter / Math.sqrt(runs) }).verdict;
  assert.equal(decide(3), "PASS");
  assert.equal(decide(9), "PASS", "adding runs never turns a decided result back into noise");
});

test("the pass rule refuses a verdict on too few runs, missing numbers or unequal cache warmth", () => {
  const tooFew = ruleFor({ runs: 2, tokens_mean: 500 });
  assert.equal(tooFew.verdict, "NOT DECIDED");
  assert.match(tooFew.reasons[0], /fewer than 3 graded runs/);
  const errored = ruleFor({ errors: 1, tokens_mean: 500 });
  assert.match(errored.reasons[0], /fewer than 3 graded runs/, "in a task without `verify` an errored run is not graded, so it is not evidence");
  // The summary does not say whether the task had `verify`, so the reason must
  // hold for both kinds. With `verify` an errored run is graded, as a failure.
  assert.match(errored.reasons[0], /a task without `verify` does not grade a run that errored, timed out or was cut off; a task with `verify` grades every run, and an errored or timed-out run fails/);
  assert.match(errored.reasons[0], /\(jev 2 of 3, sonnet 3 of 3\)/, "the reason counts the graded runs of each arm");
  // The rule holds for the baseline arm too: a short baseline is no evidence.
  const shortBaseline = ruleFor({ tokens_mean: 500 }, { errors: 1 });
  assert.equal(shortBaseline.verdict, "NOT DECIDED");
  assert.match(shortBaseline.reasons[0], /fewer than 3 graded runs per arm \(jev 3 of 3, sonnet 2 of 3\)/);
  // A task whose only grader is the route grader has no accuracy.
  const routeOnly = ruleFor({ accuracy_graded: 0 }, { accuracy_graded: 0 });
  assert.equal(routeOnly.verdict, "NOT DECIDED");
  assert.match(routeOnly.reasons.join("\n"), /no answer grader ran/);

  // A run with no token count stays unknown: it never reads as zero.
  const noTokens = ruleFor({ tokens_mean: 500, tokens_known: 1 });
  assert.equal(noTokens.verdict, "NOT DECIDED");
  assert.match(noTokens.reasons[0], /too few runs reported tokens \(jev 1, sonnet 3\)/);
  assert.match(ruleFor({ tokens_mean: 500 }, { tokens_known: 1 }).reasons[0], /too few runs reported tokens \(jev 3, sonnet 1\)/);
  assert.match(ruleFor({ tokens_mean: null }).reasons[0], /too few runs reported tokens/);
  const noClock = ruleFor({ wall_known: 1, wall_mean_ms: 100 });
  assert.equal(noClock.verdict, "NOT DECIDED", "a time known from too few runs cannot decide");
  assert.match(noClock.reasons[0], /too few runs reported a time \(jev 1, sonnet 3\)/);

  // A summary from before the accuracy fields existed gets no verdict and no NaN.
  const old = { runs: 4, errors: 1, timeouts: 0, graded: 3, passed: 3, pass_rate: 1, cost_mean_usd: 0.1, cache_created_mean: 20000, failed_graders: {} };
  const oldRule = checkPassRule({ tasks: { t: { jev: old, sonnet: { ...old, runs: 3, errors: 0 } } } }).t;
  assert.equal(oldRule.verdict, "NOT DECIDED");
  assert.match(oldRule.reasons[0], /no usable accuracy counts.*--regrade/);
  // More passes than graded runs is no pass rate, so it gets no range and no verdict.
  assert.match(ruleFor({ accuracy_passed: 4, tokens_mean: 500 }).reasons[0], /no usable accuracy counts/);

  // Unequal cache warmth blocks tokens, and time must not decide in their place.
  const cache = ruleFor({ tokens_mean: 500, wall_mean_ms: 100, cache_created_mean: 60000 });
  assert.equal(cache.verdict, "NOT DECIDED");
  assert.match(cache.reasons[0], /prompt cache \(a factor of 3\.0\)/);
  // It does not hide an accuracy result: a loss still fails, and a clear win still passes.
  assert.equal(ruleFor({ accuracy_passed: 2, cache_created_mean: 60000 }).verdict, "FAIL");
  assert.equal(
    ruleFor({ runs: 5, cache_created_mean: 60000 }, { runs: 5, accuracy_passed: 0, accuracy: 0 }).verdict,
    "PASS"
  );
  assert.equal(checkPassRule({ tasks: { t: { jev: ruleArm() } } }).t.verdict, "NOT DECIDED", "without the baseline arm there is no verdict");
});

test("the summary keeps accuracy, the route and the tokens apart", () => {
  const usage = { "claude-a": { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 100, cacheReadInputTokens: 9000 }, "claude-b": { inputTokens: 1, outputTokens: 2 } };
  const task = { name: "t", expect: { contains: ["needle"] }, expectRoute: { model: "haiku" } };
  const run = (extra) => ({ task: "t", arm: "jev", is_error: false, timed_out: false, result: "needle", result_chars: 6, cost_usd: 0.1, wall_ms: 100, model_usage: usage, dispatches: [], ...extra });
  const summary = summarize(
    [
      // The right answer on the wrong route: a route failure, and no accuracy loss.
      run({}),
      run({ model_usage: {} }),
      run({ arm: "sonnet" })
    ],
    [task]
  );
  const jev = summary.tasks.t.jev;
  assert.deepEqual([jev.accuracy_graded, jev.accuracy_passed, jev.accuracy], [2, 2, 1]);
  assert.equal(jev.route_failed, 2);
  assert.equal(jev.pass_rate, 0, "the old pass rate still joins the two graders");
  assert.equal(jev.tokens_mean, 118, "input, output and cache writes over all models, with no cache reads");
  assert.equal(jev.tokens_known, 1, "a run with no usage stays unknown and does not count as zero");
  assert.deepEqual([summary.tasks.t.sonnet.accuracy, summary.tasks.t.sonnet.route_failed], [1, 0], "only the routing arm gets the route grader");
  assert.equal(jev.wall_known, 2);
});

// When the hook agrees with a worker's own model, the dispatch record keeps
// `final.model` null, and only the `launched` record says which model ran.
test("the route grader accepts a worker that ran on its own default model", () => {
  const task = { name: "t", expectRoute: { agent: "subagent-router:searcher", model: "haiku" } };
  const base = { task: "t", arm: "jev", is_error: false, timed_out: false, result: "x" };
  const inherited = (resolved) => [{ final: { agent: "subagent-router:searcher", model: null }, resolved_model: resolved }];

  assert.equal(gradeRecord({ ...base, dispatches: inherited("claude-haiku-4-5-20251001") }, task).pass, true, "Haiku ran, so the route is the expected one");
  assert.equal(gradeRecord({ ...base, dispatches: inherited("claude-sonnet-5") }, task).pass, false, "Sonnet ran, so the route is wrong");
  assert.equal(gradeRecord({ ...base, dispatches: inherited(null) }, task).pass, false, "an unknown model is not a match");
  // A model that the hook set wins over the launched one.
  const set = [{ final: { agent: "subagent-router:searcher", model: "sonnet" }, resolved_model: "claude-haiku-4-5-20251001" }];
  assert.equal(gradeRecord({ ...base, dispatches: set }, task).pass, false);
});

// Found by the Codex review of 2026-09-24. An arm that wrote nothing into the
// prompt cache against one that wrote a lot is the largest gap there is, not
// no gap.
test("a cache write of zero against a positive one blocks the verdict", () => {
  const arm = (extra = {}) => ({ runs: 3, errors: 0, timeouts: 0, graded: 3, passed: 3, pass_rate: 1, cost_mean_usd: 0.1, cost_stderr_usd: 0.0005, cache_created_mean: 60000, failed_graders: {}, ...extra });

  const rule = ruleFor({ tokens_mean: 500, cache_created_mean: 0 }, { cache_created_mean: 60000 });
  assert.equal(rule.verdict, "NOT DECIDED");
  assert.match(rule.reasons[0], /prompt cache \(one arm wrote nothing\)/);
  const effort = compareEffortBaselines({ tasks: { t: { jev: arm({ cache_created_mean: 0 }), low: arm({ cost_mean_usd: 0.05 }) } } });
  assert.equal(effort.t.low.outcome, "not compared");
  // Two arms that both wrote nothing are equally cold, so they compare.
  assert.equal(ruleFor({ tokens_mean: 500, cache_created_mean: 0 }, { cache_created_mean: 0 }).verdict, "PASS");
});

// Found by the Codex review of 2026-09-24. A task name is free text, and a
// name like `constructor` must get its own summary like any other.
test("summarize keeps a task whose name is also an object property", () => {
  const record = (task) => ({ task, arm: "jev", is_error: false, timed_out: false, result: "x", cost_usd: 0.1, dispatches: [] });
  const summary = summarize([record("constructor"), record("toString"), record("plain")]);
  assert.deepEqual(Object.keys(summary.tasks).sort(), ["constructor", "plain", "toString"]);
  assert.equal(summary.tasks.constructor.jev.runs, 1);
  assert.equal(summary.tasks.toString.jev.runs, 1);
});

test("compareEffortBaselines says whether a plain session at lower effort beats the routing", () => {
  const arm = (extra = {}) => {
    const base = { runs: 3, errors: 0, timeouts: 0, cost_mean_usd: 0.2, cost_stderr_usd: 0.005, cache_created_mean: 20000, failed_graders: {}, wall_mean_ms: null, turns_mean: null, models: [], routes: {}, ...extra };
    const graded = extra.graded ?? base.runs - base.errors - base.timeouts;
    const passed = extra.passed ?? graded;
    return { ...base, graded, passed, pass_rate: "pass_rate" in extra ? extra.pass_rate : graded === 0 ? null : passed / graded };
  };
  const compare = (arms) => compareEffortBaselines({ tasks: { t: arms } }).t;

  assert.equal(compare({ jev: arm(), low: arm({ cost_mean_usd: 0.1 }) }).low.outcome, "low is cheaper at the same pass rate or better");
  assert.equal(compare({ jev: arm({ cost_mean_usd: 0.1 }), medium: arm() }).medium.outcome, "jev is cheaper");
  assert.equal(compare({ jev: arm(), low: arm({ cost_mean_usd: 0.19 }) }).low.outcome, "cost cannot be told apart", "a gap inside the noise is not a result");
  // Cheaper but less often right is not a better baseline.
  assert.equal(compare({ jev: arm(), low: arm({ cost_mean_usd: 0.05, passed: 2 }) }).low.outcome, "low answers worse");
  // The guards of the pass rule hold here too.
  const few = compare({ jev: arm(), low: arm({ runs: 2, cost_mean_usd: 0.05 }) }).low;
  assert.equal(few.outcome, "not compared");
  assert.match(few.reasons[0], /fewer than 3 graded runs/);
  // An arm that no grader could read has no pass rate, so it cannot be compared.
  const ungraded = compare({ jev: arm(), medium: arm({ cost_mean_usd: 0.05, pass_rate: null }) }).medium;
  assert.equal(ungraded.outcome, "not compared");
  assert.match(ungraded.reasons.join("\n"), /a pass rate or a cost is missing/);
  assert.match(compare({ jev: arm(), low: arm({ cost_mean_usd: 0.05, cache_created_mean: 70000 }) }).low.reasons[0], /prompt cache \(a factor of 3\.5\)/);
  // Without the jev arm, or without a baseline, there is nothing to compare.
  assert.deepEqual(compareEffortBaselines({ tasks: { t: { low: arm(), sonnet: arm() } } }), {});
  assert.deepEqual(compareEffortBaselines({ tasks: { t: { jev: arm(), sonnet: arm() } } }), {});
  // The pass rule itself does not change: it still reads jev against sonnet only.
  const both = { tasks: { t: { jev: { ...arm({ cost_mean_usd: 0.1 }), ...ruleArm({ tokens_mean: 500 }) }, sonnet: { ...arm(), ...ruleArm() }, low: arm({ cost_mean_usd: 0.05 }) } } };
  assert.equal(checkPassRule(both).t.verdict, "PASS");
  assert.match(renderSummary({ runs: 9, cost_usd: 1, errors: 0, timeouts: 0, tasks: both.tasks }), /effort baselines against jev \(information only, not the pass rule\):\n  t, low: low is cheaper/);
});

test("rotateArms moves every arm through every position", () => {
  const arms = ["off", "sonnet", "shadow", "jev"];
  assert.deepEqual(rotateArms(arms, 1), ["off", "sonnet", "shadow", "jev"]);
  assert.deepEqual(rotateArms(arms, 2), ["sonnet", "shadow", "jev", "off"]);
  assert.deepEqual(rotateArms(arms, 4), ["jev", "off", "sonnet", "shadow"]);
  assert.deepEqual(rotateArms(arms, 5), arms, "after a full turn the order starts again");
  // Over as many runs as there are arms, each arm stands in each position once.
  for (let position = 0; position < arms.length; position += 1) {
    const seen = [1, 2, 3, 4].map((run) => rotateArms(arms, run)[position]);
    assert.deepEqual([...seen].sort(), [...arms].sort(), `position ${position} sees every arm`);
  }
  assert.deepEqual(rotateArms([], 3), []);
  assert.deepEqual(rotateArms(["off"], 7), ["off"]);
});

test("parseResult and makeRecord read the result object and the run's dispatches", () => {
  const tempDir = makeTempDir("orch-eval-");
  try {
    assert.equal(parseResult(""), null);
    assert.equal(parseResult("not json"), null);
    assert.deepEqual(parseResult('noise\n{"type":"result","total_cost_usd":0.1}\n'), { type: "result", total_cost_usd: 0.1 });

    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(
      path.join(dataDir, "dispatch-log.jsonl"),
      `${JSON.stringify({ event: "dispatch", tool_use_id: "t1", requested: { agent: "Explore", model: null }, final: { agent: "Explore", model: "haiku" }, action: "rewrite", reason: "search", model_only: true, jev: { kind: "search", kindConfidence: 0.9, difficulty: 1.4 } })}\n${JSON.stringify({ event: "launched", tool_use_id: "t1", resolved_model: "claude-haiku-4-5" })}\n`
    );
    const task = { name: "t", cwd: "/work" };
    const invocation = { cwd: "/work" };
    const stdout = JSON.stringify({
      is_error: false,
      total_cost_usd: 0.2,
      num_turns: 3,
      duration_ms: 500,
      duration_api_ms: 400,
      result: "x".repeat(50),
      modelUsage: { "claude-haiku-4-5": { cacheReadInputTokens: 700, cacheCreationInputTokens: 30 }, "claude-sonnet-5": { cacheReadInputTokens: 300 } },
      permission_denials: [{}]
    });
    const record = makeRecord({ task, arm: "jev", run: 1, invocation, outcome: { stdout, stderr: "", code: 0, signal: null, timedOut: false, durationMs: 700 }, dataDir, resultChars: 10 });
    assert.deepEqual([record.is_error, record.cost_usd, record.num_turns, record.permission_denials, record.result, record.result_chars], [false, 0.2, 3, 1, "xxxxxxxxxx", 50]);
    assert.deepEqual([record.cache_read, record.cache_created], [1000, 30], "cache tokens are added up over every model of the run");
    assert.equal(record.dispatches.length, 1);
    assert.deepEqual([record.dispatches[0].final.model, record.dispatches[0].resolved_model, record.dispatches[0].model_only, record.dispatches[0].kind], ["haiku", "claude-haiku-4-5", true, "search"]);

    const broken = makeRecord({ task, arm: "off", run: 1, invocation, outcome: { stdout: "", stderr: "boom", code: 1, signal: null, timedOut: false, durationMs: 10 }, dataDir: path.join(tempDir, "none") });
    assert.deepEqual([broken.is_error, broken.cost_usd, broken.dispatches, broken.stderr_tail], [true, null, [], "boom"]);
    const late = makeRecord({ task, arm: "off", run: 1, invocation, outcome: { stdout: "", stderr: "", code: null, signal: "SIGKILL", timedOut: true, durationMs: 10 }, dataDir: path.join(tempDir, "none") });
    assert.deepEqual([late.is_error, late.timed_out], [false, true], "a timeout is not an error");

    const summary = summarize([record, broken, late]);
    assert.deepEqual([summary.runs, summary.errors, summary.timeouts, summary.cost_usd], [3, 1, 1, 0.2]);
    assert.deepEqual(summary.tasks.t.jev.routes, { "Explore -> Explore/haiku (rewrite: search)": 1 });
    const text = renderSummary(summary);
    assert.match(text, /Task t/);
    assert.match(text, /jev +1 +0 +0 +- +\$0\.200/, "an ungraded run shows no pass count");
    assert.match(text, /cache new/, "the cache column warns before the cost is read");
    assert.match(text, /jev .*\b30\b/, "the mean of new cache tokens is shown per arm");
    assert.ok(!text.includes("xxxxxxxxxx"), "the answer stays out of the summary");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the command runs every task in every arm, records the runs and prints counts only", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "imports", prompt: "SECRET-MARKER find the files that import node:fs", cwd: project, timeoutS: 30 }]);
    const outDir = path.join(tempDir, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--runs", "2", "--out", outDir], env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Plan: 1 tasks x 4 arms x 2 runs = 8 runs/);
    assert.match(result.stdout, /Offline evaluation: 8 runs, \$0\.400 in total, 0 errors, 0 timeouts/);
    assert.match(result.stdout, /subagent-router:implementer -> subagent-router:searcher\/haiku \(rewrite: search\) x2/);
    assert.match(result.stdout, /subagent-router:implementer -> subagent-router:implementer\/default \(shadow: search\) x2/);
    assert.ok(!result.stdout.includes("SECRET-MARKER"), "the prompt stays out of the output");

    const records = readLines(path.join(outDir, "runs.jsonl"));
    assert.equal(records.length, 8);
    assert.deepEqual(
      records.map((record) => record.arm),
      ["off", "sonnet", "shadow", "jev", "sonnet", "shadow", "jev", "off"],
      "run 2 starts at the second arm, so no arm always runs on the same cache warmth"
    );
    const jev = records.find((record) => record.arm === "jev");
    assert.deepEqual([jev.cost_usd, jev.dispatches.length, jev.dispatches[0].resolved_model, Object.keys(jev.model_usage)], [0.05, 1, "claude-haiku-4-5", ["claude-haiku-4-5"]]);
    assert.deepEqual([jev.cache_read, jev.cache_created], [100, 20]);
    assert.equal(records.find((record) => record.arm === "off").dispatches.length, 0);

    const calls = readLines(log);
    assert.equal(calls.length, 8);
    // The first four calls are run 1 of each arm, in the order of the records.
    const byArm = Object.fromEntries(records.slice(0, 4).map((record, index) => [record.arm, calls[index]]));
    assert.ok(!byArm.off.args.includes("--plugin-dir") && byArm.jev.args.includes(ROOT), "the plugin folder is this repository, in the plugin arms only");
    assert.deepEqual([byArm.sonnet.SUBAGENT_MODEL, byArm.sonnet.SUBAGENT_FORCE, byArm.jev.SUBAGENT_FORCE], ["sonnet", "1", null]);
    assert.deepEqual([byArm.shadow.ORCH_MODE, byArm.jev.ORCH_MODE, byArm.off.ORCH_MODE], ["shadow", "enforce", null]);
    assert.equal(byArm.jev.ORCH_DATA_DIR, path.join(outDir, "imports", "jev", "run-1", "data"));
    assert.ok(!fs.existsSync(byArm.jev.ORCH_LIMITS_FILE), "no usage sample reaches a run");
    assert.equal(byArm.off.cwd, fs.realpathSync(project));
    const savedSummary = fs.readFileSync(path.join(outDir, "summary.json"), "utf8");
    assert.equal(JSON.parse(savedSummary).runs, 8);
    assert.ok(!savedSummary.includes("SECRET-MARKER") && !savedSummary.includes("answer to:"), "neither the prompt nor the answer reaches the saved summary");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--arms low,medium runs the effort baselines through the command, and the shell's effort stays out", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "imports", prompt: "find the files", cwd: project, timeoutS: 30 }]);
    const outDir = path.join(tempDir, "out");
    const shellEnv = { ...env, CLAUDE_CODE_EFFORT_LEVEL: "max", CLAUDE_EFFORT: "xhigh" };
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "jev,low,medium", "--out", outDir], env: shellEnv });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Plan: 1 tasks x 3 arms x 1 runs = 3 runs/);
    assert.match(result.stdout, /low +no plugin, the whole session at effort low/);
    assert.match(result.stdout, /medium +no plugin, the whole session at effort medium/);
    assert.match(result.stdout, /effort baselines against jev \(information only, not the pass rule\):\n  imports, low: not compared/);

    const calls = readLines(log);
    const effortOf = (call) => (call.args.includes("--effort") ? call.args[call.args.indexOf("--effort") + 1] : null);
    assert.deepEqual(calls.map(effortOf), [null, "low", "medium"], "the arms run in the given order, each at its own effort");
    assert.ok(!calls[1].args.includes("--plugin-dir") && !calls[2].args.includes("--plugin-dir"), "the baselines run without the plugin");
    assert.deepEqual(calls.map((call) => [call.EFFORT_LEVEL, call.CLAUDE_EFFORT]), [[null, null], [null, null], [null, null]], "the shell's effort reaches no arm");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a run that exceeds its time limit is recorded as a timeout and the command goes on", async () => {
  const { tempDir, project, taskSetFile, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "slow", prompt: "wait", cwd: project, timeoutS: 1 }]);
    const outDir = path.join(tempDir, "out");
    const startedAt = Date.now();
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,jev", "--out", outDir], env: { ...env, FAKE_CLAUDE_SLEEP_MS: "5000" } });
    assert.ok(Date.now() - startedAt < 4500, "the time limit ended the runs");
    assert.equal(result.code, 1, "a timeout makes the exit code 1");
    const records = readLines(path.join(outDir, "runs.jsonl"));
    assert.deepEqual(records.map((record) => [record.arm, record.timed_out, record.is_error, record.cost_usd]), [["off", true, false, null], ["jev", true, false, null]]);
    assert.match(result.stdout, /2 runs, \$0\.000 in total, 0 errors, 2 timeouts/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a failed run is an error, and --max-total-usd stops the command", async () => {
  const { tempDir, project, taskSetFile, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: project, timeoutS: 30 }, { name: "two", prompt: "y", cwd: project, timeoutS: 30 }]);
    const failed = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", path.join(tempDir, "failed")], env: { ...env, FAKE_CLAUDE_EXIT: "1" } });
    assert.equal(failed.code, 1);
    const failedRecords = readLines(path.join(tempDir, "failed", "runs.jsonl"));
    assert.deepEqual(failedRecords.map((record) => [record.is_error, record.exit_code, record.stderr_tail.trim()]), [[true, 1, "fake claude failed"], [true, 1, "fake claude failed"]]);

    // Each run costs $0.05. The cap of $0.12 lets three runs start: after the
    // third the spend is $0.15, and the fourth does not start.
    const capped = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,jev", "--max-total-usd", "0.12", "--out", path.join(tempDir, "capped")], env });
    assert.equal(capped.code, 3);
    assert.equal(readLines(path.join(tempDir, "capped", "runs.jsonl")).length, 3);
    assert.match(capped.stderr, /stopped by --max-total-usd after \$0\.150/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a run with no cost counts at the cap that Claude got, and the total is exact", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  const slow = { ...env, FAKE_CLAUDE_SLEEP_MS: "5000" };
  const capsSent = () => readLines(log).map((call) => call.args[call.args.indexOf("--max-budget-usd") + 1]);
  try {
    // A budget of $0.006 reaches Claude as a cap of $0.01. Two timed-out runs
    // fill the limit of $0.02; counted at $0.006 each, all four would start.
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: project, timeoutS: 1, budgetUsd: 0.006 }]);
    const rounded = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,jev", "--runs", "2", "--max-total-usd", "0.02", "--out", path.join(tempDir, "rounded")], env: slow });
    assert.equal(rounded.code, 3, rounded.stderr);
    assert.deepEqual(readLines(path.join(tempDir, "rounded", "runs.jsonl")).map((record) => record.cost_usd), [null, null]);
    assert.deepEqual(capsSent(), ["0.01", "0.01"]);
    assert.match(rounded.stderr, /stopped by --max-total-usd after \$0\.020/);

    // In float dollars 0.1 + 0.7 stays below 0.8, so a third run would start.
    fs.rmSync(log);
    writeTaskSet(taskSetFile, [
      { name: "one", prompt: "x", cwd: project, timeoutS: 1, budgetUsd: 0.1 },
      { name: "two", prompt: "y", cwd: project, timeoutS: 1, budgetUsd: 0.7 },
      { name: "three", prompt: "z", cwd: project, timeoutS: 1, budgetUsd: 0.1 }
    ]);
    const exact = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--max-total-usd", "0.8", "--out", path.join(tempDir, "exact")], env: slow });
    assert.equal(exact.code, 3, exact.stderr);
    assert.deepEqual(readLines(path.join(tempDir, "exact", "runs.jsonl")).map((record) => record.task), ["one", "two"]);
    assert.match(exact.stderr, /stopped by --max-total-usd after \$0\.800/);

    // Three reported costs of $0.0333334 pass the limit of $0.1. Rounded to
    // the nearest millionth they would sum to $0.099999 and a fourth run would start.
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: project, timeoutS: 30 }]);
    const fine = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,jev", "--runs", "2", "--max-total-usd", "0.1", "--out", path.join(tempDir, "fine")], env: { ...env, FAKE_CLAUDE_COST: "0.0333334" } });
    assert.equal(fine.code, 3, fine.stderr);
    assert.deepEqual(readLines(path.join(tempDir, "fine", "runs.jsonl")).map((record) => record.cost_usd), [0.0333334, 0.0333334, 0.0333334]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--dry-run prints the plan and starts nothing", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "SECRET-MARKER x", cwd: project }]);
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--dry-run", "--out", path.join(tempDir, "out")], env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Plan: 1 tasks x 4 arms x 1 runs = 4 runs/);
    assert.match(result.stdout, /Most that the run caps allow: \$4\.000/);
    assert.match(result.stdout, /jev: ORCH_MODE=enforce .*--plugin-dir/);
    assert.match(result.stdout, /Dry run: nothing was started/);
    assert.ok(!result.stdout.includes("SECRET-MARKER"));
    assert.ok(!fs.existsSync(log) && !fs.existsSync(path.join(tempDir, "out")));

    const bad = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,nope"], env });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /unknown arm "nope"/);
    const none = await runNode("scripts/orch-eval.mjs", { args: [], env });
    assert.equal(none.code, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--regrade grades saved runs again and starts nothing", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    const task = { name: "one", prompt: "x", cwd: project, timeoutS: 30, expect: { contains: ["answer to:"] }, expectRoute: { agent: "subagent-router:searcher", model: "haiku" } };
    writeTaskSet(taskSetFile, [task]);
    const outDir = path.join(tempDir, "out");
    const first = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "sonnet,jev", "--out", outDir], env });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /jev +1 +0 +0 +1\/1/, "the route and the answer both pass");
    assert.match(first.stdout, /one: NOT DECIDED/);
    assert.match(first.stdout, /fewer than 3 graded runs per arm/);
    const callsAfterRun = readLines(log).length;

    // The same records, graded against a task that expects another route.
    writeTaskSet(taskSetFile, [{ ...task, expectRoute: { agent: "subagent-router:implementer", model: "opus" } }]);
    const again = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--regrade", outDir], env });
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Graded again from .*runs\.jsonl, 2 saved runs\. Nothing was started\./);
    assert.match(again.stdout, /jev +1 +0 +0 +0\/1/, "the changed grader turns the same run into a failure");
    assert.match(again.stdout, /graders that failed \(jev\): route x1/);
    assert.equal(readLines(log).length, callsAfterRun, "a regrade starts no run");

    const missing = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--regrade", path.join(tempDir, "nowhere")], env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no runs\.jsonl at/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--task runs part of a set, and an unknown name is an error", async () => {
  const { tempDir, project, taskSetFile, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [
      { name: "one", prompt: "x", cwd: project, timeoutS: 30 },
      { name: "two", prompt: "y", cwd: project, timeoutS: 30 }
    ]);
    const outDir = path.join(tempDir, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--task", "two", "--arms", "off", "--out", outDir], env });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Plan: 1 tasks x 1 arms/);
    const records = readLines(path.join(outDir, "runs.jsonl"));
    assert.deepEqual(records.map((record) => record.task), ["two"], "only the named task ran");

    const typo = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--task", "twoo", "--dry-run"], env });
    assert.equal(typo.code, 2, "a typo must not look like an empty set");
    assert.match(typo.stderr, /no task named "twoo" in this set; it has one, two/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("--config gives every run a copy of the config file", async () => {
  const { tempDir, project, taskSetFile, env } = setUp();
  try {
    const configFile = path.join(tempDir, "config.json");
    fs.writeFileSync(configFile, '{"codexEnabled":false,"limitGate":50}\n');
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: project }]);
    const outDir = path.join(tempDir, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off,jev", "--config", configFile, "--out", outDir], env });
    assert.equal(result.code, 0, result.stderr);
    for (const arm of ["off", "jev"]) {
      assert.equal(fs.readFileSync(path.join(outDir, "one", arm, "run-1", "data", "config.json"), "utf8"), '{"codexEnabled":false,"limitGate":50}\n');
    }
    const missing = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--config", path.join(tempDir, "none.json")], env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /config file .* does not exist/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a task with export runs in a fresh copy of the committed tree", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    const git = (...args) => execFileSync("git", ["-C", project, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "one");
    fs.writeFileSync(path.join(project, "uncommitted.txt"), "not in the export\n");
    writeTaskSet(taskSetFile, [{ name: "copy", prompt: "x", cwd: project, export: true }]);
    const outDir = path.join(tempDir, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", outDir], env });
    assert.equal(result.code, 0, result.stderr);
    const workspace = path.join(outDir, "copy", "off", "run-1", "workspace");
    assert.equal(readLines(log)[0].cwd, fs.realpathSync(workspace));
    assert.ok(fs.existsSync(path.join(workspace, "a.mjs")));
    assert.ok(!fs.existsSync(path.join(workspace, "uncommitted.txt")), "only the committed tree is copied");
    assert.ok(!fs.existsSync(path.join(workspace, ".git")), "the copy has no history");

    // The same task, arm and number again, into the same folder. The earlier
    // run's whole tree is still there, and tar unpacks over it rather than
    // replacing it, so a file that run left behind would survive into this one.
    const leftover = path.join(workspace, "written-by-the-earlier-run.txt");
    fs.writeFileSync(leftover, "should not survive");
    const second = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", outDir], env });
    assert.equal(second.code, 0, second.stderr);
    assert.ok(!fs.existsSync(leftover), "the copy starts from the commit, not from what the last run left");
    assert.ok(fs.existsSync(path.join(workspace, "a.mjs")), "the committed tree is there again");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a task with export and history runs in a clone that keeps the commits up to the pinned revision", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    fs.writeFileSync(path.join(project, "change.txt"), "the change under review\n");
    git("add", ".");
    git("commit", "-q", "-m", "change");
    writeTaskSet(taskSetFile, [{ name: "review", prompt: "x", cwd: project, export: true, history: true }]);
    const outDir = path.join(tempDir, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", outDir], env });
    assert.equal(result.code, 0, result.stderr);
    const workspace = path.join(outDir, "review", "off", "run-1", "workspace");
    assert.equal(readLines(log)[0].cwd, fs.realpathSync(workspace), "the worker ran in the clone");
    const history = execFileSync("git", ["-C", workspace, "log", "--all", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(history, ["change", "base"], "the runner passed history through to the export");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Claude Code denies every write inside a protected folder in dontAsk mode, such
// as ~/.claude, so an editing task with its workspace there can never write.
function committedProject(project) {
  const git = (...args) => execFileSync("git", ["-C", project, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { stdio: ["ignore", "ignore", "pipe"] });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "one");
}

test("editing tasks refuse a results folder where Claude Code blocks writes, before any worker starts", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    committedProject(project);
    writeTaskSet(taskSetFile, [{ name: "edit", prompt: "x", cwd: project, export: true }]);
    fs.mkdirSync(path.join(tempDir, ".claude", "worktrees", "w", ".git"), { recursive: true });
    fs.symlinkSync(path.join(tempDir, ".claude"), path.join(tempDir, "link"));
    const refused = [
      ["a .claude folder that does not exist yet", path.join(tempDir, ".claude", "orchestrator", "eval", "new")],
      ["a .git folder inside .claude/worktrees", path.join(tempDir, ".claude", "worktrees", "w", ".git", "out")],
      ["a symbolic link into .claude", path.join(tempDir, "link", "out")],
      ["the plugin folder", path.join(ROOT, "eval-out-that-must-not-exist")]
    ];
    for (const [label, out] of refused) {
      const result = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", out], env });
      assert.notEqual(result.code, 0, `${label} is refused`);
      assert.match(result.stderr, /denies every write there/, `${label}: the error names the reason`);
    }
    assert.equal(fs.existsSync(log), false, "no worker started for a refused folder");
    assert.equal(fs.existsSync(path.join(ROOT, "eval-out-that-must-not-exist")), false, "nothing was created in the plugin folder");

    // A protected temporary folder is refused too, when it would be the default.
    const protectedTmp = path.join(tempDir, ".claude", "tmp");
    fs.mkdirSync(protectedTmp);
    const byDefault = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off"], env: { ...env, TMPDIR: protectedTmp } });
    assert.notEqual(byDefault.code, 0, "a default inside a protected temporary folder is refused");
    assert.equal(fs.existsSync(log), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("editing tasks may use .claude/worktrees and default to a temporary folder; read-only tasks keep any folder", async () => {
  const { tempDir, project, taskSetFile, log, env } = setUp();
  try {
    committedProject(project);
    writeTaskSet(taskSetFile, [{ name: "edit", prompt: "x", cwd: project, export: true }]);
    const inWorktrees = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", path.join(tempDir, ".claude", "worktrees", "w", "out")], env });
    assert.equal(inWorktrees.code, 0, inWorktrees.stderr);

    const tmp = path.join(tempDir, "tmp");
    fs.mkdirSync(tmp);
    const byDefault = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off"], env: { ...env, TMPDIR: tmp } });
    assert.equal(byDefault.code, 0, byDefault.stderr);
    assert.match(byDefault.stdout, /results go to a temporary folder, which the system may clean up/);
    const runsUnderTmp = fs.readdirSync(path.join(tmp, "orchestrator-eval"));
    assert.equal(runsUnderTmp.length, 1, "the default results folder is inside the temporary folder");

    writeTaskSet(taskSetFile, [{ name: "read", prompt: "x", cwd: project }]);
    const readOnly = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "off", "--out", path.join(tempDir, ".claude", "read-only")], env });
    assert.equal(readOnly.code, 0, readOnly.stderr);
    assert.equal(readLines(log).length, 3, "all three runs started");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// Two things that only show when a folder is used twice, and one that only
// shows on disk: the records hold the answers, so they are kept privately.
test("a second run into the same folder starts clean, and the records are private", async () => {
  const { tempDir, project, taskSetFile, env } = setUp();
  try {
    writeTaskSet(taskSetFile, [{ name: "one", prompt: "x", cwd: project, timeoutS: 30 }]);
    const outDir = path.join(tempDir, "out");

    const first = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "jev", "--out", outDir], env });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(readLines(path.join(outDir, "runs.jsonl"))[0].dispatches.length, 1);

    // The same task, arm and number again. The dispatch log of the earlier run
    // is still in that folder, and counting it would put another run's routes
    // into this one's record.
    const second = await runNode("scripts/orch-eval.mjs", { args: [taskSetFile, "--arms", "jev", "--out", outDir], env });
    assert.equal(second.code, 0, second.stderr);
    const records = readLines(path.join(outDir, "runs.jsonl"));
    assert.equal(records.length, 2, "the second run is appended");
    assert.equal(records[1].dispatches.length, 1, "the second run counts only its own dispatch");

    // The answers of the runs live here, so nobody else on the machine reads them.
    assert.equal(fs.statSync(outDir).mode & 0o077, 0, "the results folder is closed to others");
    assert.equal(fs.statSync(path.join(outDir, "runs.jsonl")).mode & 0o077, 0, "the records are closed to others");
    assert.equal(fs.statSync(path.join(outDir, "summary.json")).mode & 0o077, 0, "the summary is closed to others");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
