import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { DEFAULTS, loadConfig } from "../scripts/lib/config.mjs";
import { FABLE_MIN_VERSION, claudeCodeVersion, fableLaunchCount, fableLedgerFile, fableStaleLock, reserveFableLaunch, versionAtLeast } from "../scripts/lib/fable-gate.mjs";
import { fableCandidate } from "../scripts/lib/routing-table.mjs";
import { agentCall, cleanEnv, jevBody, makeTempDir, readLog, runNode, startFakeJev } from "./helpers.mjs";

const HOOK = "scripts/route-hook.mjs";
const TEST_KEY = "test-key-not-a-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

function withDataDir(run) {
  const tempDir = makeTempDir("orch-fable-");
  try {
    return run({ ORCH_DATA_DIR: path.join(tempDir, "data") }, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---- The gate ----

test("a version counts only when it can be read and is not older than the minimum", () => {
  assert.equal(versionAtLeast("2.1.321", "2.1.321"), true);
  assert.equal(versionAtLeast("2.1.322", "2.1.321"), true);
  assert.equal(versionAtLeast("2.2.0", "2.1.321"), true);
  assert.equal(versionAtLeast("3.0.0", "2.1.321"), true);
  assert.equal(versionAtLeast("2.1.320", "2.1.321"), false);
  assert.equal(versionAtLeast("2.1.300", "2.1.321"), false);
  assert.equal(versionAtLeast("2.0.999", "2.1.321"), false);
  // A comparison of text would put "2.1.99" above "2.1.321".
  assert.equal(versionAtLeast("2.1.99", "2.1.321"), false);
  assert.equal(versionAtLeast(null, "2.1.321"), false);
  assert.equal(versionAtLeast("", "2.1.321"), false);
  assert.equal(versionAtLeast("latest", "2.1.321"), false);
});

test("the version comes from the top-level field of the newest transcript line, never from conversation text", () => {
  const tempDir = makeTempDir("orch-fable-transcript-");
  try {
    const file = path.join(tempDir, "session.jsonl");
    const line = (version, extra = {}) => JSON.stringify({ type: "user", version, ...extra });

    fs.writeFileSync(file, `${line("2.1.300")}\n${line("2.1.321")}\n`);
    assert.equal(claudeCodeVersion(file), "2.1.321", "a resumed session reports the version that runs now");

    // A message that quotes a newer version, and a tool result that holds an
    // object with its own version field. Neither is the field of the line.
    // The nested field comes first in the line, so a search of the text finds it first.
    const nested = JSON.stringify({ toolUseResult: { version: "9.9.9" }, message: { content: 'the docs say "version":"9.9.9"' }, type: "user", version: "2.1.300" });
    assert.ok(nested.indexOf('"version":"9.9.9"') < nested.indexOf('"version":"2.1.300"'));
    fs.writeFileSync(file, `${nested}\n`);
    assert.equal(claudeCodeVersion(file), "2.1.300");

    // A line with only a nested field has no version of its own.
    fs.writeFileSync(file, `${JSON.stringify({ type: "user", toolUseResult: { version: "9.9.9" } })}\n`);
    assert.equal(claudeCodeVersion(file), null);

    fs.writeFileSync(file, `${JSON.stringify({ type: "summary" })}\n{"type":"user","version":"2.1.3`);
    assert.equal(claudeCodeVersion(file), null, "a cut last line and a line without the field give no version");

    // Bookkeeping lines carry no version field. They are skipped, and the newest line that has one decides.
    fs.writeFileSync(file, `${line("2.1.321")}\n${JSON.stringify({ type: "mode" })}\n${JSON.stringify({ type: "custom-title" })}\n`);
    assert.equal(claudeCodeVersion(file), "2.1.321");

    // The newest line with the field decides alone. A value that is no version
    // must not fall back to an older line, which another Claude Code may have written.
    for (const bad of ["", "next", null, 2, { major: 2 }]) {
      fs.writeFileSync(file, `${line("2.1.321")}\n${JSON.stringify({ type: "user", version: bad })}\n`);
      assert.equal(claudeCodeVersion(file), null, `version ${JSON.stringify(bad)}`);
    }

    assert.equal(claudeCodeVersion(path.join(tempDir, "missing.jsonl")), null);
    assert.equal(claudeCodeVersion(undefined), null);
    assert.equal(claudeCodeVersion(""), null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the limit counts launches of the last 7 days and refuses the one above it", () => {
  withDataDir((env) => {
    const now = Date.parse("2026-11-14T12:00:00Z");
    const ask = (toolUseId, at = now) => reserveFableLaunch({ limit: 2, sessionId: "s", toolUseId }, env, at);

    assert.deepEqual(ask("t1"), { ok: true, count: 1, limit: 2 });
    assert.deepEqual(ask("t2"), { ok: true, count: 2, limit: 2 });
    assert.deepEqual(ask("t3"), { ok: false, reason: "limit_reached", count: 2, limit: 2 });
    assert.equal(fableLaunchCount(env, now), 2);

    // The same tool call asks again: it has its place, and takes no second one.
    assert.deepEqual(ask("t1"), { ok: true, count: 2, limit: 2, repeated: true });

    // Just before 7 days both launches still count. Just after, both are gone.
    assert.equal(ask("t4", now + 7 * DAY_MS - 1).ok, false);
    assert.deepEqual(ask("t5", now + 7 * DAY_MS), { ok: true, count: 1, limit: 2 });
    assert.equal(JSON.parse(fs.readFileSync(fableLedgerFile(env), "utf8")).launches.length, 1, "old launches leave the file");
  });
});

test("a limit of zero, a fraction or a missing limit never reserves", () => {
  withDataDir((env) => {
    for (const limit of [0, -1, 2.5, undefined, null, "3"]) {
      const answer = reserveFableLaunch({ limit, sessionId: "s", toolUseId: "t" }, env);
      assert.equal(answer.ok, false, `limit ${limit}`);
      assert.equal(answer.reason, "limit_zero");
    }
    assert.equal(fs.existsSync(fableLedgerFile(env)), false, "nothing was written");
  });
});

test("a damaged launch record refuses, so damage never frees capacity", () => {
  withDataDir((env) => {
    const file = fableLedgerFile(env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const content of ["not json", "[]", '{"launches":"none"}', '{"launches":[{"ts":"not a time"}]}', '{"launches":[null]}']) {
      fs.writeFileSync(file, content);
      assert.deepEqual(reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t" }, env), { ok: false, reason: "ledger_damaged", limit: 5 });
      assert.equal(fableLaunchCount(env), null);
      assert.equal(fs.readFileSync(file, "utf8"), content, "the damaged file is left for a person to look at");
    }
  });
});

test("a launch record that cannot be read at all refuses too", () => {
  withDataDir((env) => {
    // A folder where the file should be: reading fails with an error that is not "missing".
    fs.mkdirSync(fableLedgerFile(env), { recursive: true });
    assert.deepEqual(reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t" }, env), { ok: false, reason: "ledger_damaged", limit: 5 });
    assert.equal(fableLaunchCount(env), null);
  });
});

test("a held lock refuses, and an old lock is never broken by a hook", () => {
  withDataDir((env) => {
    const file = fableLedgerFile(env);
    const lock = `${file}.lock`;
    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(lock, "");
    assert.deepEqual(reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t1" }, env), { ok: false, reason: "ledger_busy", limit: 5 });
    assert.equal(fs.existsSync(file), false, "a refused launch is not recorded");
    assert.equal(fableStaleLock(env), null, "a new lock is not reported as left behind");

    // Two hooks that break the same old lock can remove each other's new lock.
    // So the lock stays, the route stays off, and the setup check can name the file.
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.equal(reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t1" }, env).reason, "ledger_busy");
    assert.equal(fs.existsSync(lock), true);
    assert.equal(fableStaleLock(env), lock);

    fs.unlinkSync(lock);
    assert.equal(reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t1" }, env).ok, true);
    assert.equal(fs.existsSync(lock), false, "the lock is released after the reservation");
  });
});

test("the loader rounds the launch limit down, and refuses a value outside its range", () => {
  withDataDir((env) => {
    fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
    const load = (settings, extra = {}) => {
      fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "config.json"), JSON.stringify(settings));
      return loadConfig({ ...env, ...extra });
    };
    assert.equal(load({ fableWeeklyLaunches: 2.7 }).config.fableWeeklyLaunches, 2);
    assert.equal(load({ fableWeeklyLaunches: 0.5 }).config.fableWeeklyLaunches, 0, "less than one launch is no launch");
    const tooMany = load({ fableWeeklyLaunches: 600 });
    assert.equal(tooMany.config.fableWeeklyLaunches, DEFAULTS.fableWeeklyLaunches);
    assert.match(tooMany.warnings.join("\n"), /fableWeeklyLaunches must be a number from 0 to 500/);
    const badEffort = load({ fableEffort: "max" });
    assert.equal(badEffort.config.fableEffort, "medium");
    assert.match(badEffort.warnings.join("\n"), /fableEffort must be one of low, medium, high/);

    // The variable sets the switch for one session, in both directions.
    assert.equal(load({}).config.fableRoute, false);
    assert.equal(load({}, { ORCH_FABLE_ROUTE: "1" }).config.fableRoute, true);
    assert.equal(load({ fableRoute: true }, { ORCH_FABLE_ROUTE: "0" }).config.fableRoute, false);
    const junk = load({}, { ORCH_FABLE_ROUTE: "yes please" });
    assert.equal(junk.config.fableRoute, false, "a value that cannot be read leaves the route off");
    assert.match(junk.warnings.join("\n"), /ORCH_FABLE_ROUTE must be/);
    assert.equal(load({ fableRoute: "true" }).config.fableRoute, false, "a text value is not a yes");
  });
});

test("the launch record is private to the user", () => {
  withDataDir((env) => {
    reserveFableLaunch({ limit: 5, sessionId: "s", toolUseId: "t1" }, env);
    assert.equal(fs.statSync(fableLedgerFile(env)).mode & 0o077, 0);
  });
});

// ---- Which routes are candidates ----

test("only an Opus route for debugging or a hard implementation is a candidate, and only while the route is on", () => {
  const on = { ...DEFAULTS, fableRoute: true };
  for (const reason of ["debug", "hard", "hard_needs_context", "codex_tight"]) {
    assert.equal(fableCandidate({ agent: "x", model: "opus", reason }, on), true, reason);
    assert.equal(fableCandidate({ agent: "x", model: "opus", reason }, DEFAULTS), false, `${reason} while off`);
  }
  // The limit rule capped the route at Sonnet: the reason and the model changed.
  assert.equal(fableCandidate({ agent: "x", model: "sonnet", reason: "claude_tight" }, on), false);
  assert.equal(fableCandidate({ agent: "x", model: "sonnet", reason: "implement" }, on), false);
  assert.equal(fableCandidate({ agent: "x", model: "haiku", reason: "hard_and_self_contained" }, on), false, "a route to Codex");
  assert.equal(fableCandidate({ agent: null, model: null, reason: "kind_design" }, on), false);
  assert.equal(fableCandidate(null, on), false);
  assert.equal(DEFAULTS.fableRoute, false, "the route is off until the user turns it on");
});

// ---- Through the real hook ----

async function withHook(settings, run) {
  const jev = await startFakeJev({ body: jevBody({ kind: "debug", difficulty: 1, writes: 0.9, selfContained: 0.1 }) });
  const tempDir = makeTempDir("orch-fable-hook-");
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(settings));
    // Codex is off, so a hard implementation stays on a Claude worker.
    const env = cleanEnv(tempDir, { ORCH_TYPESAFE_URL: jev.url, TYPESAFE_API_KEY: TEST_KEY, ORCH_CODEX_ENABLED: "" });
    const transcript = (version) => {
      const file = path.join(tempDir, `transcript-${version}.jsonl`);
      fs.writeFileSync(file, `${JSON.stringify({ type: "user", version })}\n`);
      return file;
    };
    const call = (overrides = {}, toolInput = {}) =>
      agentCall({
        transcript_path: transcript(FABLE_MIN_VERSION),
        ...overrides,
        tool_input: { description: "Find the crash", prompt: "Goal: find why the worker crashes.", subagent_type: "subagent-router:debugger", ...toolInput }
      });
    const run1 = async (stdin, extraEnv = {}) => {
      const result = await runNode(HOOK, { stdin, env: { ...env, ...extraEnv } });
      assert.equal(result.code, 0);
      const output = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput : null;
      return { sent: output?.updatedInput ?? null, output, record: readLog(tempDir).at(-1) };
    };
    await run({ jev, tempDir, env, call, transcript, run1, ledger: () => fableLaunchCount({ ORCH_DATA_DIR: dataDir }) });
  } finally {
    await jev.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("with the route off, a debugging task stays on Opus and nothing is recorded or reserved", async () => {
  await withHook({}, async ({ call, run1, ledger }) => {
    const { sent, record } = await run1(call());
    assert.equal(sent, null, "the debugger already runs on Opus, so the call is not rewritten");
    assert.deepEqual([record.action, record.reason, record.final.model], ["agree", "debug", null]);
    assert.equal(record.fable, undefined);
    assert.equal(ledger(), 0);
  });
});

test("with the route on, a debugging task moves to Fable at the configured effort and takes one launch", async () => {
  await withHook({ fableRoute: true, fableWeeklyLaunches: 3, fableEffort: "low" }, async ({ call, run1, ledger }) => {
    const { sent, record } = await run1(call());
    assert.deepEqual([sent.subagent_type, sent.model, sent.effort], ["subagent-router:debugger", "fable", "low"]);
    assert.equal(sent.description, "Find the crash", "the other fields of the call are copied");
    assert.equal(sent.prompt, "Goal: find why the worker crashes.", "the brief is unchanged");
    assert.deepEqual([record.action, record.reason], ["rewrite", "fable_debug"]);
    assert.deepEqual(record.final, { agent: "subagent-router:debugger", model: "fable", effort: "low" });
    assert.deepEqual(record.fable, { used: true, count: 1, limit: 3, effort: "low", version: FABLE_MIN_VERSION });
    assert.deepEqual(record.route, { agent: "subagent-router:debugger", model: "opus", reason: "debug" }, "the log keeps what the table picked");
    assert.equal(ledger(), 1);
  });
});

test("a level that the call names stays, and the model still moves", async () => {
  await withHook({ fableRoute: true }, async ({ call, run1 }) => {
    const { sent, record } = await run1(call({}, { effort: "high" }));
    assert.deepEqual([sent.model, sent.effort], ["fable", "high"]);
    assert.equal(record.final.effort, undefined);
    assert.equal(record.fable.effort, null);
  });
});

test("a hard implementation moves to Fable too, and a normal one does not", async () => {
  await withHook({ fableRoute: true }, async ({ jev, call, run1, ledger }) => {
    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 2, selfContained: 0.1 }) };
    const hard = await run1(call({ tool_use_id: "toolu_hard" }, { subagent_type: "subagent-router:implementer" }));
    assert.deepEqual([hard.sent.subagent_type, hard.sent.model, hard.sent.effort], ["subagent-router:implementer", "fable", "medium"]);
    assert.equal(hard.record.reason, "fable_hard_needs_context");

    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 1, selfContained: 0.1 }) };
    const normal = await run1(call({ tool_use_id: "toolu_normal" }, { subagent_type: "subagent-router:implementer" }));
    assert.equal(normal.sent, null);
    assert.equal(normal.record.fable, undefined);
    assert.equal(ledger(), 1);
  });
});

test("another owner's agent keeps its type and gets the model and the effort", async () => {
  await withHook({ fableRoute: true }, async ({ call, run1 }) => {
    const { sent, record } = await run1(call({}, { subagent_type: "general-purpose" }));
    assert.deepEqual([sent.subagent_type, sent.model, sent.effort], ["general-purpose", "fable", "medium"]);
    assert.deepEqual([record.model_only, record.reason], [true, "fable_debug"]);
  });
});

test("above the limit the task stays on Opus, and the record says why", async () => {
  await withHook({ fableRoute: true, fableWeeklyLaunches: 1 }, async ({ call, run1, ledger }) => {
    assert.equal((await run1(call({ tool_use_id: "toolu_a" }))).sent.model, "fable");
    const second = await run1(call({ tool_use_id: "toolu_b" }));
    assert.equal(second.sent, null, "the call runs as written, on the debugger's Opus");
    assert.deepEqual([second.record.action, second.record.reason, second.record.final.model], ["agree", "debug", null]);
    assert.deepEqual(second.record.fable, { used: false, reason: "limit_reached", count: 1, limit: 1 });
    assert.equal(ledger(), 1);
  });
});

test("a limit of zero stops the route", async () => {
  await withHook({ fableRoute: true, fableWeeklyLaunches: 0 }, async ({ call, run1, ledger }) => {
    const { sent, record } = await run1(call());
    assert.equal(sent, null);
    assert.equal(record.fable.reason, "limit_zero");
    assert.equal(ledger(), 0);
  });
});

test("an older Claude Code, or one whose version cannot be read, never gets the Fable name", async () => {
  await withHook({ fableRoute: true }, async ({ call, transcript, run1, ledger }) => {
    // Before 2.1.321 the name `fable` means Fable 5.1, at a higher price.
    const old = await run1(call({ transcript_path: transcript("2.1.300") }));
    assert.equal(old.sent, null);
    assert.deepEqual(old.record.fable, { used: false, reason: "version_old", version: "2.1.300" });

    const none = await run1(call({ transcript_path: undefined }));
    assert.equal(none.sent, null);
    assert.deepEqual(none.record.fable, { used: false, reason: "version_unknown", version: null });
    assert.equal(ledger(), 0, "a refused version reserves nothing");
  });
});

test("a damaged launch record leaves the task on Opus", async () => {
  await withHook({ fableRoute: true }, async ({ tempDir, call, run1 }) => {
    fs.writeFileSync(path.join(tempDir, "data", "fable-launches.json"), "not json");
    const { sent, record } = await run1(call());
    assert.equal(sent, null);
    assert.equal(record.fable.reason, "ledger_damaged");
    assert.equal(record.action, "agree");
  });
});

test("shadow mode and a keep line reserve nothing", async () => {
  await withHook({ fableRoute: true }, async ({ call, run1, ledger }) => {
    const shadow = await run1(call(), { ORCH_MODE: "shadow" });
    assert.equal(shadow.sent, null);
    assert.deepEqual(shadow.record.fable, { used: false, reason: "shadow" });

    const kept = await run1(call({}, { prompt: "Goal: find why the worker crashes.\norch-route: keep" }));
    assert.equal(kept.sent, null);
    assert.deepEqual([kept.record.action, kept.record.reason], ["pass", "keep_requested"]);
    assert.deepEqual(kept.record.fable, { used: false, reason: "keep_requested" });
    assert.equal(ledger(), 0);
  });
});

test("a route that the limit rule capped at Sonnet is not moved to Fable", async () => {
  await withHook({ fableRoute: true }, async ({ tempDir, call, run1, ledger }) => {
    // Claude usage at the gate, and Codex off: no route goes above Sonnet.
    const now = Math.floor(Date.now() / 1000);
    fs.writeFileSync(
      path.join(tempDir, "data", "limits-latest.json"),
      JSON.stringify({ ts: now, five_hour: 95, seven_day: 50, five_hour_resets_at: now + 3600, seven_day_resets_at: now + 86400, session_id: "session-1" })
    );
    const { sent, record } = await run1(call());
    assert.equal(sent.model, "sonnet");
    assert.equal(sent.effort, undefined);
    assert.equal(record.reason, "claude_tight");
    assert.equal(record.fable, undefined);
    assert.equal(ledger(), 0);
  });
});

test("a call that already names Fable is counted, and only its effort is filled in", async () => {
  await withHook({ fableRoute: true, fableWeeklyLaunches: 1 }, async ({ call, run1, ledger }) => {
    const first = await run1(call({ tool_use_id: "toolu_a" }, { model: "fable" }));
    assert.deepEqual([first.sent.model, first.sent.effort], ["fable", "medium"]);
    assert.ok(first.output.additionalContext.includes("set the model fable at the effort medium for this task"), first.output.additionalContext);
    assert.equal(ledger(), 1);

    // Above the limit the table's own answer applies, as it did before the route existed.
    const second = await run1(call({ tool_use_id: "toolu_b" }, { model: "fable" }));
    assert.equal(second.sent.model, "opus");
    assert.equal(second.record.fable.reason, "limit_reached");
  });
});

test("hooks that ask at the same time cannot take more launches than the limit", async () => {
  const tempDir = makeTempDir("orch-fable-race-");
  try {
    const dataDir = path.join(tempDir, "data");
    const script = path.join(tempDir, "ask.mjs");
    const gate = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "scripts", "lib", "fable-gate.mjs");
    fs.writeFileSync(
      script,
      `import { reserveFableLaunch } from ${JSON.stringify(gate)};\n` +
        `const answer = reserveFableLaunch({ limit: 3, sessionId: "s", toolUseId: process.argv[2] });\n` +
        `process.stdout.write(answer.ok ? "ok" : answer.reason);\n`
    );
    const { spawn } = await import("node:child_process");
    const ask = (id) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, id], { env: { PATH: process.env.PATH, ORCH_DATA_DIR: dataDir } });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("error", reject);
        child.on("close", () => resolve(out));
      });
    const answers = await Promise.all(Array.from({ length: 12 }, (_, index) => ask(`toolu_${index}`)));
    assert.equal(answers.filter((answer) => answer === "ok").length, 3, answers.join(","));
    assert.ok(answers.every((answer) => ["ok", "limit_reached", "ledger_busy"].includes(answer)), answers.join(","));
    assert.equal(fableLaunchCount({ ORCH_DATA_DIR: dataDir }), 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a call that names Fable and a level runs as written, and is still counted", async () => {
  await withHook({ fableRoute: true }, async ({ call, run1, ledger }) => {
    const { sent, record } = await run1(call({}, { model: "fable", effort: "high" }));
    assert.equal(sent, null, "nothing in the call changes");
    assert.deepEqual([record.action, record.reason], ["agree", "fable_debug"]);
    assert.equal(ledger(), 1);
  });
});

test("the variable turns the route on for one session", async () => {
  await withHook({}, async ({ call, run1 }) => {
    assert.equal((await run1(call(), { ORCH_FABLE_ROUTE: "1" })).sent.model, "fable");
  });
  await withHook({ fableRoute: true }, async ({ call, run1, ledger }) => {
    const off = await run1(call(), { ORCH_FABLE_ROUTE: "0" });
    assert.equal(off.sent, null);
    assert.equal(off.record.fable, undefined);
    assert.equal(ledger(), 0);
  });
});

test("a writer that is denied because another writer runs takes no launch", async () => {
  await withHook({ fableRoute: true }, async ({ jev, tempDir, call, run1, ledger }) => {
    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 2, selfContained: 0.1 }) };
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const implementer = { subagent_type: "subagent-router:implementer" };

    const first = await run1(call({ cwd: project, tool_use_id: "toolu_first" }, implementer));
    assert.equal(first.sent.model, "fable");
    assert.equal(ledger(), 1);

    // The first writer holds the checkout. The second call is denied before the Fable step.
    const second = await run1(call({ cwd: project, tool_use_id: "toolu_second" }, implementer));
    assert.equal(second.output.permissionDecision, "deny");
    assert.deepEqual([second.record.action, second.record.reason], ["deny", "claude_writer_busy"]);
    assert.equal(second.record.fable, undefined);
    assert.equal(ledger(), 1, "the denied call reserved nothing");
  });
});

test("a hard task sent to the Codex worker while Codex is off runs on the Claude implementer, and the route applies there", async () => {
  await withHook({ fableRoute: true }, async ({ jev, call, run1, ledger }) => {
    jev.state.reply = { body: jevBody({ kind: "implement", difficulty: 2, selfContained: 0.95 }) };
    const { sent, record } = await run1(call({}, { subagent_type: "subagent-router:codex-implementer" }));
    assert.deepEqual([sent.subagent_type, sent.model], ["subagent-router:implementer", "fable"]);
    assert.equal(record.reason, "fable_hard_needs_context");
    assert.equal(ledger(), 1);
  });
});

test("a call that the hook leaves as written because Jev is not sure takes no launch", async () => {
  await withHook({ fableRoute: true }, async ({ jev, call, run1, ledger }) => {
    jev.state.reply = { body: jevBody({ kind: "debug", confidence: 0.3, difficulty: 2 }) };
    const { sent, record } = await run1(call());
    assert.equal(sent, null);
    assert.deepEqual([record.action, record.reason], ["pass", "low_confidence"]);
    assert.equal(record.fable, undefined);
    assert.equal(ledger(), 0);
  });
});

test("the setup check reports the route: off, on with its count, a damaged record, an old lock", async () => {
  const tempDir = makeTempDir("orch-fable-setup-");
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const env = cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "", ORCH_JEV_ENABLED: "" });
    const check = async (settings) => {
      fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(settings));
      const result = await runNode("scripts/setup-check.mjs", { env });
      return result.stdout.split("\n").find((line) => line.includes("Fable route")) ?? result.stdout + result.stderr;
    };
    const ledger = path.join(dataDir, "fable-launches.json");

    assert.match(await check({}), /^OK\s+Fable route: off: no route names Fable/);

    reserveFableLaunch({ limit: 4, sessionId: "s", toolUseId: "t" }, { ORCH_DATA_DIR: dataDir });
    const on = await check({ fableRoute: true, fableWeeklyLaunches: 4, fableEffort: "low" });
    assert.match(on, /^OK\s+Fable route: on: /);
    assert.ok(on.includes("at the effort low"), on);
    assert.ok(on.includes("1 of 4 launches used in the last 7 days"), on);
    assert.ok(on.includes("limits launches, not tokens or money"), on);

    fs.writeFileSync(`${ledger}.lock`, "");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(`${ledger}.lock`, old, old);
    const locked = await check({ fableRoute: true });
    assert.match(locked, /^WARN\s+Fable route: on, but an old lock file blocks/);
    assert.ok(locked.includes(`${ledger}.lock`), locked);
    assert.ok(locked.includes("make sure that no Claude Code session is starting an agent right now"), locked);
    fs.unlinkSync(`${ledger}.lock`);

    fs.writeFileSync(ledger, "not json");
    const damaged = await check({ fableRoute: true });
    assert.match(damaged, /^WARN\s+Fable route: on, but the launch record cannot be read/);
    assert.ok(damaged.includes("removing it starts the count of the last 7 days at zero"), damaged);
    assert.match(await check({}), /^OK\s+Fable route: off/, "while the route is off, a damaged record is no warning");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
