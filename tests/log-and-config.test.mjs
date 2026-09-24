import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { mock } from "node:test";

import { CONFIG_SPEC, DEFAULTS, DEFAULT_EFFORT, DEFAULT_MODEL, REDIRECTS, WORKERS, WORKER_SET, loadConfig } from "../scripts/lib/config.mjs";
import { appendLog, logFile, logMaxBytes, readLogTail, rotatedLogFile, truncate } from "../scripts/lib/log.mjs";
import { QUESTIONS, buildRequest } from "../scripts/lib/questions.mjs";
import { JevError, readAnswers } from "../scripts/lib/typesafe.mjs";
import { lastWriterFamily, readLimitsState, recordWriterDispatch, recordWriterLaunch, recordWriterStop } from "../scripts/lib/context.mjs";
import { countFindings, reportsNoWrite } from "../scripts/lib/findings.mjs";
import { CLAUDE_FALLBACK, FIVE_HOURS_MS, SEVEN_DAYS_MS, claudeCapNotice, claudeNotice, claudeState, firstNotice, windowVerdict } from "../scripts/lib/provider-state.mjs";
import { readRouteLine } from "../scripts/lib/route-line.mjs";
import { PS_TIMEOUT_MS } from "../scripts/lib/writer-lock.mjs";
import { ROOT, cleanEnv, jevBody, makeTempDir, readLog, runNode } from "./helpers.mjs";

test("the default model of each worker matches the agent file", () => {
  for (const worker of WORKER_SET) {
    const name = worker.split(":")[1];
    const text = fs.readFileSync(path.join(ROOT, "agents", `${name}.md`), "utf8");
    assert.match(text, new RegExp(`^name: ${name}$`, "m"));
    assert.match(text, new RegExp(`^model: ${DEFAULT_MODEL[worker]}$`, "m"), `${name} must run on ${DEFAULT_MODEL[worker]}`);
    assert.ok(!/^tools:.*\bAgent\b/m.test(text), `${name} must not get the Agent tool`);
  }
});

test("the pinned effort of each worker matches the agent file", () => {
  for (const worker of WORKER_SET) {
    const name = worker.split(":")[1];
    const text = fs.readFileSync(path.join(ROOT, "agents", `${name}.md`), "utf8");
    const frontmatter = text.split(/^---$/m)[1];
    const lines = frontmatter.match(/^effort:.*$/gm) ?? [];
    const expected = DEFAULT_EFFORT[worker];
    assert.ok(expected === null || typeof expected === "string", `${name} needs an entry in DEFAULT_EFFORT`);
    assert.deepEqual(lines, expected === null ? [] : [`effort: ${expected}`], `${name} must have ${expected === null ? "no effort line" : `effort: ${expected}`}`);
  }
});

test("loadConfig merges the file and the environment, and reports bad values", () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ mode: "shadow", kindGate: 0.75, limitGate: 900 }));
    const env = { ORCH_DATA_DIR: dataDir };

    const fromFile = loadConfig(env);
    assert.equal(fromFile.config.mode, "shadow");
    assert.equal(fromFile.config.kindGate, 0.75);
    assert.equal(fromFile.config.limitGate, 80);
    assert.match(fromFile.warnings[0], /limitGate/);

    assert.equal(loadConfig({ ...env, ORCH_MODE: "off" }).config.mode, "off");

    // The completeness rule only watches until someone turns it on, and an
    // unusable value must fall back to watching, never to changing a route.
    assert.equal(fromFile.config.completeRule, "shadow");
    assert.equal(fromFile.config.completeGate, DEFAULTS.completeGate);
    assert.equal(loadConfig({ ...env, ORCH_COMPLETE_RULE: "enforce" }).config.completeRule, "enforce");
    assert.equal(loadConfig({ ...env, ORCH_COMPLETE_RULE: "off" }).config.completeRule, "off", "every allowed word must survive the check, not only the one that changes a route");
    const badRule = loadConfig({ ...env, ORCH_COMPLETE_RULE: "yes please" });
    assert.equal(badRule.config.completeRule, "shadow");
    assert.match(badRule.warnings.join("\n"), /completeRule must be one of shadow, enforce, off/);

    // A file that cannot be used must never lead to the mode that rewrites calls.
    fs.writeFileSync(path.join(dataDir, "config.json"), '{"mode": "shadow", "kindGate": 0.7,}');
    const broken = loadConfig(env);
    assert.equal(broken.config.mode, "shadow");
    assert.match(broken.warnings[0], /could not be read/);
    assert.equal(loadConfig({ ...env, ORCH_MODE: "enforce" }).config.mode, "enforce", "an explicit ORCH_MODE still wins");

    // Mistyped keys and wrong types are reported, not dropped in silence.
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ Mode: "off", kind_gate: 0.9, codexIncludeUserRules: "false", jevModel: 7 }));
    const typos = loadConfig(env);
    assert.equal(typos.config.mode, "enforce");
    assert.equal(typos.config.codexIncludeUserRules, true);
    assert.equal(typos.warnings.length, 4);
    assert.match(typos.warnings.join("\n"), /unknown key "Mode"[\s\S]*unknown key "kind_gate"[\s\S]*jevModel[\s\S]*codexIncludeUserRules|codexIncludeUserRules/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the route hook's timeout leaves room for the longest classifier wait and two ps calls", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const route = hooks.hooks.PreToolUse.flatMap((entry) => entry.hooks).find((hook) => hook.args.some((arg) => arg.endsWith("route-hook.mjs")));
  // All of these can happen in one dispatch: the classifier, and the writer
  // lock's look at the runner and at Codex. Then the start of Node and the file work.
  const needed = CONFIG_SPEC.jevTimeoutMs.max + 2 * PS_TIMEOUT_MS + 3000;
  assert.ok(route.timeout * 1000 >= needed, `the route hook's timeout (${route.timeout} s) must be at least ${needed / 1000} s`);
  // The loader must not accept a longer wait than the spec says.
  assert.equal(loadConfig({ ORCH_DATA_DIR: "/nonexistent", ORCH_JEV_TIMEOUT_MS: String(CONFIG_SPEC.jevTimeoutMs.max + 1) }).config.jevTimeoutMs, DEFAULTS.jevTimeoutMs);
});

test("the log survives a cut line and truncates long text", () => {
  const tempDir = makeTempDir();
  try {
    const env = { ORCH_DATA_DIR: tempDir };
    assert.equal(appendLog({ event: "one" }, env), true);
    fs.appendFileSync(path.join(tempDir, "dispatch-log.jsonl"), '{"event": "cut in the mid\n');
    appendLog({ event: "two" }, env);
    assert.deepEqual(readLogTail(env).map((record) => record.event), ["one", "two"]);
    assert.equal(truncate("abcdefgh", 3), "abc... [+5 chars]");
    assert.equal(truncate(undefined, 3), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("appendLog reports a write problem and does not throw", () => {
  const tempDir = makeTempDir();
  try {
    const blocker = path.join(tempDir, "a-file");
    fs.writeFileSync(blocker, "");
    assert.equal(appendLog({ event: "x" }, { ORCH_DATA_DIR: path.join(blocker, "below-a-file") }), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the request holds five questions and only the brief", () => {
  const request = buildRequest({ description: "d", prompt: "p" }, { jevModel: "jev-latest" });
  assert.deepEqual(Object.keys(request.questions), ["kind", "writes_files", "self_contained", "difficulty", "needs_every_match"]);
  assert.deepEqual(request.state, { brief: { description: "d", task: "p" } });
  assert.equal(QUESTIONS.kind.criteria.other !== undefined, true);
  assert.equal(QUESTIONS.difficulty.criteria.length, 4);
});

test("readAnswers flattens a good body and rejects a body with a missing field", () => {
  const flat = readAnswers(jevBody({ kind: "debug", confidence: 0.7, difficulty: 2.2 }));
  assert.deepEqual([flat.kind, flat.kindConfidence, flat.difficulty], ["debug", 0.7, 2.2]);
  const broken = jevBody();
  delete broken.answers.self_contained;
  assert.throws(() => readAnswers(broken), (error) => error instanceof JevError && error.code === "bad_response");

  // needs_every_match came after the other four. A reply without it must still
  // be read, with the field as null, so an older Jev cannot break a dispatch.
  const withoutNew = jevBody();
  delete withoutNew.answers.needs_every_match;
  assert.equal(readAnswers(withoutNew).needsEveryMatch, null);
  assert.equal(readAnswers(jevBody({ needsEveryMatch: 0.9 })).needsEveryMatch, 0.9);
});

test("countFindings counts the priority tags", () => {
  assert.deepEqual(countFindings("- [P1] a\n- [P1] b\n- [P3] c\nno tag [P9]"), { P0: 0, P1: 2, P2: 0, P3: 1 });
  assert.deepEqual(countFindings(null), { P0: 0, P1: 0, P2: 0, P3: 0 });
});

test("the log hook writes one record for each of its three events", async () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir);
    const events = [
      {
        hook_event_name: "PostToolUse",
        session_id: "s",
        cwd: "/work/project",
        tool_name: "Agent",
        tool_use_id: "toolu_1",
        tool_input: { subagent_type: "orchestrator:searcher", model: "haiku" },
        tool_response: { status: "async_launched", agentId: "a1", resolvedModel: "claude-haiku-4-5" }
      },
      { hook_event_name: "SubagentStart", session_id: "s", agent_id: "a1", agent_type: "orchestrator:codex-reviewer" },
      {
        hook_event_name: "SubagentStop",
        session_id: "s",
        agent_id: "a1",
        agent_type: "orchestrator:codex-reviewer",
        last_assistant_message: "- [P1] Stop the loop — a.js:4\n- [P2] Empty list — a.js:5"
      },
      { hook_event_name: "SubagentStop", session_id: "s", agent_id: "a2", agent_type: "Explore", last_assistant_message: "private text" },
      // A helper run of Claude Code: empty agent type, no start, no transcript.
      { hook_event_name: "SubagentStop", session_id: "s", agent_id: "a3", agent_type: "", last_assistant_message: "Reading Program.cs" }
    ];
    for (const event of events) {
      const result = await runNode("scripts/log-hook.mjs", { stdin: JSON.stringify(event), env });
      assert.deepEqual([result.code, result.stdout], [0, ""]);
    }
    const records = readLog(tempDir);
    assert.equal(records.length, 4, "a stop with an empty agent type writes no record");
    const [launched, start, stop, otherStop] = records;
    assert.deepEqual([launched.event, launched.resolved_model, launched.agent_id, launched.cwd], ["launched", "claude-haiku-4-5", "a1", "/work/project"]);
    assert.deepEqual([start.event, start.agent_type, start.cwd], ["start", "orchestrator:codex-reviewer", null]);
    assert.deepEqual(stop.findings, { P0: 0, P1: 1, P2: 1, P3: 0 });
    assert.ok(stop.result.includes("Stop the loop"));
    assert.equal(otherStop.result, undefined, "results of other agent types are not stored");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start hook prints the worker list as plain text", async () => {
  const tempDir = makeTempDir();
  try {
    const result = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_MODE: "shadow" }) });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"shadow" mode/);
    assert.match(result.stdout, /orchestrator:codex-reviewer/);
    assert.ok(!result.stdout.trimStart().startsWith("{"), "plain text, not JSON");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the Codex workers never put task text into a shell command", () => {
  for (const name of ["codex-implementer", "codex-reviewer"]) {
    const text = fs.readFileSync(path.join(ROOT, "agents", `${name}.md`), "utf8");
    assert.ok(!text.includes("<<"), `${name} must not use a heredoc`);
    assert.ok(text.includes("codex-request:"), `${name} must start the stored request`);
    assert.match(text, /^omitClaudeMd: true$/m);
    assert.match(text, /^tools: Bash$/m);
  }
});

test("lookup tables have no inherited keys", () => {
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(REDIRECTS[name], undefined);
    assert.equal(DEFAULT_MODEL[name], undefined);
    assert.equal(CLAUDE_FALLBACK[name], undefined);
  }
});

test("the log hook works from a plugin path with a space", async () => {
  const tempDir = makeTempDir();
  try {
    const copy = path.join(tempDir, "plug in röot");
    fs.cpSync(path.join(ROOT, "scripts"), path.join(copy, "scripts"), { recursive: true });
    const env = cleanEnv(tempDir);
    const event = { hook_event_name: "SubagentStart", session_id: "s", agent_id: "a1", agent_type: "Explore" };
    const child = await import("node:child_process");
    const result = child.spawnSync(process.execPath, [path.join(copy, "scripts", "log-hook.mjs")], { input: JSON.stringify(event), env, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(readLog(tempDir).length, 1, "the hook must write its record from any path");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the author of a change is the last worker that really wrote files", () => {
  const tempDir = makeTempDir();
  try {
    const env = { ORCH_DATA_DIR: tempDir };
    assert.equal(lastWriterFamily("s1", env), null);

    // Claude writes, then a Codex attempt fails without a change.
    recordWriterDispatch("s1", "t1", WORKERS.implementer, env);
    recordWriterLaunch("s1", "t1", WORKERS.implementer, "a1", env);
    recordWriterStop("s1", WORKERS.implementer, "a1", reportsNoWrite("Changed files: src/a.js\nVerification: ok"), env);
    recordWriterDispatch("s1", "t2", WORKERS.codexImplementer, env);
    recordWriterLaunch("s1", "t2", WORKERS.codexImplementer, "a2", env);
    recordWriterStop("s1", WORKERS.codexImplementer, "a2", reportsNoWrite("CODEX_FAILED 2026 exit=1"), env);
    assert.equal(lastWriterFamily("s1", env), "claude");

    // A Codex job that is still running counts as the author.
    recordWriterDispatch("s1", "t3", WORKERS.codexImplementer, env);
    assert.equal(lastWriterFamily("s1", env), "codex");

    // Other sessions and workers that do not write are ignored.
    recordWriterDispatch("s1", "t4", WORKERS.searcher, env);
    recordWriterDispatch("s2", "t5", WORKERS.implementer, env);
    assert.equal(lastWriterFamily("s1", env), "codex");
    assert.equal(lastWriterFamily("s2", env), "claude");

    // Long prompts in the big log cannot push the author out of this small index.
    for (let index = 0; index < 40; index += 1) {
      appendLog({ event: "dispatch", session_id: "s1", prompt: "x".repeat(20000) }, env);
    }
    assert.equal(lastWriterFamily("s1", env), "codex");
    assert.equal(reportsNoWrite("Changed files: none\nVerification: read only"), true);
    // A cancelled job may have changed files already, so it keeps its author.
    assert.equal(reportsNoWrite("CODEX_CANCELLED 20260923-101500-0a1b2c\nThe job was stopped. Files that Codex had already changed stay changed."), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the limits file reports why it has no value", () => {
  const tempDir = makeTempDir();
  try {
    const file = path.join(tempDir, "limits.json");
    const env = { ORCH_LIMITS_FILE: file };
    const now = Date.now();
    assert.equal(readLimitsState(DEFAULTS, env, now).state, "missing");
    fs.writeFileSync(file, "{broken");
    assert.equal(readLimitsState(DEFAULTS, env, now).state, "damaged");
    fs.writeFileSync(file, JSON.stringify({ ts: Math.floor(now / 1000) - 7200, five_hour: 50 }));
    assert.equal(readLimitsState(DEFAULTS, env, now).state, "old");
    fs.writeFileSync(file, JSON.stringify({ ts: Math.floor(now / 1000), five_hour: 50, seven_day: 61.5 }));
    assert.deepEqual([readLimitsState(DEFAULTS, env, now).fiveHour, readLimitsState(DEFAULTS, env, now).sevenDay], [50, 61.5]);
    // A sample from the older snippet has no reset times and no session.
    assert.deepEqual([readLimitsState(DEFAULTS, env, now).fiveHourResetsAt, readLimitsState(DEFAULTS, env, now).sessionId], [null, null]);

    // The reset times and the sample time come back in milliseconds. A reset time that is not a number is null.
    const sampled = Math.floor(now / 1000);
    fs.writeFileSync(file, JSON.stringify({ ts: sampled, five_hour: 50, seven_day: 61.5, five_hour_resets_at: sampled + 3600, seven_day_resets_at: "soon", session_id: "s-1" }));
    const withResets = readLimitsState(DEFAULTS, env, now);
    assert.deepEqual([withResets.fiveHourResetsAt, withResets.sevenDayResetsAt, withResets.sampledAt, withResets.sessionId], [(sampled + 3600) * 1000, null, sampled * 1000, "s-1"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("firstNotice shows each notice once per session, and keeps sessions and notices apart", () => {
  const tempDir = makeTempDir();
  try {
    const env = { ORCH_DATA_DIR: tempDir };
    assert.equal(firstNotice("s1", "codex_unavailable", env), true);
    assert.equal(firstNotice("s1", "codex_unavailable", env), false, "the same session is told once");
    assert.equal(firstNotice("s1", "claude_tight", env), true, "another notice is told too");
    assert.equal(firstNotice("s2", "codex_unavailable", env), true, "another session is told too");
    // Without a session id there is nothing to remember, so the notice is always shown.
    assert.equal(firstNotice(null, "codex_unavailable", env), true);
    assert.equal(firstNotice(null, "codex_unavailable", env), true);
    // A session id with a path in it stays inside the folder.
    assert.equal(firstNotice("../../x", "claude_tight", env), true);
    assert.equal(firstNotice("../../x", "claude_tight", env), false);
    assert.deepEqual(fs.readdirSync(tempDir), ["notices"]);
    assert.equal(fs.readdirSync(path.join(tempDir, "notices")).length, 4);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("hooks that ask at the same moment show a notice exactly once, and keep each other's marks", async () => {
  const tempDir = makeTempDir();
  try {
    const go = path.join(tempDir, "go");
    const moduleUrl = pathToFileURL(path.join(ROOT, "scripts", "lib", "provider-state.mjs")).href;
    // Each child waits for the file "go", so all of them ask in the same moment.
    const script = `
      import fs from "node:fs";
      import { firstNotice } from ${JSON.stringify(moduleUrl)};
      while (!fs.existsSync(${JSON.stringify(go)})) {}
      process.stdout.write(String(firstNotice("s1", process.argv[1])));
    `;
    const keys = [...Array(6).fill("codex_unavailable"), ...Array(6).fill("claude_tight")];
    const children = keys.map((key) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, key], { env: { ...process.env, ORCH_DATA_DIR: path.join(tempDir, "data") } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      return new Promise((resolve) => child.on("close", () => resolve({ key, out })));
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    fs.writeFileSync(go, "");
    const results = await Promise.all(children);
    for (const key of ["codex_unavailable", "claude_tight"]) {
      const shown = results.filter((result) => result.key === key && result.out === "true").length;
      const quiet = results.filter((result) => result.key === key && result.out === "false").length;
      assert.deepEqual({ shown, quiet }, { shown: 1, quiet: 5 }, key);
    }
    // Both marks are kept, so neither notice comes back later in the session.
    assert.equal(firstNotice("s1", "codex_unavailable", { ORCH_DATA_DIR: path.join(tempDir, "data") }), false);
    assert.equal(firstNotice("s1", "claude_tight", { ORCH_DATA_DIR: path.join(tempDir, "data") }), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("firstNotice shows the notice and reports on stderr when it cannot save the mark", () => {
  const tempDir = makeTempDir();
  const reports = [];
  const writeStderr = process.stderr.write;
  process.stderr.write = (text) => {
    reports.push(String(text));
    return true;
  };
  try {
    const env = { ORCH_DATA_DIR: tempDir };
    // A file where the folder should be.
    fs.writeFileSync(path.join(tempDir, "notices"), "");
    assert.equal(firstNotice("s1", "codex_unavailable", env), true);
    assert.equal(firstNotice("s1", "codex_unavailable", env), true, "without a mark the notice shows again");
    assert.equal(reports.length, 2);
    assert.match(reports[0], /cannot save the notice state/);
  } finally {
    process.stderr.write = writeStderr;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("marks older than 14 days are removed when a new notice is shown", () => {
  const tempDir = makeTempDir();
  try {
    const env = { ORCH_DATA_DIR: tempDir };
    const dir = path.join(tempDir, "notices");
    assert.equal(firstNotice("old", "claude_tight", env), true);
    assert.equal(firstNotice("recent", "claude_tight", env), true);
    const marks = fs.readdirSync(dir);
    // Age one mark by 15 days and one by 13 days.
    const day = 24 * 60 * 60;
    const now = Date.now() / 1000;
    const oldName = marks.find((name) => name.startsWith(createHash("sha256").update("old").digest("hex").slice(0, 32)));
    const recentName = marks.find((name) => name !== oldName);
    assert.ok(oldName && recentName);
    fs.utimesSync(path.join(dir, oldName), now - 15 * day, now - 15 * day);
    fs.utimesSync(path.join(dir, recentName), now - 13 * day, now - 13 * day);
    assert.equal(firstNotice("new", "claude_tight", env), true);
    const left = fs.readdirSync(dir);
    assert.ok(!left.includes(oldName), "the 15-day-old mark is gone");
    assert.ok(left.includes(recentName), "the 13-day-old mark stays");
    assert.equal(left.length, 2);
    assert.equal(firstNotice("recent", "claude_tight", env), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start hook tells the user when a subscription has no room", async () => {
  const tempDir = makeTempDir();
  try {
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "codex-limits.json"), JSON.stringify({ usedPercent: 100, resetsAt: Date.now() + 3600 * 1000, ts: Date.now() }));
    const result = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir) });
    const output = JSON.parse(result.stdout);
    assert.match(output.systemMessage, /^Orchestrator: The weekly Codex allowance/);
    assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(output.hookSpecificOutput.additionalContext, /orchestrator:searcher[\s\S]*State of the subscriptions right now/);

    // In shadow mode the hook changes nothing, so there is nothing to announce.
    const shadow = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_MODE: "shadow" }) });
    assert.ok(!shadow.stdout.trimStart().startsWith("{"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start hook fails open: an error inside it gives exit 0, a line on stderr and a hook_error record", async () => {
  const tempDir = makeTempDir();
  try {
    // Loaded before the hook: the first write to stdout throws, which no function of the hook catches itself.
    const preload = path.join(tempDir, "break-stdout.mjs");
    fs.writeFileSync(preload, 'process.stdout.write = () => { throw new Error("stdout is gone"); };\n');
    const env = cleanEnv(tempDir, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` });
    const result = await runNode("scripts/session-start.mjs", { env, stdin: JSON.stringify({ session_id: "s1", cwd: tempDir, source: "startup" }) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /orchestrator session start hook failed: stdout is gone/);
    const errors = readLog(tempDir).filter((record) => record.event === "hook_error");
    assert.deepEqual(errors.map((record) => [record.hook, record.error]), [["session-start", "stdout is gone"]]);
    // The work before the failure still happened.
    assert.equal(readLog(tempDir).filter((record) => record.event === "session").length, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start hook names every worker in agents/, each Claude worker with the model of its file", async () => {
  const tempDir = makeTempDir();
  try {
    const result = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir) });
    assert.equal(result.code, 0);
    const agentsDir = path.join(ROOT, "agents");
    const files = fs.readdirSync(agentsDir).filter((file) => file.endsWith(".md"));
    assert.ok(files.length >= 7, "the plugin has at least seven workers");
    for (const file of files) {
      const text = fs.readFileSync(path.join(agentsDir, file), "utf8");
      const name = text.match(/^name: (.+)$/m)[1].trim();
      const model = text.match(/^model: (.+)$/m)[1].trim();
      assert.ok(result.stdout.includes(`orchestrator:${name}`), `the session start names orchestrator:${name}`);
      if (!name.startsWith("codex-")) {
        // The two Codex workers are thin Haiku wrappers; the model that matters for them is Codex.
        assert.ok(result.stdout.includes(`orchestrator:${name} (${model})`), `orchestrator:${name} is listed with ${model}`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex is off unless config.json or ORCH_CODEX_ENABLED turns it on", () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ORCH_DATA_DIR: dataDir };
    assert.equal(loadConfig(env).config.codexEnabled, false, "opt-in: off without a config file");

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ codexEnabled: true }));
    assert.equal(loadConfig(env).config.codexEnabled, true);
    assert.equal(loadConfig({ ...env, ORCH_CODEX_ENABLED: "0" }).config.codexEnabled, false, "the variable wins over the file");

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ codexEnabled: "yes" }));
    const wrongType = loadConfig(env);
    assert.equal(wrongType.config.codexEnabled, false);
    assert.match(wrongType.warnings.join("\n"), /codexEnabled must be true or false/);

    const wrongVariable = loadConfig({ ...env, ORCH_CODEX_ENABLED: "on" });
    assert.equal(wrongVariable.config.codexEnabled, false);
    assert.match(wrongVariable.warnings.join("\n"), /ORCH_CODEX_ENABLED must be 1, 0, true or false/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("with Codex off, the session start names the Codex workers as off and sends no notice", async () => {
  const tempDir = makeTempDir();
  try {
    // Used-up numbers must not produce a notice about capacity while Codex is off.
    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "codex-limits.json"), JSON.stringify({ usedPercent: 100, resetsAt: Date.now() + 3600 * 1000, ts: Date.now() }));
    const result = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "" }) });
    assert.equal(result.code, 0);
    assert.ok(!result.stdout.trimStart().startsWith("{"), "plain text, so no notice for the user");
    assert.match(result.stdout, /orchestrator:codex-reviewer: off\. Codex is opt-in/);
    assert.match(result.stdout, /hook sends no task to Codex/);
    assert.ok(!result.stdout.includes("Codex reviews changes from Claude workers"));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the model routing of other agent types is on by default, and the file or ORCH_ROUTE_OTHER_AGENTS turns it off", () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ORCH_DATA_DIR: dataDir };
    assert.deepEqual([loadConfig(env).config.routeOtherAgents, loadConfig(env).config.keepModelAgents], [true, []]);

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ routeOtherAgents: false, keepModelAgents: ["spec-compliance-reviewer", "pr-review-toolkit:code-reviewer"] }));
    const fromFile = loadConfig(env);
    assert.equal(fromFile.config.routeOtherAgents, false);
    assert.deepEqual(fromFile.config.keepModelAgents, ["spec-compliance-reviewer", "pr-review-toolkit:code-reviewer"]);
    assert.deepEqual(fromFile.warnings, []);
    assert.equal(loadConfig({ ...env, ORCH_ROUTE_OTHER_AGENTS: "1" }).config.routeOtherAgents, true, "the variable wins over the file");

    // A list that is not a list of names is reported, and then no agent type is on the list.
    for (const bad of ["spec-compliance-reviewer", ["ok", 7], ["ok", ""], { name: "ok" }]) {
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ keepModelAgents: bad, routeOtherAgents: "no" }));
      const wrong = loadConfig(env);
      assert.deepEqual(wrong.config.keepModelAgents, [], JSON.stringify(bad));
      assert.equal(wrong.config.routeOtherAgents, true);
      assert.match(wrong.warnings.join("\n"), /routeOtherAgents must be true or false[\s\S]*keepModelAgents must be a list of agent type names/);
    }

    const wrongVariable = loadConfig({ ORCH_DATA_DIR: path.join(tempDir, "empty"), ORCH_ROUTE_OTHER_AGENTS: "off" });
    assert.equal(wrongVariable.config.routeOtherAgents, true);
    assert.match(wrongVariable.warnings.join("\n"), /ORCH_ROUTE_OTHER_AGENTS must be 1, 0, true or false/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("readRouteLine finds the line orch-route: keep only as a line of its own", () => {
  const cases = [
    ["orch-route: keep", true, null],
    ["Goal: retry.\n\t Orch-Route:   KEEP \nVerify: npm test", true, null],
    ["Goal: retry.\r\norch-route: keep\r\nVerify: npm test", true, null],
    ["Goal: do not write orch-route: keep into the file.", false, null],
    ["Goal: retry.", false, null],
    ["orch-route: keep it simple", false, /orch-route has "keep it simple"/],
    ["orch-route:", false, /orch-route has ""/],
    [`orch-route: ${"x".repeat(60)}`, false, /orch-route has "x{40}", which/]
  ];
  for (const [prompt, keep, warning] of cases) {
    const result = readRouteLine(prompt);
    assert.equal(result.keep, keep, prompt);
    if (warning) {
      assert.match(result.warning, warning);
    } else {
      assert.equal(result.warning, null, prompt);
    }
  }
  for (const notText of [undefined, null, 7, { prompt: "orch-route: keep" }]) {
    assert.deepEqual(readRouteLine(notText), { keep: false, warning: null });
  }
});

test("the session start names the model routing of other agent types only while it is on", async () => {
  const tempDir = makeTempDir();
  try {
    const on = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir) });
    assert.match(on.stdout, /For every other agent type, the hook can change only the model/);
    assert.match(on.stdout, /orch-route: keep/);

    const off = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_ROUTE_OTHER_AGENTS: "0" }) });
    assert.ok(!off.stdout.includes("For every other agent type"));
    assert.match(off.stdout, /Dispatches to other agent types pass unchanged, because `routeOtherAgents` is false/);
    assert.match(off.stdout, /orch-route: keep/, "the line still works for our own workers");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("at a high Claude usage the session start names the switch that the hook will really make", async () => {
  const tempDir = makeTempDir();
  try {
    const limitsFile = path.join(tempDir, "limits-latest.json");
    fs.writeFileSync(limitsFile, JSON.stringify({ ts: Math.floor(Date.now() / 1000), five_hour: 91, seven_day: 40 }));

    const codexOff = JSON.parse((await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "", ORCH_LIMITS_FILE: limitsFile }) })).stdout);
    assert.match(codexOff.systemMessage, /Claude usage is at 91% of the 5-hour window and 40% of the 7-day window\. Codex cannot take work, so tasks that would run on Opus now run on Sonnet/);
    assert.ok(!codexOff.systemMessage.includes("now run on Codex"));

    const codexOn = JSON.parse((await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_LIMITS_FILE: limitsFile }) })).stdout);
    assert.match(codexOn.systemMessage, /Tasks with a complete brief now run on Codex/);
    assert.ok(!codexOn.systemMessage.includes("Opus"));

    // With Jev off nothing moves, so the start promises no switch and says why.
    const jevOff = await runNode("scripts/session-start.mjs", { env: cleanEnv(tempDir, { ORCH_JEV_ENABLED: "", ORCH_LIMITS_FILE: limitsFile }) });
    assert.ok(!jevOff.stdout.includes("systemMessage"), jevOff.stdout);
    assert.match(jevOff.stdout, /Routing is off, because `jevEnabled` is not true/);
    assert.ok(!jevOff.stdout.includes("now run on"), "a switch that will not happen was promised");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the dispatch log and its folder are private, also when older ones were wider", () => {
  const tempDir = makeTempDir();
  try {
    const data = path.join(tempDir, "data");
    const env = { ORCH_DATA_DIR: data };
    const mode = (file) => fs.statSync(file).mode & 0o777;
    assert.equal(appendLog({ event: "one" }, env), true);
    assert.equal(mode(data), 0o700);
    assert.equal(mode(path.join(data, "dispatch-log.jsonl")), 0o600);

    // A folder and a file from before this rule are tightened on the next write.
    fs.chmodSync(data, 0o755);
    fs.chmodSync(path.join(data, "dispatch-log.jsonl"), 0o644);
    appendLog({ event: "two" }, env);
    assert.equal(mode(data), 0o700);
    assert.equal(mode(path.join(data, "dispatch-log.jsonl")), 0o600);

    recordWriterDispatch("s", "t", WORKERS.implementer, env);
    assert.equal(mode(path.join(data, "writers.jsonl")), 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the dispatch log rotates once at the size limit and keeps one older file", () => {
  const tempDir = makeTempDir();
  try {
    const big = "x".repeat(600);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 1, big })}\n`);
    // Four records fit. The fifth append finds the file at the limit and rotates it first.
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: String(3 * lineBytes + 10) };
    const older = () => (fs.existsSync(rotatedLogFile(env)) ? fs.readFileSync(rotatedLogFile(env), "utf8").trim().split("\n").map((line) => JSON.parse(line).n) : null);
    const current = () => readLogTail(env).map((record) => record.n);

    for (let n = 1; n <= 4; n += 1) {
      appendLog({ n, big }, env);
    }
    assert.deepEqual([current(), older()], [[1, 2, 3, 4], null]);
    appendLog({ n: 5, big }, env);
    assert.deepEqual([current(), older()], [[5], [1, 2, 3, 4]]);
    for (let n = 6; n <= 9; n += 1) {
      appendLog({ n, big }, env);
    }
    // The second rotation replaces the older file, so the log takes at most two files.
    assert.deepEqual([current(), older()], [[9], [5, 6, 7, 8]]);
    assert.deepEqual(fs.readdirSync(path.join(tempDir, "data")).sort(), ["dispatch-log.1.jsonl", "dispatch-log.jsonl"]);
    assert.equal(fs.statSync(rotatedLogFile(env)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a rotation that fails still appends the record, and says why on stderr", () => {
  const tempDir = makeTempDir();
  const stderr = mock.method(process.stderr, "write", () => true);
  try {
    const big = "x".repeat(600);
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: "1024" };
    appendLog({ n: 1, big }, env);
    appendLog({ n: 2, big }, env);
    // A folder with content where the older file should be: the rename that
    // rotates the log fails, and keeps failing until someone removes the folder.
    fs.mkdirSync(path.join(rotatedLogFile(env), "blocker"), { recursive: true });

    assert.equal(appendLog({ n: 3, big }, env), true, "the record is written");
    assert.equal(appendLog({ n: 4, big }, env), true);
    assert.deepEqual(readLogTail(env).map((record) => record.n), [1, 2, 3, 4], "no record is lost while the rotation fails");
    const messages = stderr.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(messages.filter((text) => text.startsWith("orchestrator: cannot rotate the dispatch log:")).length, 2, messages.join(""));

    // Once the obstacle is gone, the next append rotates as usual.
    fs.rmSync(rotatedLogFile(env), { recursive: true });
    appendLog({ n: 5, big }, env);
    assert.deepEqual(readLogTail(env).map((record) => record.n), [5]);
  } finally {
    stderr.mock.restore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("logMaxBytes reads the variable and falls back to the default for a bad value", () => {
  const byDefault = 25 * 1024 * 1024;
  assert.equal(logMaxBytes({}), byDefault);
  assert.equal(logMaxBytes({ ORCH_LOG_MAX_BYTES: "" }), byDefault);
  assert.equal(logMaxBytes({ ORCH_LOG_MAX_BYTES: "4096" }), 4096);
  assert.equal(logMaxBytes({ ORCH_LOG_MAX_BYTES: "4096.7" }), 4096);
  for (const bad of ["abc", "10", "-5", "0"]) {
    assert.equal(logMaxBytes({ ORCH_LOG_MAX_BYTES: bad }), byDefault, bad);
  }
});

test("a rotation decided on an old size does not replace the fresh archive", () => {
  // The race: hooks A and B both see the log at its limit. A rotates and starts
  // the file anew. B, slower, must not rename the new small file over A's archive.
  // The stand-in for statSync gives B the old size on its first look, as the
  // real race would; every other call is real.
  const tempDir = makeTempDir();
  try {
    const big = "x".repeat(600);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 1, big })}\n`);
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: String(3 * lineBytes + 10) };
    const archive = () => fs.readFileSync(rotatedLogFile(env), "utf8").trim().split("\n").map((line) => JSON.parse(line).n);
    for (let n = 1; n <= 4; n += 1) {
      appendLog({ n, big }, env);
    }
    // A rotates: records 1 to 4 go to the archive, and record 5 starts the new file.
    appendLog({ n: 5, big }, env);
    assert.deepEqual(archive(), [1, 2, 3, 4]);

    const realStat = fs.statSync;
    let firstLook = true;
    const stat = mock.method(fs, "statSync", (target, ...rest) => {
      const result = realStat(target, ...rest);
      if (firstLook && target === logFile(env)) {
        firstLook = false;
        result.size = 4 * lineBytes;
      }
      return result;
    });
    try {
      assert.equal(appendLog({ n: 6, big }, env), true);
    } finally {
      stat.mock.restore();
    }
    assert.deepEqual(archive(), [1, 2, 3, 4], "the archive of A is untouched");
    assert.deepEqual(readLogTail(env).map((record) => record.n), [5, 6], "the record of B went into the current file");
    assert.ok(!fs.existsSync(`${logFile(env)}.rotate.lock`), "the lock is given back");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a rotation lock that another hook holds skips the rotation, and a stale one is removed", () => {
  const tempDir = makeTempDir();
  try {
    const big = "x".repeat(600);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 1, big })}\n`);
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: String(3 * lineBytes + 10) };
    const lock = `${logFile(env)}.rotate.lock`;
    for (let n = 1; n <= 4; n += 1) {
      appendLog({ n, big }, env);
    }

    // Another hook holds the lock right now: no rotation, and the record is not lost.
    fs.writeFileSync(lock, "");
    assert.equal(appendLog({ n: 5, big }, env), true);
    assert.equal(fs.existsSync(rotatedLogFile(env)), false, "no rotation while another hook rotates");
    assert.deepEqual(readLogTail(env).map((record) => record.n), [1, 2, 3, 4, 5]);
    assert.ok(fs.existsSync(lock), "the lock of the other hook stays");

    // A lock from a hook that died is removed, and the next append rotates.
    const old = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(appendLog({ n: 6, big }, env), true);
    assert.equal(fs.existsSync(lock), false, "the stale lock is gone");
    assert.equal(fs.existsSync(rotatedLogFile(env)), false, "this append still did not rotate");
    assert.equal(appendLog({ n: 7, big }, env), true);
    assert.deepEqual(fs.readFileSync(rotatedLogFile(env), "utf8").trim().split("\n").map((line) => JSON.parse(line).n), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(readLogTail(env).map((record) => record.n), [7]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a hook that judged a rotation lock stale does not remove the fresh lock that another hook took in that moment", () => {
  const tempDir = makeTempDir();
  try {
    const big = "x".repeat(600);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 1, big })}\n`);
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: String(3 * lineBytes + 10) };
    const lock = `${logFile(env)}.rotate.lock`;
    for (let n = 1; n <= 4; n += 1) {
      appendLog({ n, big }, env);
    }
    // A hook died while it held the lock.
    fs.writeFileSync(lock, "dead");
    const old = new Date(Date.now() - 2 * 60 * 1000);
    fs.utimesSync(lock, old, old);

    // Hook B reads the age of the dead lock. In that moment another hook removes
    // it, and hook C takes a fresh one and is rotating now. Every call is real;
    // only the moment is chosen.
    const realStat = fs.statSync;
    let played = false;
    const stat = mock.method(fs, "statSync", (target, ...rest) => {
      const result = realStat(target, ...rest);
      if (!played && target === lock) {
        played = true;
        fs.unlinkSync(lock);
        fs.writeFileSync(lock, "C");
      }
      return result;
    });
    try {
      assert.equal(appendLog({ n: 5, big }, env), true);
    } finally {
      stat.mock.restore();
    }
    assert.ok(played, "the race was really played");
    // Before the fix B removed C's lock, so a fourth hook could rotate beside C.
    assert.equal(fs.readFileSync(lock, "utf8"), "C", "C's fresh lock stays");
    assert.ok(!fs.existsSync(`${lock}.break`), "the breaker is given back");
    assert.equal(fs.existsSync(rotatedLogFile(env)), false, "B does not rotate while C holds the lock");
    assert.deepEqual(readLogTail(env).map((record) => record.n), [1, 2, 3, 4, 5], "B's record is not lost");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a breaker left by a hook that died is removed after a minute, and the stale lock after it", () => {
  const tempDir = makeTempDir();
  try {
    const big = "x".repeat(600);
    const lineBytes = Buffer.byteLength(`${JSON.stringify({ n: 1, big })}\n`);
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: String(3 * lineBytes + 10) };
    const lock = `${logFile(env)}.rotate.lock`;
    for (let n = 1; n <= 4; n += 1) {
      appendLog({ n, big }, env);
    }
    const old = new Date(Date.now() - 2 * 60 * 1000);
    fs.writeFileSync(lock, "dead");
    fs.utimesSync(lock, old, old);

    // A young breaker: another hook is removing the stale lock now, so this one waits.
    fs.writeFileSync(`${lock}.break`, "");
    appendLog({ n: 5, big }, env);
    assert.ok(fs.existsSync(lock), "the stale lock waits for the hook that holds the breaker");
    assert.ok(fs.existsSync(`${lock}.break`));

    // The breaker is old: its hook died. It is removed, then the stale lock, then the log rotates.
    fs.utimesSync(`${lock}.break`, old, old);
    appendLog({ n: 6, big }, env);
    assert.ok(!fs.existsSync(`${lock}.break`), "the dead breaker is gone");
    appendLog({ n: 7, big }, env);
    assert.ok(!fs.existsSync(lock), "the stale lock is gone");
    appendLog({ n: 8, big }, env);
    assert.deepEqual(readLogTail(env).map((record) => record.n), [8], "the log rotated");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a window is tight at the gate, or on pace to run out before its reset", () => {
  const sampledAt = 1790000000000;
  const window = (used, elapsedShare, lengthMs = FIVE_HOURS_MS) => ({ used, resetsAt: sampledAt + lengthMs * (1 - elapsedShare), sampledAt, lengthMs });

  // At the gate the percentage alone decides, and no projection is made.
  assert.deepEqual(windowVerdict(window(80, 0.01), DEFAULTS), { tight: true, reason: "gate", projected: null, elapsedShare: null });
  assert.deepEqual(windowVerdict(window(100, 0.99), DEFAULTS), { tight: true, reason: "gate", projected: null, elapsedShare: null });

  // 50 percent used after half of the window projects to exactly 100: tight by pace.
  assert.deepEqual(windowVerdict(window(50, 0.5), DEFAULTS), { tight: true, reason: "pace", projected: 100, elapsedShare: 0.5 });
  // 40 percent used after half of the window projects to 80: never runs out, so not tight.
  assert.deepEqual(windowVerdict(window(40, 0.5), DEFAULTS), { tight: false, reason: null, projected: 80, elapsedShare: 0.5 });
  // The projection aims at 100, not at the gate: 42 percent after half projects to 84.
  assert.equal(windowVerdict(window(42, 0.5), DEFAULTS).tight, false);

  // Early in the window a projection is noise. 3 percent after two minutes projects to 450 and is not tight.
  const twoMinutes = (2 * 60 * 1000) / FIVE_HOURS_MS;
  assert.deepEqual([windowVerdict(window(3, twoMinutes), DEFAULTS).tight, windowVerdict(window(3, twoMinutes), DEFAULTS).projected], [false, 450]);
  // paceAfter is 0.2: the same speed counts from 20 percent of the window on, and not just before.
  assert.equal(windowVerdict(window(20, 0.2), DEFAULTS).tight, true);
  assert.equal(windowVerdict(window(19.9, 0.199), DEFAULTS).tight, false);
  assert.equal(windowVerdict(window(19, 0.2), DEFAULTS).tight, false, "at 20 percent of the window, 19 percent used projects to 95");
  // A higher paceAfter waits longer.
  assert.equal(windowVerdict(window(50, 0.5), { ...DEFAULTS, paceAfter: 0.6 }).tight, false);

  // The 7-day window uses its own length.
  const afterTwoDays = 2 / 7;
  assert.deepEqual(windowVerdict(window(30, afterTwoDays, SEVEN_DAYS_MS), DEFAULTS), { tight: true, reason: "pace", projected: 105, elapsedShare: 0.286 });

  // Unknown stays unknown: no percentage, no reset time, a reset time in the past,
  // an elapsed time outside the window, or a sample time that is not a number.
  const none = { tight: false, reason: null, projected: null, elapsedShare: null };
  assert.deepEqual(windowVerdict({ used: null, ...window(50, 0.5), used: null }, DEFAULTS), none);
  assert.deepEqual(windowVerdict({ ...window(50, 0.5), resetsAt: null }, DEFAULTS), none);
  assert.deepEqual(windowVerdict({ ...window(50, 0.5), resetsAt: sampledAt - 1000 }, DEFAULTS), none, "a reset in the past");
  assert.deepEqual(windowVerdict(window(50, -0.1), DEFAULTS), none, "a reset further away than one window");
  assert.deepEqual(windowVerdict({ ...window(50, 0.5), sampledAt: NaN }, DEFAULTS), none);
  assert.deepEqual(windowVerdict({ ...window(50, 0.5), sampledAt: "now" }, DEFAULTS), none);
  // At the very end of the window the projection is the percentage itself.
  assert.deepEqual(windowVerdict(window(50, 1), DEFAULTS).projected, 50);

  // The switch turns the pace part off, and the gate still counts.
  const off = { ...DEFAULTS, pacing: false };
  assert.deepEqual(windowVerdict(window(50, 0.5), off), none);
  assert.equal(windowVerdict(window(80, 0.5), off).reason, "gate");
});

test("claudeState reads both windows, names the reason, and the notices say when the pace made Claude tight", () => {
  const tempDir = makeTempDir();
  try {
    const file = path.join(tempDir, "limits.json");
    const env = { ORCH_LIMITS_FILE: file };
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    const state = () => claudeState(DEFAULTS, env, now);

    // No file: nothing is known, and nothing is tight.
    assert.deepEqual([state().tight, state().tightReason, state().windows.fiveHour.projected], [false, null, null]);

    // The older snippet: percentages without reset times. Only the gate can decide.
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 50, seven_day: 30 }));
    assert.deepEqual([state().tight, state().tightReason], [false, null]);
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 85, seven_day: 30 }));
    assert.deepEqual([state().tight, state().tightReason, state().windows.fiveHour.reason], [true, "gate", "gate"]);
    assert.equal(claudeNotice(state()), "Claude usage is at 85% of the 5-hour window and 30% of the 7-day window. Tasks with a complete brief now run on Codex, to save the Claude limit.");

    // The current snippet: 50 percent of the 5-hour window used, with 2.5 hours to the reset. On pace for 100.
    const fiveHourReset = ts + Math.round(FIVE_HOURS_MS / 2000);
    const sevenDayReset = ts + Math.round((SEVEN_DAYS_MS * 0.9) / 1000);
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 50, seven_day: 5, five_hour_resets_at: fiveHourReset, seven_day_resets_at: sevenDayReset, session_id: "s" }));
    const paced = state();
    assert.deepEqual([paced.tight, paced.tightReason, paced.windows.fiveHour.reason, paced.windows.sevenDay.reason], [true, "pace", "pace", null]);
    assert.equal(paced.windows.fiveHour.projected, 100);
    assert.equal(paced.fiveHourResetsAt, fiveHourReset * 1000);
    assert.match(claudeNotice(paced), /^Claude usage is at 50% of the 5-hour window and 5% of the 7-day window\. At this pace the 5-hour window runs out before it resets at .+ \(about 100% by then\)\. Tasks with a complete brief now run on Codex/);
    assert.match(claudeCapNotice(paced), /At this pace the 5-hour window runs out before it resets at .+\. Codex cannot take work, so tasks that would run on Opus now run on Sonnet/);

    // The 7-day window alone can make Claude tight by pace, and the notice names it.
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 5, seven_day: 40, five_hour_resets_at: fiveHourReset, seven_day_resets_at: ts + Math.round((SEVEN_DAYS_MS * 0.7) / 1000), session_id: "s" }));
    const weekly = state();
    assert.deepEqual([weekly.tight, weekly.tightReason, weekly.windows.sevenDay.projected], [true, "pace", 133]);
    assert.match(claudeNotice(weekly), /At this pace the 7-day window runs out/);

    // At the gate in one window and on pace in the other, the reason is the gate.
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 50, seven_day: 90, five_hour_resets_at: fiveHourReset, seven_day_resets_at: sevenDayReset, session_id: "s" }));
    assert.deepEqual([state().tightReason, state().windows.fiveHour.reason, state().windows.sevenDay.reason], ["gate", "pace", "gate"]);
    assert.ok(!claudeNotice(state()).includes("At this pace"), "the notice for the gate says nothing about the pace");

    // Below the gate and on pace for less than 100: not tight, but the projection is there for the log.
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 30, seven_day: 5, five_hour_resets_at: fiveHourReset, seven_day_resets_at: sevenDayReset, session_id: "s" }));
    assert.deepEqual([state().tight, state().windows.fiveHour.projected], [false, 60]);

    // An old sample is unknown, also with reset times in it.
    fs.writeFileSync(file, JSON.stringify({ ts: ts - 3600, five_hour: 50, seven_day: 5, five_hour_resets_at: fiveHourReset, seven_day_resets_at: sevenDayReset }));
    assert.deepEqual([state().limits.state, state().tight, state().fiveHourResetsAt], ["old", false, null]);

    // The switch off: only the gate counts.
    fs.writeFileSync(file, JSON.stringify({ ts, five_hour: 50, seven_day: 5, five_hour_resets_at: fiveHourReset, seven_day_resets_at: sevenDayReset }));
    assert.equal(claudeState({ ...DEFAULTS, pacing: false }, env, now).tight, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the pace settings are read from config.json and bad values fall back with a warning", () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const env = { ORCH_DATA_DIR: dataDir };
    assert.deepEqual([loadConfig(env).config.pacing, loadConfig(env).config.paceAfter], [true, 0.2]);

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ pacing: false, paceAfter: 0.5 }));
    const set = loadConfig(env);
    assert.deepEqual([set.config.pacing, set.config.paceAfter, set.warnings], [false, 0.5, []]);

    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ pacing: "no", paceAfter: 2 }));
    const bad = loadConfig(env);
    assert.deepEqual([bad.config.pacing, bad.config.paceAfter], [true, 0.2]);
    assert.match(bad.warnings.join("\n"), /pacing must be true or false[\s\S]*paceAfter must be a number from 0 to 1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start hook writes a session record with the project and the configuration in force, and none without hook input", async () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir, { ORCH_MODE: "shadow" });
    const input = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-9", cwd: "/work/project", source: "resume", transcript_path: "/x" });
    const result = await runNode("scripts/session-start.mjs", { stdin: input, env });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /"shadow" mode/, "the facts are printed as before");
    const [record] = readLog(tempDir);
    assert.equal(record.event, "session");
    assert.deepEqual([record.session_id, record.cwd, record.source, record.mode], ["s-9", "/work/project", "resume", "shadow"]);
    assert.deepEqual([record.config.codexEnabled, record.config.limitGate, record.config.keepModelAgents, record.config.pacing, record.config.paceAfter], [true, DEFAULTS.limitGate, [], true, 0.2]);

    // Without input there is no record, and the facts still print. Broken input counts as no input.
    for (const stdin of ["", "{broken", "[1]"]) {
      const bare = await runNode("scripts/session-start.mjs", { stdin, env });
      assert.equal(bare.code, 0, JSON.stringify(stdin));
      assert.match(bare.stdout, /"shadow" mode/, JSON.stringify(stdin));
    }
    assert.equal(readLog(tempDir).length, 1, "no input, no record");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the status line snippet writes the reset times and the session id as JSON, and counts a changed reset time as a change", () => {
  const tempDir = makeTempDir();
  try {
    const snippet = path.join(ROOT, "scripts", "statusline-snippet.sh");
    const run = (vars) => {
      // The snippet is pasted into a bash script, so it runs here inside bash, with HOME in the temp folder.
      const result = spawnSync("bash", ["-c", `source "${snippet}"`], { env: { PATH: process.env.PATH, HOME: tempDir, ...vars }, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    const dir = path.join(tempDir, ".claude", "orchestrator");
    const latest = () => JSON.parse(fs.readFileSync(path.join(dir, "limits-latest.json"), "utf8"));
    const lines = () => fs.readFileSync(path.join(dir, "limits.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const sample = { RATE_5H: "23.5", RATE_7D: "41", RATE_5H_RESET: "1790000000", RATE_7D_RESET: "1790500000", SESSION_ID: "abc-123" };

    run(sample);
    const first = latest();
    assert.deepEqual([first.five_hour, first.seven_day, first.five_hour_resets_at, first.seven_day_resets_at, first.session_id], [23.5, 41, 1790000000, 1790500000, "abc-123"]);
    assert.equal(typeof first.ts, "number");
    assert.equal(lines().length, 1);

    // The same values again: the latest file is rewritten, the history is not.
    run(sample);
    assert.equal(lines().length, 1);

    // A new window with the same percentage is a change, and the line names the session that saw it.
    run({ ...sample, RATE_5H_RESET: "1790018000", SESSION_ID: "def-456" });
    assert.equal(lines().length, 2);
    assert.equal(lines()[1].session_id, "def-456");

    // A value that is not a number, or a missing one, is written as null, and the line stays valid JSON.
    run({ RATE_5H: "50", RATE_5H_RESET: "soon", SESSION_ID: 'x"y' });
    const third = latest();
    assert.deepEqual([third.five_hour, third.seven_day, third.five_hour_resets_at, third.seven_day_resets_at, third.session_id], [50, null, null, null, "xy"]);
    assert.equal(lines().length, 3);

    // Leading zeros are not JSON. A status line script that pads a value for
    // alignment must not break the file; the padded value is the number it names.
    run({ RATE_5H: "05", RATE_7D: "007.5", RATE_5H_RESET: "00", SESSION_ID: "s" });
    const padded = latest();
    assert.deepEqual([padded.five_hour, padded.seven_day, padded.five_hour_resets_at], [5, 7.5, 0]);
    run({ RATE_5H: "0", SESSION_ID: "s" });
    assert.equal(latest().five_hour, 0, "a plain zero stays a zero");

    // Without any percentage the snippet writes nothing.
    fs.rmSync(dir, { recursive: true, force: true });
    run({ SESSION_ID: "abc", RATE_5H_RESET: "1790000000" });
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the setup check reports a status line log without reset times, and names the reset times when they are there", async () => {
  const tempDir = makeTempDir();
  try {
    const file = path.join(tempDir, "limits-latest.json");
    const env = cleanEnv(tempDir, { ORCH_LIMITS_FILE: file, ORCH_CODEX_ENABLED: "" });
    const now = Math.floor(Date.now() / 1000);

    fs.writeFileSync(file, JSON.stringify({ ts: now, five_hour: 12, seven_day: 34 }));
    const older = await runNode("scripts/setup-check.mjs", { env });
    assert.equal(older.code, 0, older.stderr);
    assert.match(older.stdout, /WARN\s+Status line log: .*no reset time.*RATE_5H_RESET/);

    fs.writeFileSync(file, JSON.stringify({ ts: now, five_hour: 12, seven_day: 34, five_hour_resets_at: now + 3600, seven_day_resets_at: now + 86400, session_id: "s" }));
    const current = await runNode("scripts/setup-check.mjs", { env });
    assert.match(current.stdout, /OK\s+Status line log: 5-hour 12% \(resets .+\), 7-day 34% \(resets .+\), \d+ s old/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the setup check says that Jev is off by default and does not look for a key", async () => {
  const tempDir = makeTempDir();
  try {
    const off = await runNode("scripts/setup-check.mjs", { env: cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "", ORCH_JEV_ENABLED: "" }) });
    assert.match(off.stdout, /OK\s+Jev: off, so the hook sends no brief to TypeSafe/);
    assert.doesNotMatch(off.stdout, /^\S+\s+TypeSafe key:/m);
    assert.match(off.stdout, /OK\s+Other agent types: they pass unchanged while Jev is off/);
    const on = await runNode("scripts/setup-check.mjs", { env: cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "" }) });
    assert.match(on.stdout, /MISSING\s+TypeSafe key: not found/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a rotation that another process did first loses no record", () => {
  const tempDir = makeTempDir();
  try {
    const env = { ORCH_DATA_DIR: path.join(tempDir, "data"), ORCH_LOG_MAX_BYTES: "1024" };
    fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
    fs.writeFileSync(logFile(env), `${JSON.stringify({ event: "old", pad: "x".repeat(1000) })}\n`);
    // The file is at the limit. Another hook rotates it in the same moment: the
    // stand-in for the rename moves the file away and then reports that it is gone.
    const realRename = fs.renameSync;
    const rename = mock.method(
      fs,
      "renameSync",
      (from, to) => {
        realRename(from, to);
        const error = new Error("ENOENT: the log was rotated by another process");
        error.code = "ENOENT";
        throw error;
      },
      { times: 1 }
    );
    try {
      assert.equal(appendLog({ event: "after" }, env), true, "the record is not dropped");
      assert.equal(rename.mock.callCount(), 1);
    } finally {
      rename.mock.restore();
    }
    assert.deepEqual(readLogTail(env).map((record) => record.event), ["after"]);
    assert.ok(fs.readFileSync(rotatedLogFile(env), "utf8").includes('"old"'), "the other process's rotation stands");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the session start offers the configure skill only while no settings file exists", async () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir, { ORCH_MODE: "shadow" });
    // Nobody has configured anything yet, so the session is told once that every
    // setting is at its default, and which skill changes that.
    const first = await runNode("scripts/session-start.mjs", { env });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /No settings file exists for this plugin yet/);
    assert.match(first.stdout, /orchestrator:configure/);

    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "config.json"), '{"mode":"shadow"}');
    const configured = await runNode("scripts/session-start.mjs", { env });
    assert.equal(configured.code, 0);
    assert.ok(!configured.stdout.includes("No settings file exists"), "the offer stops once a settings file exists");
    assert.match(configured.stdout, /"shadow" mode/, "the rest of the text is unchanged");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
