import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildReport, codexFailureCode, loadStore, renderText } from "../scripts/lib/report.mjs";
import { ROOT, cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const REPORT = "scripts/orch-report.mjs";
const SECRET = "SECRET-BRIEF-TEXT-THAT-MUST-NOT-BE-PRINTED";

// A small store with every kind of record, over two projects and three sessions.
// The numbers that the tests expect were counted by hand from this list.
function writeStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const at = (hourMinute) => `2026-09-22T${hourMinute}:00.000Z`;
  const s1 = { session_id: "s1", cwd: "/work/alpha", mode: "enforce" };
  const s2 = { session_id: "s2", cwd: "/work/beta", mode: "shadow" };
  const s3 = { session_id: "s3", cwd: "/work/beta", mode: "enforce" };
  const config = { kindGate: 0.6, difficultyGate: 0.5, selfContainedGate: 0.7, limitGate: 80, pacing: true, paceAfter: 0.2 };
  const jev = (overrides = {}) => ({ kind: "implement", kindConfidence: 0.9, writesFiles: 0.9, selfContained: 0.9, difficulty: 1, difficultyConfidence: 0.8, latency_ms: 300, ...overrides });
  const calm = { tight: false, reason: null };
  const dispatch = (base, ts, fields) => ({ ts: at(ts), event: "dispatch", ...base, ...fields });
  // The three records of one worker run: launched, start and stop.
  const run = (base, ts, toolUseId, agentId, agentType, endTs, stopFields) => [
    { ts: at(ts), event: "launched", session_id: base.session_id, cwd: base.cwd, tool_use_id: toolUseId, agent_id: agentId, final: { agent: agentType, model: null } },
    { ts: at(ts), event: "start", session_id: base.session_id, cwd: base.cwd, agent_id: agentId, agent_type: agentType },
    { ts: at(endTs), event: "stop", session_id: base.session_id, cwd: base.cwd, agent_id: agentId, agent_type: agentType, ...stopFields }
  ];

  const older = [
    // From before the store had `cwd`: counted, but dropped by a project filter and by --since 2026-09-22.
    { ts: "2026-09-21T15:00:00.000Z", event: "dispatch", session_id: "s0", tool_use_id: "t0", mode: "enforce", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:implementer", model: null }, action: "agree", reason: "implement", jev: jev(), prompt: SECRET },
    "{broken line"
  ];

  const current = [
    { ts: at("09:00"), event: "session", ...s1, source: "startup", config },
    // d1: a search brief sent to the implementer, rewritten to the searcher.
    dispatch(s1, "09:01", { tool_use_id: "t1", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:searcher", model: "haiku" }, action: "rewrite", reason: "search", route: { agent: "subagent-router:searcher", model: "haiku", reason: "search" }, would_route: { model: "sonnet", reason: "needs_every_match" }, jev: jev({ kind: "search", kindConfidence: 0.97, writesFiles: 0.03, difficulty: 0.4, difficultyConfidence: 0.7, latency_ms: 200 }), claude: calm, prompt: `${SECRET} one` }),
    ...run(s1, "09:01", "t1", "a1", "subagent-router:searcher", "09:02", { result: "Changed files: none\nVerification: read only\nOpen problems: none" }),
    // d2: Jev agrees; the implementer writes, and its verification failed.
    dispatch(s1, "09:05", { tool_use_id: "t2", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:implementer", model: null }, action: "agree", reason: "implement", route: { agent: "subagent-router:implementer", model: "sonnet", reason: "implement" }, jev: jev({ latency_ms: 400 }), claude: calm, prompt: `${SECRET} two` }),
    ...run(s1, "09:05", "t2", "a2", "subagent-router:implementer", "09:10", { result: "Changed files: x.js\nVerification: npm test failed with 2 errors\nOpen problems: none" }),
    // d3: a review after a Claude writer goes to Codex and finds things.
    dispatch(s1, "09:12", { tool_use_id: "t3", requested: { agent: "subagent-router:reviewer", model: null }, final: { agent: "subagent-router:codex-reviewer", model: "haiku" }, action: "rewrite", reason: "cross_review", route: { agent: "subagent-router:codex-reviewer", model: "haiku", reason: "cross_review" }, jev: jev({ kind: "review", writesFiles: 0.02 }), claude: calm, prompt: `${SECRET} review` }),
    ...run(s1, "09:12", "t3", "a3", "subagent-router:codex-reviewer", "09:15", { findings: { P0: 0, P1: 1, P2: 2, P3: 0 } }),
    // d4: the same brief as d2 again, on opus: a retry on a bigger model. Its worker wrote and passed.
    dispatch(s1, "09:20", { tool_use_id: "t4", requested: { agent: "subagent-router:implementer", model: "opus" }, final: { agent: "subagent-router:implementer", model: "opus" }, action: "pass", reason: "keep_requested", route: { agent: "subagent-router:implementer", model: "sonnet", reason: "implement" }, jev: jev(), claude: calm, prompt: `${SECRET} two` }),
    ...run(s1, "09:20", "t4", "a4", "subagent-router:implementer", "09:30", { result: "Changed files: y.js\nVerification: npm test, 12 passed\nOpen problems: none" }),
    // d5: a hard task goes to Codex, and the job fails: not an author.
    dispatch(s1, "09:31", { tool_use_id: "t5", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:codex-implementer", model: "haiku" }, action: "rewrite", reason: "hard_and_self_contained", route: { agent: "subagent-router:codex-implementer", model: "haiku", reason: "hard_and_self_contained" }, jev: jev({ difficulty: 2.4 }), claude: calm, prompt: `${SECRET} hard` }),
    ...run(s1, "09:31", "t5", "a5", "subagent-router:codex-implementer", "09:33", { result: "CODEX_FAILED 20260922-093100-a1b2c3 runner_died\nThe runner ended without an exit code.\nDetails: /x" }),
    // d6: a review now, moved to the Claude reviewer with a notice: the author is still the Claude worker of d4.
    dispatch(s1, "09:34", { tool_use_id: "t6", requested: { agent: "subagent-router:reviewer", model: null }, final: { agent: "subagent-router:reviewer", model: "sonnet" }, action: "rewrite", reason: "codex_unavailable", route: { agent: "subagent-router:reviewer", model: "sonnet", reason: "codex_unavailable" }, jev: jev({ kind: "review", writesFiles: 0.02 }), claude: calm, notice: "Codex reported that the ChatGPT plan has no capacity left. Until 24 Sept, 13:25, tasks for Codex run on Claude workers instead.", prompt: `${SECRET} review two` }),
    ...run(s1, "09:34", "t6", "a6", "subagent-router:reviewer", "09:36", { findings: { P0: 0, P1: 0, P2: 0, P3: 1 } }),
    // d7: Codex writes and succeeds. d8: the Claude reviewer checks it, so its findings count for the Codex family.
    dispatch(s1, "09:40", { tool_use_id: "t7", requested: { agent: "subagent-router:codex-implementer", model: null }, final: { agent: "subagent-router:codex-implementer", model: null }, action: "agree", reason: "hard_and_self_contained", route: { agent: "subagent-router:codex-implementer", model: "haiku", reason: "hard_and_self_contained" }, jev: jev({ difficulty: 2.2 }), claude: calm, prompt: `${SECRET} codex` }),
    ...run(s1, "09:40", "t7", "a7", "subagent-router:codex-implementer", "09:50", { result: "Changed files: z.js\nVerification: node --test, 3 passed\nOpen problems: none" }),
    dispatch(s1, "09:51", { tool_use_id: "t8", requested: { agent: "subagent-router:reviewer", model: null }, final: { agent: "subagent-router:reviewer", model: null }, action: "agree", reason: "cross_review", route: { agent: "subagent-router:reviewer", model: "sonnet", reason: "cross_review" }, jev: jev({ kind: "review", writesFiles: 0.02 }), claude: calm, prompt: `${SECRET} review three` }),
    ...run(s1, "09:51", "t8", "a8", "subagent-router:reviewer", "09:53", { findings: { P0: 0, P1: 0, P2: 1, P3: 0 } }),
    // A verification that did not run, and a Codex worker that was still running when it answered.
    ...run(s1, "09:55", "t9", "a9", "subagent-router:implementer", "09:56", { result: "Changed files: none\nVerification: not run, no test command\nOpen problems: none" }),
    ...run(s1, "09:57", "t10", "a10", "subagent-router:codex-implementer", "09:58", { result: "STILL_RUNNING 20260922-095700-abcdef\nWait with: node scripts/orch-codex.mjs wait ..." }),
    { ts: at("09:59"), event: "hook_error", hook: "log", error: "boom" },

    // A shadow session: the hook logs the route and changes nothing.
    { ts: at("10:00"), event: "session", ...s2, source: "resume", config },
    dispatch(s2, "10:01", { tool_use_id: "u1", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:implementer", model: null }, action: "shadow", reason: "mechanical_edit", route: { agent: "subagent-router:implementer", model: "haiku", reason: "mechanical_edit" }, jev: jev({ kind: "mechanical_edit", difficulty: 0.2 }), claude: calm, prompt: `${SECRET} e1` }),
    // Jev was not sure of the kind, and its difficulty confidence is under the gate.
    dispatch(s2, "10:02", { tool_use_id: "u2", requested: { agent: "subagent-router:debugger", model: null }, final: { agent: "subagent-router:debugger", model: null }, action: "pass", reason: "low_confidence", route: { agent: null, model: null, reason: "low_confidence" }, jev: jev({ kind: "debug", kindConfidence: 0.4, difficultyConfidence: 0.3, latency_ms: 900 }), claude: calm, prompt: `${SECRET} e2` }),
    // Jev timed out.
    dispatch(s2, "10:03", { tool_use_id: "u3", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:implementer", model: null }, action: "pass", reason: "error_timeout", jev: { error: "timeout", detail: "5000 ms", key_source: "env" }, claude: calm, prompt: `${SECRET} e3` }),

    // An enforce session in the same project: a denial, the pace rule on another agent type with a notice, and a fallback.
    // Its configuration differs in one value, so the report must take the newest session's configuration.
    { ts: at("10:10"), event: "session", ...s3, source: "startup", config: { ...config, paceAfter: 0.25 } },
    dispatch(s3, "10:11", { tool_use_id: "v1", requested: { agent: "subagent-router:implementer", model: null }, final: { agent: "subagent-router:implementer", model: null }, action: "deny", reason: "codex_writer_busy", jev: null, claude: calm, prompt: `${SECRET} e4` }),
    dispatch(s3, "10:12", { tool_use_id: "v2", requested: { agent: "dotnet-implementer", model: null }, final: { agent: "dotnet-implementer", model: "sonnet" }, action: "rewrite", reason: "implement", model_only: true, route: { agent: "dotnet-implementer", model: "sonnet", reason: "implement" }, jev: jev(), claude: { tight: true, reason: "pace", windows: {} }, notice: "Claude usage is at 50% of the 5-hour window. At this pace the 5-hour window runs out before it resets at 22 Sept, 13:00 (about 125% by then). Tasks with a complete brief now run on Codex, to save the Claude limit.", prompt: `${SECRET} e5` }),
    dispatch(s3, "10:13", { tool_use_id: "v3", requested: { agent: "subagent-router:codex-implementer", model: null }, final: { agent: "subagent-router:implementer", model: "sonnet" }, action: "fallback", reason: "codex_disabled", jev: jev({ kindConfidence: 0.3 }), claude: { tight: true, reason: "gate", windows: {} }, notice: 'Codex is off, because "codexEnabled" is not true in ~/.claude/orchestrator/config.json. Tasks for Codex run on Claude workers instead.', prompt: `${SECRET} e6` })
  ];

  const lines = (records) => `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`;
  fs.writeFileSync(path.join(dataDir, "dispatch-log.1.jsonl"), lines(older));
  fs.writeFileSync(path.join(dataDir, "dispatch-log.jsonl"), lines(current));

  // Limits: one line from the older snippet without reset times, then four samples
  // with them. The 5-hour window resets at base + 9600 for three samples and then
  // once more later; the 7-day window resets at base + 303000 for all four.
  //   base + 600:  50 percent after half of the 5-hour window, on pace for 100
  //   base + 1200: 20 percent after 0.53 of the window, on pace for 38
  //   base + 1800: 85 percent, at the gate
  //   base + 2400: 10 percent one hour into a new window, and the 7-day window at 90, the gate
  const base = Math.floor(Date.parse("2026-09-22T09:00:00.000Z") / 1000);
  const fiveReset = base + 9600;
  const sevenReset = base + 303000;
  const limits = [
    { ts: base, five_hour: 30, seven_day: 10 },
    { ts: base + 600, five_hour: 50, seven_day: 10, five_hour_resets_at: fiveReset, seven_day_resets_at: sevenReset, session_id: "s1" },
    { ts: base + 1200, five_hour: 20, seven_day: 10, five_hour_resets_at: fiveReset, seven_day_resets_at: sevenReset, session_id: "s1" },
    { ts: base + 1800, five_hour: 85, seven_day: 12, five_hour_resets_at: fiveReset, seven_day_resets_at: sevenReset, session_id: "s1" },
    { ts: base + 2400, five_hour: 10, seven_day: 90, five_hour_resets_at: base + 2400 + 4 * 3600, seven_day_resets_at: sevenReset, session_id: "s2" }
  ];
  fs.writeFileSync(path.join(dataDir, "limits.jsonl"), lines(limits));
}

test("the report counts the store: dispatches, the changed share, Jev, the labels, durations, findings and usage", () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    writeStore(dataDir);
    const report = buildReport(loadStore({ ORCH_DATA_DIR: dataDir }));

    // 3 session records, 14 dispatches, 10 worker runs of 3 records, 1 hook error.
    assert.deepEqual(report.store.files.map((file) => [file.name, file.exists, file.lines, file.broken]), [["dispatch-log.1.jsonl", true, 1, 1], ["dispatch-log.jsonl", true, 48, 0], ["limits.jsonl", true, 5, 0]]);
    assert.deepEqual([report.store.sessions, report.store.hookErrors, report.store.recordsWithoutCwd], [4, 1, 2]);
    assert.deepEqual(report.store.projects, { "/work/alpha": 8, "/work/beta": 6, "(no cwd)": 1 });
    // The newest session record sets the configuration in force: s3 has paceAfter 0.25, the two older ones 0.2.
    assert.deepEqual([report.config.difficultyGate, report.config.paceAfter], [0.5, 0.25]);

    const d = report.dispatches;
    assert.equal(d.total, 15);
    assert.deepEqual(d.byMode, { enforce: 12, shadow: 3 });
    assert.deepEqual(d.byAction, { agree: 4, rewrite: 5, pass: 3, deny: 1, shadow: 1, fallback: 1 });
    assert.deepEqual(d.changed, { count: 6, share: 40, byReason: { search: 1, cross_review: 1, hard_and_self_contained: 1, codex_unavailable: 1, implement: 1, codex_disabled: 1 } });
    assert.deepEqual(d.wouldChange, { count: 1, byReason: { mechanical_edit: 1 } });
    assert.deepEqual(d.unchanged, { count: 7, byReason: { implement: 2, hard_and_self_contained: 1, cross_review: 1, keep_requested: 1, low_confidence: 1, error_timeout: 1 } });
    assert.deepEqual([d.denied, d.modelOnly], [1, 1]);
    // One dispatch of the store carries what a watching rule would have changed.
    assert.deepEqual([d.ruleWouldFire, d.ruleWouldFireByReason], [1, { needs_every_match: 1 }]);
    assert.deepEqual(d.notices, { count: 3, byKind: { codex: 2, claude_tight: 1 } });
    assert.deepEqual(d.claudeTightAtDispatch, { gate: 1, pace: 1, no: 12, unknown: 1 });

    const j = report.jev;
    // The denied dispatch has no Jev record; the timed-out one has an error record.
    assert.deepEqual([j.asked, j.answered, j.errors], [14, 13, { timeout: 1 }]);
    // Thirteen latencies: 200, ten of 300, 400 and 900. The mean is 4500 / 13.
    assert.deepEqual(j.latency, { count: 13, medianMs: 300, meanMs: 346, maxMs: 900 });
    assert.deepEqual(j.kinds, { implement: 7, search: 1, review: 3, mechanical_edit: 1, debug: 1 });
    // Two answers are under the kind gate (0.4 and 0.3); one is under the difficulty gate (0.3).
    assert.deepEqual([j.kindConfident, j.difficultyKnown], [{ count: 11, share: 84.6 }, { count: 12, share: 92.3 }]);
    // Agreed: the four "agree" actions. Abstained: the low-confidence answer, and the fallback whose Jev answer named no route.
    assert.deepEqual(j.againstRequest, { agreed: 4, differed: 7, abstained: 2 });

    assert.deepEqual(report.underRouting, { retriesBigger: 1, retriesOther: 0, verificationFailed: 1, verificationNotRun: 1, verificationJudgedByJev: 0, codexFailed: { count: 1, byCode: { runner_died: 1 } }, stillRunning: 1 });

    assert.deepEqual(Object.keys(report.durations).sort(), ["subagent-router:codex-implementer", "subagent-router:codex-reviewer", "subagent-router:implementer", "subagent-router:reviewer", "subagent-router:searcher"]);
    // The implementer ran three times: 5, 10 and 1 minutes.
    assert.deepEqual(report.durations["subagent-router:implementer"], { count: 3, medianMs: 300000, meanMs: 320000, maxMs: 600000 });
    assert.deepEqual(report.durations["subagent-router:searcher"], { count: 1, medianMs: 60000, meanMs: 60000, maxMs: 60000 });

    // Two reviews after Claude writers (d3 after d2, d6 after d4; the failed Codex job of d5 is no author), one after the Codex writer of d7.
    assert.deepEqual(report.findings, { claude: { reviews: 2, P0: 0, P1: 1, P2: 2, P3: 1 }, codex: { reviews: 1, P0: 0, P1: 0, P2: 1, P3: 0 } });

    const u = report.claudeUsage;
    assert.deepEqual([u.samples, u.withResetTimes], [5, 4]);
    assert.deepEqual(u.fiveHour, { min: 10, max: 85, last: 10, windowsSeen: 2 });
    assert.deepEqual(u.sevenDay, { min: 10, max: 90, last: 90, windowsSeen: 1 });
    // Calm without reset times, then pace, calm, gate, and gate from the weekly window.
    assert.deepEqual(u.verdicts, { gate: 2, pace: 1, calm: 2, unknown: 0 });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the report command prints counts only, honours --since and --project, and rejects a bad date", async () => {
  const tempDir = makeTempDir();
  try {
    const dataDir = path.join(tempDir, "data");
    writeStore(dataDir);
    const env = cleanEnv(tempDir);

    const text = await runNode(REPORT, { env });
    assert.equal(text.code, 0, text.stderr);
    assert.ok(!text.stdout.includes(SECRET), "no brief text in the report");
    assert.ok(!text.stdout.includes("x.js"), "no worker result in the report");
    assert.match(text.stdout, /Dispatches: 15 \(enforce 12, shadow 3\)/);
    assert.match(text.stdout, /Changed by the hook: 6 of 15 \(40%\)/);
    // Each number ends at a line end or a comma, so 10 or 100 cannot pass as 1.
    assert.match(text.stdout, /broken lines skipped 1\n/);
    assert.match(text.stdout, /claude: 2 reviews, P0 0, P1 1, P2 2, P3 1\n/);
    assert.match(text.stdout, /tight by pace only 1,/);
    assert.match(text.stdout, /pace rule on after 25% of a window/, "the newest session's configuration is the one in force");

    const json = await runNode(REPORT, { args: ["--json"], env });
    assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).dispatches.total, 15);
    assert.ok(!json.stdout.includes(SECRET));

    const beta = JSON.parse((await runNode(REPORT, { args: ["--json", "--project", "beta"], env })).stdout);
    assert.deepEqual([beta.dispatches.total, beta.filters.project, Object.keys(beta.store.projects)], [6, "beta", ["/work/beta"]]);

    const since = JSON.parse((await runNode(REPORT, { args: ["--json", "--since", "2026-09-22"], env })).stdout);
    assert.deepEqual([since.dispatches.total, since.store.recordsWithoutCwd, since.claudeUsage.samples], [14, 1, 5]);
    const later = JSON.parse((await runNode(REPORT, { args: ["--json", "--since", "2026-09-22T10:00:00Z"], env })).stdout);
    assert.deepEqual([later.dispatches.total, later.claudeUsage.samples], [6, 0]);

    const bad = await runNode(REPORT, { args: ["--since", "yesterday"], env });
    assert.deepEqual([bad.code, bad.stdout], [2, ""]);
    assert.match(bad.stderr, /--since needs a date/);
    const unknown = await runNode(REPORT, { args: ["--verbose"], env });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Usage:/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an empty store gives an empty report and exit 0, also from a plugin path with a space", async () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir);
    const text = await runNode(REPORT, { env });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /dispatch-log.jsonl: not there/);
    assert.match(text.stdout, /No records\./);
    const json = JSON.parse((await runNode(REPORT, { args: ["--json"], env })).stdout);
    assert.deepEqual([json.dispatches.total, json.jev.asked, json.claudeUsage.samples, json.findings], [0, 0, 0, {}]);
    assert.equal(renderText(json).includes("No records."), true);

    // The entry check compares paths. A plugin path with a space must still run the command.
    const copy = path.join(tempDir, "plugin dir");
    fs.cpSync(path.join(ROOT, "scripts"), path.join(copy, "scripts"), { recursive: true });
    const spaced = spawnSync(process.execPath, [path.join(copy, "scripts", "orch-report.mjs")], { env, encoding: "utf8" });
    assert.equal(spaced.status, 0, spaced.stderr);
    assert.match(spaced.stdout, /No records\./);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the report counts a rule that only watched, and leaves the routes it did not change alone", () => {
  // Three search dispatches that all ran on haiku. The completeness rule was
  // only watching, so it changed none of them and marked two of them.
  const base = { event: "dispatch", session_id: "s", cwd: "/work/p", mode: "enforce", action: "rewrite", reason: "search", model_only: true, requested: { agent: "Explore", model: null }, final: { agent: "Explore", model: "haiku" } };
  const report = buildReport({
    dataDir: "/tmp/none",
    log: [
      { ...base, ts: "2026-09-22T10:00:00.000Z", tool_use_id: "a", would_route: { model: "sonnet", reason: "needs_every_match" } },
      { ...base, ts: "2026-09-22T10:01:00.000Z", tool_use_id: "b", would_route: { model: "sonnet", reason: "needs_every_match" } },
      { ...base, ts: "2026-09-22T10:02:00.000Z", tool_use_id: "c" }
    ],
    limits: [],
    files: []
  });
  assert.deepEqual([report.dispatches.total, report.dispatches.changed.count], [3, 3]);
  assert.equal(report.dispatches.ruleWouldFire, 2);
  assert.deepEqual(report.dispatches.ruleWouldFireByReason, { needs_every_match: 2 });
  assert.match(renderText(report), /A rule that only watched would have changed: 2 of 3: needs_every_match 2/);
});

test("records from before the rename count under the new worker names", () => {
  // Up to 0.2.3 the plugin was "orchestrator". An old Claude writer is reviewed by
  // a new Codex reviewer, and a new Codex writer by an old Claude reviewer.
  const at = (minute) => `2026-09-24T10:${minute}:00.000Z`;
  const base = { session_id: "s", cwd: "/work/p" };
  const run = (minute, id, agentType, stopFields) => [
    { ...base, ts: at(minute), event: "launched", tool_use_id: `t${id}`, agent_id: `a${id}`, final: { agent: agentType, model: null } },
    { ...base, ts: at(minute), event: "start", agent_id: `a${id}`, agent_type: agentType },
    { ...base, ts: at(minute + 1), event: "stop", agent_id: `a${id}`, agent_type: agentType, ...stopFields }
  ];
  const dispatch = (minute, id, agent) => ({ ...base, ts: at(minute), event: "dispatch", mode: "enforce", tool_use_id: `t${id}`, requested: { agent, model: null }, final: { agent, model: null }, action: "agree", reason: "implement" });
  const report = buildReport({
    dataDir: "/tmp/none",
    log: [
      dispatch(10, 1, "orchestrator:implementer"),
      ...run(10, 1, "orchestrator:implementer", { result: "Changed files: a.js\nVerification: npm test, 3 passed\nOpen problems: none" }),
      dispatch(20, 2, "subagent-router:codex-reviewer"),
      ...run(20, 2, "subagent-router:codex-reviewer", { findings: { P0: 0, P1: 1, P2: 0, P3: 0 } }),
      dispatch(30, 3, "subagent-router:codex-implementer"),
      ...run(30, 3, "subagent-router:codex-implementer", { result: "Changed files: b.js\nVerification: node --test, 2 passed\nOpen problems: none" }),
      dispatch(40, 4, "orchestrator:reviewer"),
      ...run(40, 4, "orchestrator:reviewer", { findings: { P0: 0, P1: 0, P2: 2, P3: 0 } })
    ],
    limits: [],
    files: []
  });
  assert.deepEqual(report.findings, { claude: { reviews: 1, P0: 0, P1: 1, P2: 0, P3: 0 }, codex: { reviews: 1, P0: 0, P1: 0, P2: 2, P3: 0 } });
  assert.deepEqual(Object.keys(report.durations).sort(), ["subagent-router:codex-implementer", "subagent-router:codex-reviewer", "subagent-router:implementer", "subagent-router:reviewer"]);
});

test("a failed Codex job is counted under its reason, not under its job id", async () => {
  // The forms that scripts/orch-codex.mjs and the two Codex workers write.
  const cases = [
    ["CODEX_FAILED 20260923-101500-0a1b2c exit=1\nCodex reported an error.\nDetails: /x", "exit=1"],
    ["CODEX_FAILED 20260923-101500-0a1b2c exit=124 scope=base:main\nDetails: /x", "exit=124"],
    ["CODEX_FAILED 20260923-101500-0a1b2c runner_died\nThe runner ended.", "runner_died"],
    ["CODEX_FAILED 20260923-101500-0a1b2c cancel_failed\nThese processes are still alive: 12.", "cancel_failed"],
    ["CODEX_FAILED error: the job file cannot be read", "error"],
    ["CODEX_FAILED no codex-request line. The routing hook did not store this task.", "no_request"],
    ["CODEX_FAILED", "unknown"]
  ];
  for (const [result, code] of cases) {
    assert.equal(codexFailureCode(result), code, result);
  }
  // A cancel is not a failure: only the failed job is counted.
  const stop = (result) => ({ event: "stop", ts: "2026-09-23T10:00:00.000Z", session_id: "s", cwd: "/work/p", agent_type: "subagent-router:codex-implementer", agent_id: result.slice(0, 20), result });
  const report = buildReport({
    dataDir: "/tmp/none",
    log: [stop("CODEX_FAILED 20260923-101500-0a1b2c exit=1\nDetails: /x"), stop("CODEX_CANCELLED 20260923-101600-0a1b2d\nThe job was stopped.")],
    limits: [],
    files: []
  });
  assert.deepEqual(report.underRouting.codexFailed, { count: 1, byCode: { "exit=1": 1 } });
  // The real command's own answer to a wrong call, not a copy of its text.
  const tempDir = makeTempDir();
  try {
    const usage = await runNode("scripts/orch-codex.mjs", { env: cleanEnv(tempDir) });
    assert.match(usage.stdout, /^CODEX_FAILED usage error:/);
    assert.equal(codexFailureCode(usage.stdout), "usage_error");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the report takes the verification outcome from Jev and falls back to the word search", () => {
  const at = (minute) => `2026-09-24T10:${minute}:00.000Z`;
  const stop = (agentId, minute, result) => ({ ts: at(minute), event: "stop", session_id: "s", agent_id: agentId, agent_type: "subagent-router:implementer", result });
  const log = [
    // The word search reads "0 fail" and "no errors" as failures. Jev's labels say
    // passed and not_run, and they must win.
    stop("a1", "01", "Changed files: a.js\nVerification: npm test: 225 pass, 0 fail\nOpen problems: none"),
    { ts: at("01"), event: "verification", session_id: "s", agent_id: "a1", outcome: "passed", confidence: 0.97 },
    stop("a2", "02", "Changed files: b.js\nVerification: skipped, only read the code with no errors seen\nOpen problems: none"),
    { ts: at("02"), event: "verification", session_id: "s", agent_id: "a2", outcome: "not_run", confidence: 0.9 },
    stop("a3", "03", "Changed files: c.js\nVerification: npm test passed\nOpen problems: none"),
    { ts: at("03"), event: "verification", session_id: "s", agent_id: "a3", outcome: "failed", confidence: 0.6 },
    // No label, for example a log from before the question, or a timed-out call:
    // the word search decides, and an error record is not a label.
    stop("a4", "04", "Changed files: d.js\nVerification: npm test: 1 failed\nOpen problems: none"),
    { ts: at("04"), event: "verification", session_id: "s", agent_id: "a4", error: "timeout" },
    // The log cut the result before its Verification line (resultLogChars), but the
    // hook judged the full answer, so the label still counts.
    stop("a5", "05", "Changed files: e.js... [+900 chars]"),
    { ts: at("05"), event: "verification", session_id: "s", agent_id: "a5", outcome: "failed", confidence: 0.9 }
  ];
  const { underRouting } = buildReport({ dataDir: "/x", files: [], log, limits: [] });
  assert.deepEqual(
    [underRouting.verificationFailed, underRouting.verificationNotRun, underRouting.verificationJudgedByJev],
    [3, 1, 4],
    "a3 and a5 by Jev and a4 by the word search failed; a2 was not run; a1 passed although the words say fail"
  );
});
