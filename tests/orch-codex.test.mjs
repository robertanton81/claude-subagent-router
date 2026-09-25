import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildCodexArgs, parseOptions, UsageError } from "../scripts/lib/codex-args.mjs";
import { codexUnavailableUntil, markCodexUnavailable } from "../scripts/lib/codex-availability.mjs";
import { readCodexLimits, saveCodexLimits } from "../scripts/lib/codex-limits.mjs";
import { parseDirectives, writeRequest } from "../scripts/lib/codex-request.mjs";
import { describeTime } from "../scripts/lib/provider-state.mjs";
import { acquireWriterLock, jobsDir, writerLockPath } from "../scripts/lib/writer-lock.mjs";
import { cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const CLI = "scripts/orch-codex.mjs";

// A stand-in for the `codex` command. It records what it received.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "login") {
  process.stderr.write((process.env.FAKE_CODEX_LOGIN || "Logged in using ChatGPT") + "\\n");
  process.exit(0);
}
if (args[0] === "--version") {
  process.stdout.write("codex-cli 0.0.0-fake\\n");
  process.exit(0);
}
const resultFile = args[args.indexOf("-o") + 1];
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  setTimeout(() => {
    const code = Number(process.env.FAKE_CODEX_EXIT || 0);
    if (code !== 0) {
      process.stderr.write("fake failure line\\n");
      process.exit(code);
    }
    process.stdout.write(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\\n");
    const keys = ["CODEX_API_KEY", "OPENAI_API_KEY"].filter((name) => process.env[name]);
    fs.writeFileSync(resultFile, "ARGS=" + JSON.stringify(args) + "\\nKEYS=" + JSON.stringify(keys) + "\\nSTDIN=" + stdin);
  }, Number(process.env.FAKE_CODEX_DELAY_MS || 0));
});
`;

function setup(extraEnv = {}) {
  const tempDir = makeTempDir();
  const bin = path.join(tempDir, "fake-codex.cjs");
  fs.writeFileSync(bin, FAKE_CODEX, { mode: 0o755 });
  return { tempDir, env: cleanEnv(tempDir, { ORCH_CODEX_BIN: bin, ...extraEnv }) };
}

async function withSetup(extraEnv, run) {
  const context = setup(extraEnv);
  try {
    await run(context);
  } finally {
    fs.rmSync(context.tempDir, { recursive: true, force: true });
  }
}

function jobIdOf(stdout) {
  return stdout.match(/^(?:STILL_RUNNING|CODEX_JOB|CODEX_FAILED) (\d{8}-\d{6}-[0-9a-f]{6})/)?.[1];
}

test("parseOptions reads the flags and rejects bad values", () => {
  const options = parseOptions(["--model", "gpt-x.1", "--effort", "high", "--base", "feature/a-b", "--wait", "5"]);
  assert.deepEqual([options.model, options.effort, options.scope, options.waitSeconds], ["gpt-x.1", "high", { type: "base", value: "feature/a-b" }, 5]);
  assert.throws(() => parseOptions(["--effort", "extreme"]), UsageError);
  assert.throws(() => parseOptions(["--model", "a; rm -rf /"]), UsageError);
  assert.throws(() => parseOptions(["--commit", "not-a-hash"]), UsageError);
  assert.throws(() => parseOptions(["--model"]), UsageError);
  assert.throws(() => parseOptions(["--surprise"]), UsageError);
});

test("buildCodexArgs builds the implement and the review command", () => {
  assert.deepEqual(buildCodexArgs({ kind: "implement", model: "m1", effort: "low" }, "/r.md"), [
    "exec", "-s", "workspace-write", "--json", "-o", "/r.md", "-m", "m1", "-c", "model_reasoning_effort=low", "-"
  ]);
  assert.deepEqual(buildCodexArgs({ kind: "review", scope: { type: "commit", value: "abc1234" }, has_brief: false }, "/r.md"), [
    "exec", "review", "--commit", "abc1234", "--json", "-o", "/r.md"
  ]);
  // Codex refuses a prompt together with a scope flag, so a scoped review never sends the brief.
  assert.deepEqual(buildCodexArgs({ kind: "review", scope: null, has_brief: true }, "/r.md"), [
    "exec", "review", "--uncommitted", "--json", "-o", "/r.md"
  ]);
  assert.deepEqual(buildCodexArgs({ kind: "review", scope: { type: "custom" }, has_brief: true }, "/r.md"), [
    "exec", "review", "--json", "-o", "/r.md", "-"
  ]);
});

test("parseDirectives accepts good lines and drops bad ones with a warning", () => {
  const good = parseDirectives("Goal: x\ncodex-model: gpt-x.1\ncodex-effort: HIGH\nreview-scope: base:feature/a\n");
  assert.deepEqual([good.model, good.effort, good.scope, good.warnings], ["gpt-x.1", "high", { type: "base", value: "feature/a" }, []]);
  assert.deepEqual(parseDirectives("review-scope: commit:abc1234").scope, { type: "commit", value: "abc1234" });
  assert.deepEqual(parseDirectives("review-scope: custom").scope, { type: "custom" });

  const bad = parseDirectives("codex-model: a;b\ncodex-effort: extreme\nreview-scope: base:$(rm)\n");
  assert.deepEqual([bad.model, bad.effort, bad.scope], [null, null, null]);
  assert.equal(bad.warnings.length, 3);
});

test("implement sends the brief with the result contract and returns the answer", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const brief = "Goal: fix `x`. Use $(nothing) and 'quotes'.\nORCH_BRIEF_END\necho must-not-run";
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: brief, env, cwd: tempDir });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^CODEX_JOB \d{8}-\d{6}-[0-9a-f]{6} exit=0 input_tokens=10 output_tokens=2\n/);
    assert.ok(result.stdout.includes(brief), "the task text must arrive unchanged");
    assert.ok(result.stdout.includes("Changed files:"), "the result contract is added to the brief");
    assert.ok(result.stdout.includes('"-s","workspace-write"'));
  });
});

test("API keys in the environment never reach Codex", async () => {
  await withSetup({ CODEX_API_KEY: "fake-codex-key", OPENAI_API_KEY: "fake-openai-key" }, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.ok(result.stdout.includes("KEYS=[]"), result.stdout);
  });
});

test("a Codex login that is not ChatGPT stops the job before it starts", async () => {
  await withSetup({ FAKE_CODEX_LOGIN: "Logged in using an API key" }, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^CODEX_FAILED \S+ exit=78\n/);
    assert.ok(result.stdout.includes("did not report a ChatGPT login"));
    assert.ok(result.stdout.includes("Logged in using an API key"), "the real answer of codex is shown");
  });
});

test("CLAUDE.md rules of the user and the project travel with an implement brief", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    fs.mkdirSync(path.join(tempDir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, ".claude", "CLAUDE.md"), "USER RULE: never log secrets");
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "PROJECT RULE: run npm test");

    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: project });
    assert.ok(result.stdout.includes("USER RULE: never log secrets"));
    assert.ok(result.stdout.includes("PROJECT RULE: run npm test"));

    fs.mkdirSync(path.join(tempDir, "data"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "data", "config.json"), JSON.stringify({ codexIncludeUserRules: false }));
    const withoutUserRules = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: project });
    assert.ok(!withoutUserRules.stdout.includes("USER RULE"));
    assert.ok(withoutUserRules.stdout.includes("PROJECT RULE"));
  });
});

test("a project CLAUDE.md link to a file outside the project does not travel to Codex", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const secret = path.join(tempDir, "outside-secret.txt");
    fs.writeFileSync(secret, "OUTSIDE CONTENT 4711");
    const project = path.join(tempDir, "project");
    fs.mkdirSync(path.join(project, ".claude"), { recursive: true });
    fs.symlinkSync(secret, path.join(project, "CLAUDE.md"));
    // A link that stays inside the project is still read.
    fs.writeFileSync(path.join(project, "rules.md"), "INSIDE RULE: keep it small");
    fs.symlinkSync(path.join(project, "rules.md"), path.join(project, ".claude", "CLAUDE.md"));

    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: project });
    assert.ok(result.stdout.startsWith("CODEX_JOB "), result.stdout);
    assert.ok(!result.stdout.includes("OUTSIDE CONTENT 4711"), "the target outside the project was sent");
    assert.ok(result.stdout.includes("INSIDE RULE: keep it small"));
    assert.ok(result.stderr.includes("points outside the project folder"), result.stderr);
  });
});

// A stand-in Codex that starts a command which ignores SIGTERM and writes its pid.
// With FAKE_CODEX_EXIT_AT_ONCE the stand-in ends at once and leaves the command running.
const FAKE_CODEX_WITH_COMMAND = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
// The command writes a ready file after its SIGTERM handler is in place, and the
// stand-in waits for that file. So a first SIGTERM can never stop the command,
// and only the SIGKILL of the runner can.
const ready = process.env.FAKE_COMMAND_PID_FILE + ".ready";
const command = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000);", ready], { stdio: "ignore" });
const deadline = Date.now() + 5000;
while (!fs.existsSync(ready) && Date.now() < deadline) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); }
fs.writeFileSync(process.env.FAKE_COMMAND_PID_FILE, String(command.pid));
fs.writeFileSync(args[args.indexOf("-o") + 1], "done");
if (process.env.FAKE_CODEX_EXIT_AT_ONCE) { process.exit(0); }
setInterval(() => {}, 1000);
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function commandPid(file) {
  for (let i = 0; i < 50 && !fs.existsSync(file); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Number(fs.readFileSync(file, "utf8"));
}

test("a cancel also stops the commands that Codex started, before the folder is free", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const pidFile = path.join(tempDir, "command.pid");
    fs.writeFileSync(env.ORCH_CODEX_BIN, FAKE_CODEX_WITH_COMMAND, { mode: 0o755 });
    const withPid = { ...env, FAKE_COMMAND_PID_FILE: pidFile };
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env: withPid, cwd: tempDir });
    const id = jobIdOf(first.stdout);
    const command = await commandPid(pidFile);
    try {
      const cancelled = await runNode(CLI, { args: ["cancel", id], env: withPid, cwd: tempDir });
      assert.ok(cancelled.stdout.startsWith(`CODEX_CANCELLED ${id}\n`), cancelled.stdout);
      assert.equal(isAlive(command), false, "the command that Codex started still runs after the cancel");
    } finally {
      if (isAlive(command)) process.kill(command, "SIGKILL");
    }
  });
});

test("a command that Codex left running is stopped before the job ends", async () => {
  await withSetup({ FAKE_CODEX_EXIT_AT_ONCE: "1" }, async ({ tempDir, env }) => {
    const pidFile = path.join(tempDir, "command.pid");
    fs.writeFileSync(env.ORCH_CODEX_BIN, FAKE_CODEX_WITH_COMMAND, { mode: 0o755 });
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env: { ...env, FAKE_COMMAND_PID_FILE: pidFile }, cwd: tempDir });
    const command = await commandPid(pidFile);
    try {
      assert.ok(result.stdout.startsWith(`CODEX_JOB `), result.stdout);
      assert.equal(isAlive(command), false, "the job ended while a command of Codex still ran");
      const stderrLog = fs.readFileSync(path.join(tempDir, "data", "codex-jobs", jobIdOf(result.stdout), "stderr.log"), "utf8");
      assert.match(stderrLog, /were still running and were stopped/);
      assert.ok(fs.existsSync(`${pidFile}.ready`), "the command had its SIGTERM handler before Codex ended");
    } finally {
      if (isAlive(command)) process.kill(command, "SIGKILL");
    }
  });
});

test("on Windows no Codex job starts, and the reason is named", async () => {
  await withSetup({ ORCH_TEST_PLATFORM: "win32" }, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /^CODEX_FAILED usage error: Codex jobs need macOS or Linux/);
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "codex-jobs")), "no job folder was made");
  });
});

test("implement without a brief is a usage error", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement"], stdin: "  \n", env, cwd: tempDir });
    assert.equal(result.code, 2);
    assert.match(result.stdout, /^CODEX_FAILED usage error/);
  });
});

test("a long job reports STILL_RUNNING, and wait returns the result later", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "1500" }, async ({ tempDir, env }) => {
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.2"], stdin: "Goal: slow task", env, cwd: tempDir });
    assert.equal(first.code, 0);
    const id = jobIdOf(first.stdout);
    assert.ok(first.stdout.startsWith(`STILL_RUNNING ${id} minutes=0\n`), first.stdout);
    assert.ok(first.stdout.includes(`wait ${id}`));

    const second = await runNode(CLI, { args: ["wait", id, "--wait", "20"], env, cwd: tempDir });
    assert.equal(second.code, 0);
    assert.ok(second.stdout.startsWith(`CODEX_JOB ${id} exit=0`));
    assert.ok(second.stdout.includes("Goal: slow task"));
  });
});

test("a cancel whose ps cannot answer stops nothing, keeps the lock and says so", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "30000" }, async ({ tempDir, env }) => {
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env, cwd: tempDir });
    const id = jobIdOf(first.stdout);
    assert.ok(id, first.stdout);
    const dir = path.join(tempDir, "data", "codex-jobs", id);
    const pids = ["runner.pid", "codex.pid"].map((name) => Number(fs.readFileSync(path.join(dir, name), "utf8")));

    // A ps that cannot look at processes, as in a sandbox or under a process limit.
    const bin = path.join(tempDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    const blind = await runNode(CLI, { args: ["cancel", id], env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` }, cwd: tempDir });
    assert.equal(blind.code, 1);
    assert.ok(blind.stdout.startsWith(`CODEX_FAILED ${id} cancel_failed\n`), blind.stdout);
    assert.ok(!fs.existsSync(path.join(dir, "exit-code")), "the job is not marked as ended");
    for (const pid of pids) {
      assert.doesNotThrow(() => process.kill(pid, 0), `the process ${pid} was not stopped`);
    }
    // Before the fix, the cancel freed the folder here, and this start became a second writer.
    const second = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: second", env, cwd: tempDir });
    assert.ok(second.stdout.includes(`writer_busy: the Codex job ${id}`), second.stdout);

    const cancelled = await runNode(CLI, { args: ["cancel", id], env, cwd: tempDir });
    assert.ok(cancelled.stdout.startsWith(`CODEX_CANCELLED ${id}\n`), cancelled.stdout);
  });
});

test("a start waits while another start removes a dead lock, and never names the job id unknown", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "30000" }, async ({ tempDir, env }) => {
    // A dead lock: its job has no runner, and the start that took it is gone.
    const deadJob = "20260923-150000-dddddd";
    fs.mkdirSync(path.join(jobsDir(env), deadJob), { recursive: true });
    const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
    assert.equal(acquireWriterLock(tempDir, deadJob, env, gone), null);
    // Another start is removing it right now: it holds the breaker.
    const breaker = `${writerLockPath(tempDir, env)}.break`;
    fs.writeFileSync(breaker, new Date().toISOString());

    // The breaker stays: the start gives up, and its message names no job.
    const refused = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: blocked", env, cwd: tempDir });
    assert.equal(refused.code, 2);
    assert.ok(refused.stdout.includes("writer_busy:") && refused.stdout.includes("cannot be named"), refused.stdout);
    assert.ok(!refused.stdout.includes("wait unknown"), refused.stdout);

    // The breaker goes away while the start waits: the start takes the folder.
    // The start waits up to 3 seconds (BREAKER_WAIT_MS, three times PS_TIMEOUT_MS),
    // and the breaker goes after 1 second. Keep that margin if either value changes.
    const waiting = runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: waits", env, cwd: tempDir });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    fs.rmSync(breaker);
    const started = await waiting;
    assert.ok(started.stdout.startsWith("STILL_RUNNING"), started.stdout);
    await runNode(CLI, { args: ["cancel", jobIdOf(started.stdout)], env, cwd: tempDir });
  });
});

test("only one Codex writer runs in a folder, and cancel frees the folder", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "30000" }, async ({ tempDir, env }) => {
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env, cwd: tempDir });
    const id = jobIdOf(first.stdout);
    assert.ok(id, first.stdout);

    const second = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: second", env, cwd: tempDir });
    assert.equal(second.code, 2);
    assert.ok(second.stdout.includes(`writer_busy: the Codex job ${id}`), second.stdout);

    // A review only reads, so the lock does not stop it.
    const review = await runNode(CLI, { args: ["review", "--wait", "0.5"], stdin: "", env, cwd: tempDir });
    assert.ok(review.stdout.startsWith("STILL_RUNNING"), review.stdout);
    await runNode(CLI, { args: ["cancel", jobIdOf(review.stdout)], env, cwd: tempDir });

    const cancelled = await runNode(CLI, { args: ["cancel", id], env, cwd: tempDir });
    assert.ok(cancelled.stdout.startsWith(`CODEX_CANCELLED ${id}\n`), cancelled.stdout);
    const afterCancel = await runNode(CLI, { args: ["wait", id, "--wait", "5"], env, cwd: tempDir });
    // The runner gets the signal, stops Codex and writes the exit code 143 itself.
    assert.match(afterCancel.stdout, new RegExp(`^CODEX_FAILED ${id} exit=143`));
    assert.ok(afterCancel.stdout.includes("received SIGTERM and stopped Codex"));

    const third = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: third", env, cwd: tempDir });
    assert.ok(third.stdout.startsWith("STILL_RUNNING"), "the folder is free again");
    await runNode(CLI, { args: ["cancel", jobIdOf(third.stdout)], env, cwd: tempDir });
  });
});

test("a runner that died without a result is reported, not waited for", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "30000" }, async ({ tempDir, env }) => {
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env, cwd: tempDir });
    const id = jobIdOf(first.stdout);
    const jobDir = path.join(tempDir, "data", "codex-jobs", id);
    const runnerPid = Number(fs.readFileSync(path.join(jobDir, "runner.pid"), "utf8"));
    const codexPid = Number(fs.readFileSync(path.join(jobDir, "codex.pid"), "utf8"));
    process.kill(runnerPid, "SIGKILL");
    process.kill(codexPid, "SIGKILL");

    const waited = await runNode(CLI, { args: ["wait", id, "--wait", "20"], env, cwd: tempDir });
    assert.equal(waited.code, 1);
    assert.ok(waited.stdout.startsWith(`CODEX_FAILED ${id} runner_died`), waited.stdout);

    // The dead job must not block the folder.
    const next = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: next", env, cwd: tempDir });
    assert.ok(next.stdout.startsWith("STILL_RUNNING"), next.stdout);
    await runNode(CLI, { args: ["cancel", jobIdOf(next.stdout)], env, cwd: tempDir });
  });
});

test("a wrong ORCH_CODEX_WAIT_SECONDS falls back to the default and does not hang", async () => {
  await withSetup({ ORCH_CODEX_WAIT_SECONDS: "oops" }, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement"], stdin: "Goal: x", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB/);
    assert.match(result.stderr, /not a number from 0 to 570/);
  });
});

test("a failed Codex run reports CODEX_FAILED with the error output", async () => {
  await withSetup({ FAKE_CODEX_EXIT: "3" }, async ({ tempDir, env }) => {
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^CODEX_FAILED \S+ exit=3\n/);
    assert.ok(result.stdout.includes("fake failure line"));
  });
});

test("a missing codex command reports CODEX_FAILED with exit 127", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const result = await runNode(CLI, {
      args: ["implement", "--wait", "20"],
      stdin: "Goal: x",
      env: { ...env, ORCH_CODEX_BIN: path.join(tempDir, "no-such-command") },
      cwd: tempDir
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^CODEX_FAILED \S+ exit=127\n/);
    assert.ok(result.stdout.includes("could not start"));
  });
});

test("a scoped review never sends the task text, and a custom review does", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const plain = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.ok(plain.stdout.includes('"exec","review","--uncommitted"'), plain.stdout);

    const scoped = await runNode(CLI, { args: ["review", "--base", "main", "--wait", "20"], stdin: "Focus on error handling.", env, cwd: tempDir });
    assert.ok(scoped.stdout.includes('"--base","main"'));
    assert.ok(!scoped.stdout.includes('"-"]'), "no stdin marker next to a scope flag");
    assert.ok(scoped.stdout.trimEnd().endsWith("STDIN="), "Codex must not get the text next to a scope flag");

    const custom = await runNode(CLI, { args: ["review", "--custom", "--wait", "20"], stdin: "Review src/a.js only.", env, cwd: tempDir });
    assert.ok(custom.stdout.includes('"exec","review","--json"'), custom.stdout);
    assert.ok(custom.stdout.includes("STDIN=Review src/a.js only."));
    assert.ok(!custom.stdout.includes("Changed files:"), "a review gets no result contract");

    const customWithoutText = await runNode(CLI, { args: ["review", "--custom"], stdin: "", env, cwd: tempDir });
    assert.equal(customWithoutText.code, 2);
    assert.match(customWithoutText.stdout, /needs the review instructions/);
  });
});

test("zero token counts are left out of the header", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    fs.writeFileSync(env.ORCH_CODEX_BIN, FAKE_CODEX.replace("input_tokens: 10, output_tokens: 2", "input_tokens: 0, output_tokens: 0"), { mode: 0o755 });
    const result = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.match(result.stdout, /^CODEX_JOB \S+ exit=0 scope=uncommitted\n/);
  });
});

test("run starts the stored request once, and a second run joins the same job", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    const { id } = writeRequest(
      { kind: "implement", prompt: "Goal: stored task\ncodex-effort: low\nORCH_BRIEF_END\n$(echo no)", cwd: project, sessionId: "s", toolUseId: "t" },
      { ORCH_DATA_DIR: env.ORCH_DATA_DIR }
    );

    const first = await runNode(CLI, { args: ["run", id, "--wait", "20"], env, cwd: tempDir });
    assert.match(first.stdout, /^CODEX_JOB/);
    assert.ok(first.stdout.includes("Goal: stored task"));
    assert.ok(first.stdout.includes('"model_reasoning_effort=low"'));

    const second = await runNode(CLI, { args: ["run", id, "--wait", "20"], env, cwd: tempDir });
    assert.equal(jobIdOf(second.stdout), jobIdOf(first.stdout), "no second Codex job for the same request");
    assert.equal(fs.readdirSync(path.join(tempDir, "data", "codex-jobs")).length, 1);
  });
});

test("run rejects an unknown id and an id with a wrong shape", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const missing = await runNode(CLI, { args: ["run", "req-0123456789ab"], env, cwd: tempDir });
    const wrongShape = await runNode(CLI, { args: ["run", "../../etc/passwd"], env, cwd: tempDir });
    assert.deepEqual([missing.code, wrongShape.code], [2, 2]);
    assert.match(missing.stdout, /there is no request/);
    assert.match(wrongShape.stdout, /needs a request id/);
  });
});

test("wait rejects a job id that does not exist or has a wrong shape", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const missing = await runNode(CLI, { args: ["wait", "20260101-000000-abcdef"], env, cwd: tempDir });
    const wrongShape = await runNode(CLI, { args: ["wait", "../../etc"], env, cwd: tempDir });
    assert.deepEqual([missing.code, wrongShape.code], [2, 2]);
    assert.match(missing.stdout, /there is no job/);
    assert.match(wrongShape.stdout, /needs a job id/);
  });
});

test("a used-up Codex plan shows the real reason and pauses Codex for the routing", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const message = "You've hit your usage limit. Visit https://example.test to purchase more credits or try again at Jan 2nd, 2099 1:25 PM.";
    // With --json, Codex reports this error as an event on stdout, not on stderr.
    fs.writeFileSync(
      env.ORCH_CODEX_BIN,
      `#!/usr/bin/env node
if (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: ${JSON.stringify(message)} } }) + "\\n");
process.stderr.write("unrelated noise from an MCP server\\n");
process.exit(1);
`,
      { mode: 0o755 }
    );
    const result = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.equal(result.code, 1);
    assert.ok(result.stdout.includes(`Codex reported: ${message}`), result.stdout);

    const { codexUnavailableUntil, retryTimeFromMessage } = await import("../scripts/lib/codex-availability.mjs");
    // The marker is older than 8 days in the future here, so the pause falls back to one hour.
    const until = codexUnavailableUntil({ ORCH_DATA_DIR: env.ORCH_DATA_DIR });
    assert.ok(until > Date.now() && until <= Date.now() + 3600 * 1000 + 5000);
    const now = Date.parse("2026-09-21T12:00:00");
    assert.equal(new Date(retryTimeFromMessage("try again at Sep 24th, 2026 1:25 PM.", now)).getDate(), 24);
  });
});

test("when only the runner dies, the job stays active because Codex still writes", async () => {
  await withSetup({ FAKE_CODEX_DELAY_MS: "30000" }, async ({ tempDir, env }) => {
    const first = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: long", env, cwd: tempDir });
    const id = jobIdOf(first.stdout);
    const jobDir = path.join(tempDir, "data", "codex-jobs", id);
    process.kill(Number(fs.readFileSync(path.join(jobDir, "runner.pid"), "utf8")), "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 300));

    const waited = await runNode(CLI, { args: ["wait", id, "--wait", "1"], env, cwd: tempDir });
    assert.ok(waited.stdout.startsWith(`STILL_RUNNING ${id}`), waited.stdout);
    assert.ok(waited.stdout.includes("Codex itself is still alive"));
    assert.ok(waited.stdout.includes(`cancel ${id}`));

    const second = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: second", env, cwd: tempDir });
    assert.ok(second.stdout.includes(`writer_busy: the Codex job ${id}`), "the folder stays locked while Codex lives");

    const cancelled = await runNode(CLI, { args: ["cancel", id], env, cwd: tempDir });
    assert.ok(cancelled.stdout.startsWith(`CODEX_CANCELLED ${id}\n`), cancelled.stdout);
    const third = await runNode(CLI, { args: ["implement", "--wait", "0.5"], stdin: "Goal: third", env, cwd: tempDir });
    assert.ok(third.stdout.startsWith("STILL_RUNNING"), third.stdout);
    await runNode(CLI, { args: ["cancel", jobIdOf(third.stdout)], env, cwd: tempDir });
  });
});

test("a stored request with a wrong line or a missing folder starts nothing", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const dataEnv = { ORCH_DATA_DIR: env.ORCH_DATA_DIR };
    assert.deepEqual(parseDirectives("review-scope: base: main").scope, { type: "base", value: "main" }, "a space after the colon is fine");
    assert.equal(parseDirectives("codex-effort: very high").warnings.length, 1);

    const wrongLine = writeRequest({ kind: "review", prompt: "Goal: review\nreview-scope: branch:main", cwd: tempDir }, dataEnv);
    const first = await runNode(CLI, { args: ["run", wrongLine.id], env, cwd: tempDir });
    assert.equal(first.code, 2);
    assert.match(first.stdout, /line that is not valid[\s\S]*review-scope/);

    const goneFolder = writeRequest({ kind: "implement", prompt: "Goal: x", cwd: path.join(tempDir, "no-such-folder") }, dataEnv);
    const second = await runNode(CLI, { args: ["run", goneFolder.id], env, cwd: tempDir });
    assert.equal(second.code, 2);
    assert.match(second.stdout, /folder of the task does not exist/);
    assert.ok(!fs.existsSync(path.join(tempDir, "data", "codex-jobs")), "no Codex job was started");
  });
});

// A stand-in that also writes a Codex session file with limit numbers.
// `windows` replaces the plan windows, for plans with a 5-hour and a weekly window.
function fakeCodexWithLimits(usedPercent, balance, windows = null) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
const threadId = "01a0c3bc-fad0-71b1-9195-d309944177b1";
const now = new Date();
const dir = path.join(process.env.CODEX_HOME, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
fs.mkdirSync(dir, { recursive: true });
const limits = { limit_id: "codex", primary: { used_percent: ${usedPercent}, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 }, ...${windows ?? "{}"}, credits: { has_credits: true, balance: "${balance}" } };
fs.writeFileSync(path.join(dir, "rollout-2026-01-01T00-00-00-" + threadId + ".jsonl"), JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: limits } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\\n");
fs.writeFileSync(args[args.indexOf("-o") + 1], "done");
`;
}

test("the limit numbers of Codex are saved after a job, and spent credits are reported", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const withHome = { ...env, CODEX_HOME: path.join(tempDir, "codex-home") };
    fs.writeFileSync(env.ORCH_CODEX_BIN, fakeCodexWithLimits(42, "500.0"), { mode: 0o755 });
    const normal = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env: withHome, cwd: tempDir });
    assert.match(normal.stdout, /^CODEX_JOB \S+ exit=0 scope=uncommitted codex_used=42%\ndone/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, "data", "codex-limits.json"), "utf8")).usedPercent, 42);

    // With the switch on, a run at 100 percent is allowed, and the output says what paid for it.
    fs.writeFileSync(path.join(tempDir, "data", "config.json"), JSON.stringify({ codexSpendCredits: true }));
    fs.writeFileSync(env.ORCH_CODEX_BIN, fakeCodexWithLimits(100, "57.8"), { mode: 0o755 });
    const paid = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env: withHome, cwd: tempDir });
    assert.ok(paid.stdout.includes("codex_used=100%"));
    assert.ok(paid.stdout.includes("paid from Codex credits. Balance now: 57.8"), paid.stdout);

    // Without the switch, the next job does not start at all.
    fs.rmSync(path.join(tempDir, "data", "config.json"));
    const refused = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env: withHome, cwd: tempDir });
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /^CODEX_FAILED \S+ exit=75\n/);
    assert.ok(refused.stdout.includes("was not started") && refused.stdout.includes("subagent-router:implementer"), refused.stdout);
  });
});

// Waits until the runner has written the exit code of a job. It watches the
// file, so the test does not depend on how fast the machine is.
async function exitCodeOf(tempDir, jobId) {
  const file = path.join(tempDir, "data", "codex-jobs", jobId, "exit-code");
  for (let waited = 0; waited < 15000; waited += 50) {
    if (fs.existsSync(file)) {
      return fs.readFileSync(file, "utf8").trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the job ${jobId} wrote no exit code`);
}

test("a job that nobody waits for still saves the Codex numbers and the usage-limit pause", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const withHome = { ...env, CODEX_HOME: path.join(tempDir, "codex-home") };
    // The stand-in ends after a short delay, so the start returns STILL_RUNNING
    // and never prints the result. Before, only the printing saved the numbers.
    const delayed = (script) => script.replace('if (args[0] === "login")', "const delayUntil = Date.now() + 400; while (Date.now() < delayUntil) {}\nif (args[0] === \"login\")");
    fs.writeFileSync(env.ORCH_CODEX_BIN, delayed(fakeCodexWithLimits(100, "12.0")), { mode: 0o755 });
    const started = await runNode(CLI, { args: ["review", "--wait", "0"], stdin: "", env: withHome, cwd: tempDir });
    assert.match(started.stdout, /^STILL_RUNNING /);
    assert.equal(await exitCodeOf(tempDir, jobIdOf(started.stdout)), "0");
    assert.equal(readCodexLimits({ ORCH_DATA_DIR: env.ORCH_DATA_DIR })?.usedPercent, 100, "the runner saved the numbers");

    const message = "You've hit your usage limit. Try again later.";
    fs.writeFileSync(
      env.ORCH_CODEX_BIN,
      `#!/usr/bin/env node
if (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: ${JSON.stringify(message)} } }) + "\\n");
  process.exit(1);
}, 400);
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(path.join(tempDir, "data", "config.json"), JSON.stringify({ codexSpendCredits: true }));
    const failing = await runNode(CLI, { args: ["review", "--wait", "0"], stdin: "", env: withHome, cwd: tempDir });
    assert.match(failing.stdout, /^STILL_RUNNING /);
    assert.equal(await exitCodeOf(tempDir, jobIdOf(failing.stdout)), "1");
    assert.ok(codexUnavailableUntil({ ORCH_DATA_DIR: env.ORCH_DATA_DIR }) > Date.now(), "the runner recorded the pause");
  });
});

test("a used-up weekly window stops the next job, also when the 5-hour window has room", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const withHome = { ...env, CODEX_HOME: path.join(tempDir, "codex-home") };
    // The shape of plans whose primary window is 5 hours and whose secondary window is the week.
    const windows = `{ primary: { used_percent: 10, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { used_percent: 100, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 86400 } }`;
    fs.writeFileSync(env.ORCH_CODEX_BIN, fakeCodexWithLimits(0, "80.0", windows), { mode: 0o755 });
    const first = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env: withHome, cwd: tempDir });
    assert.ok(first.stdout.includes("codex_used=100%"), first.stdout);
    const saved = JSON.parse(fs.readFileSync(path.join(tempDir, "data", "codex-limits.json"), "utf8"));
    assert.deepEqual([saved.usedPercent, saved.windowMinutes], [100, 10080]);

    const refused = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env: withHome, cwd: tempDir });
    assert.match(refused.stdout, /^CODEX_FAILED \S+ exit=75\n/);
  });
});

const HOUR_MS = 3600 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

// Numbers in the shape that readLimitsOfThread() returns, for a weekly window.
function weeklyNumbers(usedPercent, resetsAt) {
  return { usedPercent, windowMinutes: 10080, resetsAt, hasCredits: true, creditsBalance: 5 };
}

test("older Codex numbers do not replace newer ones", () => {
  const tempDir = makeTempDir();
  const env = { ORCH_DATA_DIR: path.join(tempDir, "data") };
  const now = Date.parse("2026-09-21T12:00:00Z");
  const resetsAt = now + 50 * HOUR_MS;
  try {
    // Jobs A and B ran side by side. B ended at 100 percent and is printed first.
    saveCodexLimits(weeklyNumbers(100, resetsAt), env, now);
    // A ended at 97 percent and is printed last. Its resets_at was read 20 seconds
    // later, and two reads of one window can differ by some seconds.
    saveCodexLimits(weeklyNumbers(97, resetsAt + 20 * 1000), env, now);
    assert.equal(readCodexLimits(env, now)?.usedPercent, 100, "a lower number of the same window is not saved");

    // A job of last week is printed again. Its window has ended, so its numbers
    // would read as "unknown", although they are not lower.
    saveCodexLimits(weeklyNumbers(100, resetsAt - WEEK_MS), env, now);
    assert.equal(readCodexLimits(env, now)?.usedPercent, 100, "numbers of an ended window are not saved");
    // A window whose reset time is exactly now has ended too, as in readCodexLimits().
    saveCodexLimits(weeklyNumbers(100, now), env, now);
    assert.equal(readCodexLimits(env, now)?.usedPercent, 100, "a window that ends exactly now counts as ended");

    // After the reset, the first job of the next window reports a lower number.
    const afterReset = resetsAt + 60 * 1000;
    saveCodexLimits(weeklyNumbers(3, afterReset + WEEK_MS), env, afterReset);
    assert.equal(readCodexLimits(env, afterReset)?.usedPercent, 3, "numbers of a later window are saved");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a used-up weekly block is not replaced by a used-up 5-hour block that ends sooner", () => {
  const tempDir = makeTempDir();
  const env = { ORCH_DATA_DIR: path.join(tempDir, "data") };
  const now = Date.parse("2026-09-21T12:00:00Z");
  try {
    saveCodexLimits(weeklyNumbers(100, now + 50 * HOUR_MS), env, now);
    // An older job is printed later: its 5-hour window was full, its week was not yet.
    saveCodexLimits({ ...weeklyNumbers(100, now + 2 * HOUR_MS), windowMinutes: 300 }, env, now);
    const afterShortReset = now + 3 * HOUR_MS;
    assert.equal(readCodexLimits(env, afterShortReset)?.usedPercent, 100, "the weekly block must still hold after the 5-hour reset");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("only a later window of the same length can lower the saved Codex percentage", () => {
  const tempDir = makeTempDir();
  const env = { ORCH_DATA_DIR: path.join(tempDir, "data") };
  const now = Date.parse("2026-09-21T12:00:00Z");
  // Saves `first` into an empty folder, then offers `second`. Returns the percentage that stays.
  const keptAfter = (first, second) => {
    fs.rmSync(env.ORCH_DATA_DIR, { recursive: true, force: true });
    saveCodexLimits(first, env, now);
    saveCodexLimits(second, env, now);
    return readCodexLimits(env, now)?.usedPercent ?? null;
  };
  try {
    // A new window started before the saved one ended, for example after an early reset.
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(3, now + WEEK_MS)), 3);
    // A reset time exactly one hour later counts as a later window. A reset time
    // a moment less than one hour later still counts as the same window.
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(40, now + 51 * HOUR_MS)), 40);
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(40, now + 51 * HOUR_MS - 1)), 90);
    // An old job of an earlier window that has not ended yet, printed after the new window was saved.
    assert.equal(keptAfter(weeklyNumbers(50, now + WEEK_MS), weeklyNumbers(40, now + 50 * HOUR_MS)), 50);
    // A window of another length, for example after a change of the plan. Its
    // later reset time does not show that its numbers are newer.
    assert.equal(keptAfter({ ...weeklyNumbers(90, now + 3 * HOUR_MS), windowMinutes: 300 }, weeklyNumbers(40, now + WEEK_MS)), 90);
    // Numbers without a reset time can raise the percentage, but not lower it.
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(40, null)), 90);
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(95, null)), 95);
    // Saved numbers without a reset time never end, so a lower number cannot replace them.
    assert.equal(keptAfter(weeklyNumbers(90, null), weeklyNumbers(40, now + WEEK_MS)), 90);
    // Numbers without a percentage would read as "unknown", so they are not saved,
    // not even from a later window.
    assert.equal(keptAfter(weeklyNumbers(90, now + 50 * HOUR_MS), weeklyNumbers(null, now + WEEK_MS)), 90);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a routing pause does not hide a used-up plan, so the runner still starts no job", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "codex-limits.json"), JSON.stringify({ usedPercent: 100, resetsAt: Date.now() + 24 * 3600 * 1000, creditsBalance: 57.8, ts: Date.now() }));
    // codexState() reports this pause before the used-up plan. The runner must still see the plan.
    fs.writeFileSync(path.join(dataDir, "codex-unavailable.json"), JSON.stringify({ until: Date.now() + 3600 * 1000 }));

    const refused = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /^CODEX_FAILED \S+ exit=75\n/);
    assert.ok(refused.stdout.includes("allowance of the ChatGPT plan is used up") && refused.stdout.includes("balance 57.8"), refused.stdout);
    const jobDir = path.join(dataDir, "codex-jobs", jobIdOf(refused.stdout));
    assert.ok(!fs.existsSync(path.join(jobDir, "codex.pid")), "only the login check may run, not the job itself");

    // With credits allowed, neither the used-up plan nor the pause stops a job.
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ codexSpendCredits: true }));
    const allowed = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env, cwd: tempDir });
    assert.match(allowed.stdout, /^CODEX_JOB \S+ exit=0/, allowed.stdout);
  });
});

test("a pause stops the runner too, and deleting the pause file ends it", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    // No plan numbers here, so the pause is the only sign that the plan is used up.
    const pauseFile = path.join(dataDir, "codex-unavailable.json");
    fs.writeFileSync(pauseFile, JSON.stringify({ until: Date.now() + 3600 * 1000 }));

    const refused = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.equal(refused.code, 1, refused.stdout);
    assert.match(refused.stdout, /^CODEX_FAILED \S+ exit=75 scope=uncommitted\n/);
    assert.ok(refused.stdout.includes("Codex is paused until") && refused.stdout.includes("codex-unavailable.json"), refused.stdout);
    const jobDir = path.join(dataDir, "codex-jobs", jobIdOf(refused.stdout));
    assert.ok(!fs.existsSync(path.join(jobDir, "codex.pid")), "only the login check may run, not the job itself");

    fs.rmSync(pauseFile);
    const afterPause = await runNode(CLI, { args: ["review", "--wait", "20"], stdin: "", env, cwd: tempDir });
    assert.match(afterPause.stdout, /^CODEX_JOB \S+ exit=0/, afterPause.stdout);
  });
});

test("the setup check reports a used-up Codex plan from either signal", async () => {
  await withSetup({}, async ({ tempDir, env }) => {
    // The setup check runs `codex` by name. The stand-in comes first on PATH, so
    // the real `codex` never runs here.
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex"), FAKE_CODEX, { mode: 0o755 });
    const checkEnv = { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` };
    // The row shows a local time, so the check must use the time zone of this test.
    if (process.env.TZ) {
      checkEnv.TZ = process.env.TZ;
    }
    const dataEnv = { ORCH_DATA_DIR: env.ORCH_DATA_DIR };
    const capacityRow = async (extraEnv = {}) => {
      const result = await runNode("scripts/setup-check.mjs", { env: { ...checkEnv, ...extraEnv }, cwd: tempDir });
      assert.match(result.stdout, /^OK +Codex CLI: codex-cli 0\.0\.0-fake$/m, "the stand-in answered, not the real codex");
      return result.stdout.split("\n").find((line) => line.includes("Codex capacity:"));
    };

    assert.equal(await capacityRow(), undefined, "no row while Codex has room");

    // The saved numbers show a used-up plan, and no job has failed.
    const resetsAt = Date.now() + 2 * 24 * 3600 * 1000;
    fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "codex-limits.json"), JSON.stringify({ usedPercent: 100, resetsAt, creditsBalance: 0, ts: Date.now() }));
    const usedUp = `WARN    Codex capacity: the saved Codex limit numbers show 100% of the weekly allowance used, and codexSpendCredits is false. Until ${describeTime(resetsAt)}`;
    assert.equal(await capacityRow(), `${usedUp}, the routing sends no tasks to Codex, and the runner starts no Codex job`);
    // Only enforce mode moves tasks. The runner checks in every mode.
    assert.equal(await capacityRow({ ORCH_MODE: "shadow" }), `${usedUp}, the runner starts no Codex job`);

    // With credits allowed, the same numbers leave Codex available.
    fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "config.json"), JSON.stringify({ codexSpendCredits: true }));
    assert.equal(await capacityRow(), undefined, "codexSpendCredits lets Codex run at 100 percent");

    // A job failed with a usage limit, and there are no saved numbers.
    fs.rmSync(path.join(env.ORCH_DATA_DIR, "config.json"));
    fs.rmSync(path.join(env.ORCH_DATA_DIR, "codex-limits.json"));
    markCodexUnavailable("You've hit your usage limit.", dataEnv);
    assert.equal(
      await capacityRow(),
      `WARN    Codex capacity: a Codex job failed with a usage limit. Until ${describeTime(codexUnavailableUntil(dataEnv))}, the routing sends no tasks to Codex, and the runner starts no Codex job unless codexSpendCredits is true`
    );
  });
});

test("with Codex off, the runner starts nothing, not even the login check", async () => {
  await withSetup({ ORCH_CODEX_ENABLED: "" }, async ({ tempDir, env }) => {
    // A login check would fail loudly, so a refusal for the login reason would show here.
    const result = await runNode(CLI, { args: ["implement", "--wait", "20"], stdin: "Goal: x", env: { ...env, FAKE_CODEX_LOGIN: "Logged in using an API key" }, cwd: tempDir });
    assert.equal(result.code, 1, result.stdout);
    assert.match(result.stdout, /^CODEX_FAILED \S+ exit=78\n/);
    assert.ok(result.stdout.includes("Codex is off") && result.stdout.includes('"codexEnabled": true'), result.stdout);
    const jobDir = path.join(tempDir, "data", "codex-jobs", jobIdOf(result.stdout));
    assert.ok(!fs.existsSync(path.join(jobDir, "codex.pid")), "Codex did not start");
  });
});

test("with Codex off, the setup check says so and does not run codex", async () => {
  await withSetup({ ORCH_CODEX_ENABLED: "" }, async ({ tempDir, env }) => {
    // `codex` on PATH fails, so a call to it would show as a MISSING row.
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const result = await runNode("scripts/setup-check.mjs", { env: { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` }, cwd: tempDir });
    assert.match(result.stdout, /^OK +Codex: off, so all work runs on Claude workers/m);
    assert.ok(!/Codex CLI|Codex login|Codex capacity/.test(result.stdout), result.stdout);
  });
});

test("the setup check says what the hook does with other agent types", async () => {
  await withSetup({ ORCH_CODEX_ENABLED: "" }, async ({ tempDir, env }) => {
    // Codex is off, so the check must not run `codex`. A stand-in that fails comes first on PATH anyway.
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const checkEnv = { ...env, PATH: `${binDir}${path.delimiter}${env.PATH}` };
    const row = async (extraEnv = {}) => {
      const result = await runNode("scripts/setup-check.mjs", { env: { ...checkEnv, ...extraEnv }, cwd: tempDir });
      return result.stdout.split("\n").find((line) => line.includes("Other agent types:"));
    };
    const routed = "OK      Other agent types: the hook can set their model, so their briefs go to TypeSafe too. Agent types it leaves alone: statusline-setup, claude-code-guide";

    assert.equal(await row(), routed, "the default: on, and only the fixed helpers of Claude Code are left alone");

    fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "config.json"), JSON.stringify({ keepModelAgents: ["spec-compliance-reviewer", "pr-review-toolkit:code-reviewer"] }));
    assert.equal(await row(), `${routed}, spec-compliance-reviewer, pr-review-toolkit:code-reviewer`);

    const off = "OK      Other agent types: they pass unchanged, because routeOtherAgents is false";
    assert.equal(await row({ ORCH_ROUTE_OTHER_AGENTS: "0" }), off);
    fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "config.json"), JSON.stringify({ routeOtherAgents: false }));
    assert.equal(await row(), off);
  });
});
