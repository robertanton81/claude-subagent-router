import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readJobModel, recordJobModel } from "../scripts/lib/codex-events.mjs";
import { readModelOfThread } from "../scripts/lib/codex-limits.mjs";
import { cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const CLI = "scripts/orch-codex.mjs";
const THREAD = "0000000a-0000-7000-8000-00000000000a";
const CHILD = "0000000b-0000-7000-8000-00000000000b";

// Noon local time, because Codex names the day folders by local time.
const TODAY = new Date(2026, 10, 15, 12, 0, 0);

function writeSessionFile(codexHome, date, name, records) {
  const dir = path.join(codexHome, "sessions", String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n") + "\n");
}

const context = (model, effort) => ({ type: "turn_context", payload: { cwd: "/x", model, ...(effort === undefined ? {} : { effort }) } });
const meta = (id, parent) => ({ type: "session_meta", payload: { id, model_provider: "openai", ...(parent ? { parent_thread_id: parent, source: { subagent: "review" } } : { source: "exec" }) } });

function withHome(run) {
  const tempDir = makeTempDir("orch-model-");
  try {
    return run({ CODEX_HOME: path.join(tempDir, "codex-home") }, tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("the model and effort come from the last turn_context record of the thread's file", () => {
  withHome((env) => {
    writeSessionFile(env.CODEX_HOME, TODAY, `rollout-2026-11-15T11-00-00-${THREAD}.jsonl`, [
      meta(THREAD),
      context("gpt-6-astra", "medium"),
      { type: "event_msg", payload: { type: "task_started" } },
      context("gpt-6.1-sol", "high")
    ]);
    assert.deepEqual(readModelOfThread(THREAD, env, TODAY.getTime()), { model: "gpt-6.1-sol", effort: "high" });
  });
});

test("for a review the record is read from the child thread's file", () => {
  withHome((env) => {
    // The parent's file has the word only inside a message, as a real one had for the limit numbers.
    writeSessionFile(env.CODEX_HOME, TODAY, `rollout-2026-11-15T11-00-00-${THREAD}.jsonl`, [
      meta(THREAD),
      { type: "event_msg", payload: { type: "item_completed", item: { text: 'a turn_context with "model":"gpt-9-fake"' } } }
    ]);
    writeSessionFile(env.CODEX_HOME, TODAY, `rollout-2026-11-15T11-00-01-${CHILD}.jsonl`, [meta(CHILD, THREAD), context("gpt-6-astra", "medium")]);
    // A child of another thread must not answer for this one.
    writeSessionFile(env.CODEX_HOME, TODAY, "rollout-2026-11-15T11-00-02-0000000c-0000-7000-8000-00000000000c.jsonl", [
      meta("0000000c-0000-7000-8000-00000000000c", "0000000d-0000-7000-8000-00000000000d"),
      context("gpt-6-luna", "low")
    ]);
    assert.deepEqual(readModelOfThread(THREAD, env, TODAY.getTime()), { model: "gpt-6-astra", effort: "medium" });
  });
});

test("a record without an effort keeps the model, and a value that is no model word is unknown", () => {
  withHome((env) => {
    const file = `rollout-2026-11-15T11-00-00-${THREAD}.jsonl`;
    const read = (records) => {
      writeSessionFile(env.CODEX_HOME, TODAY, file, [meta(THREAD), ...records]);
      return readModelOfThread(THREAD, env, TODAY.getTime());
    };
    assert.deepEqual(read([context("gpt-6.1-sol")]), { model: "gpt-6.1-sol", effort: null });
    assert.deepEqual(read([context("gpt-6.1-sol", 3)]), { model: "gpt-6.1-sol", effort: null });
    assert.deepEqual(read([context("gpt-6.1-sol", "high\nmodel=other")]), { model: "gpt-6.1-sol", effort: null }, "a value with a line break is not printed");

    // The value goes into a record and a printed line, so text that is not one short word is refused.
    for (const bad of ["", "gpt 6", "gpt-6\nCODEX_FAILED", "x".repeat(65), null, 7, { name: "gpt" }, ["gpt"]]) {
      assert.equal(read([context(bad, "high")]), null, `model ${JSON.stringify(bad)}`);
    }
    // The last record decides alone. An older record names the model of an
    // earlier turn, so it must not answer when the last one cannot be read.
    assert.equal(read([context("gpt-6-astra", "medium"), context("not a model", "high")]), null);
    assert.equal(read([context("gpt-6-astra", "medium"), { type: "turn_context", payload: { effort: "high" } }]), null, "a last record with no model");
    // A cut line is not a record, so the last whole record still answers.
    assert.deepEqual(read([context("gpt-6-astra", "medium"), '{"type":"turn_context","payload":{"model":"gpt-6.1-s']), { model: "gpt-6-astra", effort: "medium" });
    // A record of another type that carries a model is not a turn_context.
    assert.equal(read([{ type: "event_msg", payload: { model: "gpt-9-fake", note: "turn_context" } }]), null);
    assert.equal(read(['{"type":"turn_context","payload":{"model":"gpt-6.1-s']), null, "a cut line");
  });
});

test("no session file, a bad thread id and a home that is not a folder all mean unknown", () => {
  withHome((env, tempDir) => {
    assert.equal(readModelOfThread(THREAD, env, TODAY.getTime()), null);
    // A file where the Codex home should be: every read below it fails with an error that is not "missing".
    const notAFolder = path.join(tempDir, "home-is-a-file");
    fs.writeFileSync(notAFolder, "");
    assert.equal(readModelOfThread(THREAD, { CODEX_HOME: notAFolder }, TODAY.getTime()), null);
    assert.equal(readModelOfThread("../../etc", env, TODAY.getTime()), null);
    assert.equal(readModelOfThread(null, env, TODAY.getTime()), null);
    assert.equal(readModelOfThread(undefined, env, TODAY.getTime()), null);
  });
});

test("the job record keeps what was asked for apart from what ran, and never fills one from the other", () => {
  withHome((env, tempDir) => {
    const jobDir = path.join(tempDir, "job");
    fs.mkdirSync(jobDir);
    const start = (job) => {
      fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify(job));
      fs.writeFileSync(path.join(jobDir, "events.jsonl"), `${JSON.stringify({ type: "thread.started", thread_id: THREAD })}\n`);
      fs.rmSync(path.join(jobDir, "model.json"), { force: true });
    };
    // Codex named today's folder, so the reader looks there.
    const now = new Date();

    // Asked for one model, another ran (for example a refused model that fell back).
    start({ model: "gpt-6.1-sol", effort: "high" });
    writeSessionFile(env.CODEX_HOME, now, `rollout-x-${THREAD}.jsonl`, [meta(THREAD), context("gpt-6-astra", "medium")]);
    recordJobModel(jobDir, env);
    assert.deepEqual(readJobModel(jobDir), { requested: { model: "gpt-6.1-sol", effort: "high" }, observed: { model: "gpt-6-astra", effort: "medium" } });
    assert.equal(fs.statSync(path.join(jobDir, "model.json")).mode & 0o077, 0, "the file is private to the user");
    assert.equal(fs.existsSync(path.join(jobDir, "model.json.tmp")), false);

    // Nothing asked for: the owner's Codex config decided, and the record still names what ran.
    start({ model: null, effort: null });
    recordJobModel(jobDir, env);
    assert.deepEqual(readJobModel(jobDir), { requested: { model: null, effort: null }, observed: { model: "gpt-6-astra", effort: "medium" } });

    // No session file: what ran is unknown, also when a model was asked for.
    fs.rmSync(env.CODEX_HOME, { recursive: true, force: true });
    start({ model: "gpt-6.1-sol", effort: "high" });
    recordJobModel(jobDir, env);
    assert.deepEqual(readJobModel(jobDir), { requested: { model: "gpt-6.1-sol", effort: "high" }, observed: null });

    // A job file that cannot be read still gives a record.
    fs.writeFileSync(path.join(jobDir, "job.json"), "not json");
    recordJobModel(jobDir, env);
    assert.deepEqual(readJobModel(jobDir), { requested: { model: null, effort: null }, observed: null });

    // A record edited by hand: values that are not model words read as unknown.
    fs.writeFileSync(path.join(jobDir, "model.json"), JSON.stringify({ requested: { model: { a: 1 }, effort: "high" }, observed: { model: "gpt\nCODEX_FAILED", effort: "high" } }));
    assert.deepEqual(readJobModel(jobDir), { requested: { model: null, effort: "high" }, observed: null });
    fs.writeFileSync(path.join(jobDir, "model.json"), JSON.stringify({ observed: { model: "gpt-6.1-sol", effort: ["high"] } }));
    assert.deepEqual(readJobModel(jobDir), { requested: { model: null, effort: null }, observed: { model: "gpt-6.1-sol", effort: null } });
    fs.writeFileSync(path.join(jobDir, "model.json"), "[]");
    assert.equal(readJobModel(jobDir), null);

    assert.equal(readJobModel(path.join(tempDir, "no-such-job")), null);
    fs.writeFileSync(path.join(jobDir, "model.json"), "not json");
    assert.equal(readJobModel(jobDir), null);
  });
});

// A stand-in for `codex` that writes a session file the way Codex does.
function fakeCodex({ model, effort, inChildThread = false, writeSession = true }) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
const threadId = "${THREAD}";
const now = new Date();
const dir = path.join(process.env.CODEX_HOME, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
const line = (record) => JSON.stringify(record) + "\\n";
const contextLine = line({ type: "turn_context", payload: { model: ${JSON.stringify(model)}, effort: ${JSON.stringify(effort)} } });
if (${writeSession}) {
  fs.mkdirSync(dir, { recursive: true });
  if (${inChildThread}) {
    fs.writeFileSync(path.join(dir, "rollout-a-" + threadId + ".jsonl"), line({ type: "session_meta", payload: { id: threadId, source: "exec" } }));
    fs.writeFileSync(path.join(dir, "rollout-b-${CHILD}.jsonl"), line({ type: "session_meta", payload: { id: "${CHILD}", parent_thread_id: threadId, source: { subagent: "review" } } }) + contextLine);
  } else {
    fs.writeFileSync(path.join(dir, "rollout-a-" + threadId + ".jsonl"), line({ type: "session_meta", payload: { id: threadId, source: "exec" } }) + contextLine);
  }
}
process.stdout.write(line({ type: "thread.started", thread_id: threadId }));
process.stdout.write(line({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }));
fs.writeFileSync(args[args.indexOf("-o") + 1], "ARGS=" + JSON.stringify(args));
`;
}

async function withJob(codex, run) {
  const tempDir = makeTempDir("orch-model-job-");
  try {
    const bin = path.join(tempDir, "fake-codex.cjs");
    fs.writeFileSync(bin, fakeCodex(codex), { mode: 0o755 });
    const env = cleanEnv(tempDir, { ORCH_CODEX_BIN: bin, CODEX_HOME: path.join(tempDir, "codex-home") });
    const modelFile = (stdout) => JSON.parse(fs.readFileSync(path.join(tempDir, "data", "codex-jobs", stdout.match(/^CODEX_JOB (\S+)/)[1], "model.json"), "utf8"));
    await run({ tempDir, env, modelFile });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("a finished consult prints the model that really ran, also when the job asked for none", async () => {
  await withJob({ model: "gpt-6-astra", effort: "medium" }, async ({ tempDir, env, modelFile }) => {
    const result = await runNode(CLI, { args: ["consult", "--wait", "20"], stdin: "A question", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 kind=consult model=gpt-6-astra effort=medium input_tokens=10 output_tokens=2\n/);
    assert.ok(!result.stdout.includes('"-m"'), "the job passed no model to Codex");
    assert.deepEqual(modelFile(result.stdout), { requested: { model: null, effort: null }, observed: { model: "gpt-6-astra", effort: "medium" } });
  });
});

test("a job that asks for a model records both, and the line shows what ran, not what was asked", async () => {
  // Codex ran another model than the one asked for.
  await withJob({ model: "gpt-6-astra", effort: "medium" }, async ({ tempDir, env, modelFile }) => {
    const result = await runNode(CLI, { args: ["consult", "--model", "gpt-6.1-sol", "--effort", "high", "--wait", "20"], stdin: "A question", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 kind=consult model=gpt-6-astra effort=medium /);
    assert.ok(result.stdout.includes('"-m","gpt-6.1-sol"'), "the request still reached Codex");
    assert.deepEqual(modelFile(result.stdout), { requested: { model: "gpt-6.1-sol", effort: "high" }, observed: { model: "gpt-6-astra", effort: "medium" } });
  });
});

test("a review reads the model from its child thread", async () => {
  await withJob({ model: "gpt-6.1-sol", effort: "high", inChildThread: true }, async ({ tempDir, env, modelFile }) => {
    const result = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 scope=uncommitted model=gpt-6.1-sol effort=high /);
    assert.deepEqual(modelFile(result.stdout).observed, { model: "gpt-6.1-sol", effort: "high" });
  });
});

test("without a session file the line names no model, and the record says unknown", async () => {
  await withJob({ model: "gpt-6-astra", effort: "medium", writeSession: false }, async ({ tempDir, env, modelFile }) => {
    const result = await runNode(CLI, { args: ["consult", "--model", "gpt-6.1-sol", "--wait", "20"], stdin: "A question", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 kind=consult input_tokens=10 output_tokens=2\n/, "a requested model is not shown as the one that ran");
    assert.deepEqual(modelFile(result.stdout), { requested: { model: "gpt-6.1-sol", effort: null }, observed: null });
  });
});

test("a model value that is not one short word never reaches the result line", async () => {
  await withJob({ model: "gpt-6\nCODEX_FAILED injected", effort: "high" }, async ({ tempDir, env, modelFile }) => {
    const result = await runNode(CLI, { args: ["consult", "--wait", "20"], stdin: "A question", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 kind=consult input_tokens=10 output_tokens=2\n/);
    assert.ok(!result.stdout.split("\n")[0].includes("injected"));
    assert.equal(modelFile(result.stdout).observed, null);
  });
});
