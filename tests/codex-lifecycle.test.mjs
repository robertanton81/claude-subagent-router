// Failures between the tested states of a Codex job: the moment between a start
// and its first pid file, an error after Codex has started, and a request whose
// start was refused. The Codex review of 2026-09-22 found all three.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { mock } from "node:test";

import { restoreRequest, writeRequest } from "../scripts/lib/codex-request.mjs";
import { acquireWriterLock, activeCodexWriter, jobsDir, releaseWriterLock, writerLockPath } from "../scripts/lib/writer-lock.mjs";
import { ROOT, cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const RUNNER = path.join(ROOT, "scripts", "codex-job-runner.mjs");
const CLI = "scripts/orch-codex.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The pid of a process that has ended. No process of this test has it any more.
function deadPid() {
  return spawnSync(process.execPath, ["-e", "0"]).pid;
}

async function withTemp(run) {
  const tempDir = makeTempDir();
  try {
    const project = path.join(tempDir, "project");
    fs.mkdirSync(project);
    await run({ tempDir, env: cleanEnv(tempDir), project });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function writeFakeCodex(tempDir, body) {
  const file = path.join(tempDir, "fake-codex.cjs");
  fs.writeFileSync(
    file,
    `#!/usr/bin/env node\nif (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\n${body}`,
    { mode: 0o755 }
  );
  return file;
}

test("the lock is held from the start on, before the runner has written its pid", async () => {
  await withTemp(({ tempDir, env, project }) => {
    const jobA = "20260922-100000-aaaaaa";
    const jobB = "20260922-100000-bbbbbb";
    // startJob() makes the job folder before it takes the lock, and no pid file exists yet.
    fs.mkdirSync(path.join(jobsDir(env), jobA), { recursive: true });
    fs.mkdirSync(path.join(jobsDir(env), jobB), { recursive: true });
    assert.equal(acquireWriterLock(project, jobA, env), null);

    // Job B starts in the same moment. Before the fix it took the lock as stale, and both ran.
    assert.equal(acquireWriterLock(project, jobB, env), jobA);
    assert.equal(activeCodexWriter(project, env), jobA);

    // When the process that started A is gone and A has no runner, the lock is stale, and B takes it.
    const lockDir = path.join(tempDir, "data", "locks");
    const [lockName] = fs.readdirSync(lockDir);
    const lockPath = path.join(lockDir, lockName);
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lock.starter_pid, process.pid, "the lock names the process that took it");
    fs.writeFileSync(lockPath, JSON.stringify({ ...lock, starter_pid: deadPid() }));
    assert.equal(acquireWriterLock(project, jobB, env), null);
    assert.equal(activeCodexWriter(project, env), jobB);
    assert.deepEqual(fs.readdirSync(lockDir), [lockName], "the stale lock left no file behind");

    // Just under the bound, a lock with a live starter and no runner still holds.
    // The starter of B is this process. Without this case, a wider bound would pass unseen.
    const youngLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    fs.writeFileSync(lockPath, JSON.stringify({ ...youngLock, created_at: new Date(Date.now() - 14 * 60 * 1000).toISOString() }));
    assert.equal(activeCodexWriter(project, env), jobB, "fourteen minutes is inside the bound of fifteen");

    // A starter is gone after 570 seconds at the latest. A lock that is older and
    // has no runner is stale, also when its pid is alive again in another program.
    const oldLock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    fs.writeFileSync(lockPath, JSON.stringify({ ...oldLock, starter_pid: process.pid, created_at: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
    assert.equal(activeCodexWriter(project, env), null, "a starter cannot be that old");
    assert.equal(acquireWriterLock(project, jobA, env), null);
    assert.equal(activeCodexWriter(project, env), jobA);

    // A finished job frees the folder, whatever its starter does.
    fs.writeFileSync(path.join(jobsDir(env), jobA, "exit-code"), "0");
    assert.equal(activeCodexWriter(project, env), null);
    releaseWriterLock(project, jobA, env);
    assert.deepEqual(fs.readdirSync(lockDir), []);
  });
});

test("a start that judged a lock dead does not take it from a start that recovered it first", async () => {
  await withTemp(({ tempDir, env, project }) => {
    const jobA = "20260922-100000-aaaaaa";
    const jobB = "20260922-100000-bbbbbb";
    const jobC = "20260922-100000-cccccc";
    for (const job of [jobA, jobB, jobC]) {
      fs.mkdirSync(path.join(jobsDir(env), job), { recursive: true });
    }
    // A dead lock: the job has no runner and the start that took it is gone.
    assert.equal(acquireWriterLock(project, jobA, env, deadPid()), null);
    const lockDir = path.join(tempDir, "data", "locks");
    const [lockName] = fs.readdirSync(lockDir);
    const lockPath = path.join(lockDir, lockName);

    // The moment that used to leave two writers. The injection hangs on the read
    // of the lock itself, the step both the old and the new code take before
    // they break a lock they judged dead, so this test does not depend on how
    // breaking is done. B reads A's dead lock; in that instant C breaks it and
    // takes the checkout for a living job of its own. Nothing is forced to
    // fail: every filesystem call succeeds, as it would in a real race.
    const realRead = fs.readFileSync.bind(fs);
    let injected = false;
    const read = mock.method(fs, "readFileSync", (target, ...rest) => {
      const data = realRead(target, ...rest);
      if (!injected && String(target) === lockPath) {
        injected = true;
        fs.writeFileSync(path.join(jobsDir(env), jobC, "runner.pid"), String(process.pid));
        fs.rmSync(lockPath, { force: true });
        fs.writeFileSync(`${lockPath}.byC`, JSON.stringify({ job_id: jobC, cwd: project, starter_pid: process.pid, created_at: new Date().toISOString() }));
        fs.linkSync(`${lockPath}.byC`, lockPath);
        fs.rmSync(`${lockPath}.byC`, { force: true });
      }
      return data;
    });
    try {
      assert.equal(acquireWriterLock(project, jobB, env), jobC, "B must be told that C holds the checkout");
      assert.ok(injected, "the race was really played");
    } finally {
      read.mock.restore();
    }
    assert.equal(activeCodexWriter(project, env), jobC, "C still holds the checkout it took");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).job_id, jobC, "C's lock is the one on disk");
    assert.deepEqual(fs.readdirSync(lockDir), [lockName], "no leftover file from the attempt");
  });
});

test("a job that gives back its lock cannot delete the lock that a new start has just taken", async () => {
  await withTemp(({ tempDir, env, project }) => {
    const jobA = "20260923-140000-aaaaaa";
    const jobC = "20260923-140000-cccccc";
    for (const job of [jobA, jobC]) {
      fs.mkdirSync(path.join(jobsDir(env), job), { recursive: true });
    }
    assert.equal(acquireWriterLock(project, jobA, env, deadPid()), null);
    // A has ended: the runner wrote the exit code and now gives back the lock.
    fs.writeFileSync(path.join(jobsDir(env), jobA, "exit-code"), "0");
    const lockDir = path.join(tempDir, "data", "locks");
    const lockPath = writerLockPath(project, env);

    // The moment of the race: A's runner has read its own lock and is about to
    // remove it. In that instant a new start C finds A's lock dead and tries to
    // break it and take the folder. Before the fix, C broke it, linked its own
    // lock, and A's removal then deleted C's lock while C went on as the writer.
    const realRead = fs.readFileSync.bind(fs);
    let injected = false;
    let heldByC;
    const read = mock.method(fs, "readFileSync", (target, ...rest) => {
      const data = realRead(target, ...rest);
      if (!injected && String(target) === lockPath) {
        injected = true;
        heldByC = acquireWriterLock(project, jobC, env) === null;
      }
      return data;
    });
    try {
      releaseWriterLock(project, jobA, env);
      assert.ok(injected, "the race was really played");
    } finally {
      read.mock.restore();
    }
    // With the fix, A holds the breaker while it looks and removes, so C cannot
    // win and only the else branch runs. The first branch is kept on purpose:
    // it is the one that fails when the release loses the breaker again.
    if (heldByC) {
      assert.equal(activeCodexWriter(project, env), jobC, "C believes that it holds the folder, so its lock must be on disk");
    } else {
      assert.deepEqual(fs.readdirSync(lockDir), [], "C was told to wait, and A's lock is gone");
      assert.equal(acquireWriterLock(project, jobC, env), null, "C takes the folder on its next try");
    }
    assert.equal(activeCodexWriter(project, env), jobC);
  });
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

test("an error after the start of Codex stops Codex before the job ends, and frees the lock only then", async () => {
  await withTemp(async ({ tempDir, env, project }) => {
    // This Codex writes its pid as its first act and then works for 30 seconds.
    // The runner stops it within a millisecond of the start, so the pid file
    // appears only when the stop came too late for that, as with a real Codex
    // that has work to finish.
    const pidFile = path.join(project, "codex-alive.pid");
    const fakeCodex = writeFakeCodex(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);
    const jobId = "20260922-110000-cccccc";
    const jobDir = path.join(jobsDir(env), jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "job.json"), JSON.stringify({ id: jobId, kind: "implement", cwd: project, has_brief: true, created_at: new Date().toISOString() }));
    fs.writeFileSync(path.join(jobDir, "brief.md"), "Goal: x");
    // A folder where codex.pid should be makes the write after the start fail.
    // This is the reproduction of the review.
    fs.mkdirSync(path.join(jobDir, "codex.pid"));
    assert.equal(acquireWriterLock(project, jobId, env), null);

    const runner = spawn(process.execPath, [RUNNER, jobDir], { env: { ...env, ORCH_CODEX_BIN: fakeCodex }, stdio: "ignore" });
    const runnerEnded = new Promise((resolve) => runner.on("exit", resolve));
    const codexPid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null);
    try {
      await Promise.race([runnerEnded, sleep(15000).then(() => assert.fail("the runner did not end"))]);
      const exitMarker = path.join(jobDir, "exit-code");
      assert.equal(fs.readFileSync(exitMarker, "utf8").trim(), "126");
      assert.match(fs.readFileSync(path.join(jobDir, "stderr.log"), "utf8"), /codex\.pid could not be written, so Codex was stopped/);
      // Before the fix, the runner wrote the exit code and left Codex running for its 30 seconds.
      await sleep(200);
      const pid = codexPid();
      assert.ok(pid === null || !isAlive(pid), `Codex (pid ${pid}) must be dead when the job has ended`);
      assert.equal(activeCodexWriter(project, env), null, "the lock is free once the job has ended");
      assert.ok(fs.statSync(path.join(jobDir, "codex.pid")).isDirectory(), "the runner did not replace the folder");
    } finally {
      const pid = codexPid();
      if (pid && isAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
});

test("a Codex that runs past max_run_minutes is stopped, the job ends with 124, and the lock is free", async () => {
  await withTemp(async ({ tempDir, env, project }) => {
    // This Codex hangs: it writes its pid and then waits for 30 seconds.
    const pidFile = path.join(project, "codex-alive.pid");
    const fakeCodex = writeFakeCodex(tempDir, `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);
    const jobId = "20260923-110000-dddddd";
    const jobDir = path.join(jobsDir(env), jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    // 0.02 minutes is 1.2 seconds.
    fs.writeFileSync(
      path.join(jobDir, "job.json"),
      JSON.stringify({ id: jobId, kind: "implement", cwd: project, has_brief: true, max_run_minutes: 0.02, created_at: new Date().toISOString() })
    );
    fs.writeFileSync(path.join(jobDir, "brief.md"), "Goal: x");
    assert.equal(acquireWriterLock(project, jobId, env), null);

    const started = Date.now();
    const runner = spawn(process.execPath, [RUNNER, jobDir], { env: { ...env, ORCH_CODEX_BIN: fakeCodex }, stdio: "ignore" });
    const runnerEnded = new Promise((resolve) => runner.on("exit", resolve));
    const codexPid = () => (fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, "utf8")) : null);
    try {
      await Promise.race([runnerEnded, sleep(15000).then(() => assert.fail("the runner did not stop the hung Codex"))]);
      assert.ok(Date.now() - started >= 1000, "the runner must not stop Codex before the limit");
      assert.equal(fs.readFileSync(path.join(jobDir, "exit-code"), "utf8").trim(), "124");
      assert.match(fs.readFileSync(path.join(jobDir, "stderr.log"), "utf8"), /Codex ran longer than 0\.02 minutes and was stopped/);
      const pid = codexPid();
      assert.ok(pid !== null, "Codex had started");
      await sleep(200);
      assert.ok(!isAlive(pid), `Codex (pid ${pid}) must be dead when the job has ended`);
      assert.equal(activeCodexWriter(project, env), null, "the lock is free once the job has ended");
    } finally {
      const pid = codexPid();
      if (pid && isAlive(pid)) {
        process.kill(pid, "SIGKILL");
      }
    }
  });
});

test("a request whose start a busy writer refused can run after that writer has ended", async () => {
  await withTemp(async ({ tempDir, env, project }) => {
    const fakeCodex = writeFakeCodex(
      tempDir,
      'const fs = require("node:fs");\nconst args = process.argv.slice(2);\nlet stdin = "";\nprocess.stdin.on("data", (c) => (stdin += c));\nprocess.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("-o") + 1], "done"));\n'
    );
    const codexEnv = { ...env, ORCH_CODEX_BIN: fakeCodex };
    const { id } = writeRequest({ kind: "implement", prompt: "Goal: x", cwd: project, sessionId: "s", toolUseId: "t" }, env);
    const requests = path.join(tempDir, "data", "codex-requests");

    // Another job still writes in the folder. Its fresh lock names this test process
    // as the starter, which holds the folder; the runner.pid below does not count,
    // because this process's command line does not name the job.
    const holder = "20260922-120000-dddddd";
    fs.mkdirSync(path.join(jobsDir(env), holder), { recursive: true });
    assert.equal(acquireWriterLock(project, holder, env), null);
    fs.writeFileSync(path.join(jobsDir(env), holder, "runner.pid"), String(process.pid));

    const refused = await runNode(CLI, { args: ["run", id, "--wait", "20"], env: codexEnv, cwd: project });
    assert.equal(refused.code, 2, refused.stdout);
    assert.match(refused.stdout, /writer_busy/);
    assert.ok(fs.existsSync(path.join(requests, `${id}.json`)), "the request is stored again after the refusal");
    assert.ok(!fs.existsSync(path.join(requests, `${id}.claimed.json`)));

    // The holder ends. Before the fix, the next run failed with "no job was recorded".
    fs.writeFileSync(path.join(jobsDir(env), holder, "exit-code"), "0");
    const started = await runNode(CLI, { args: ["run", id, "--wait", "20"], env: codexEnv, cwd: project });
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, /^CODEX_JOB (\S+) exit=0/);
    const jobId = started.stdout.match(/^CODEX_JOB (\S+)/)[1];
    assert.equal(fs.readFileSync(path.join(requests, `${id}.job`), "utf8"), jobId);

    // Everything that holds the brief or the result is private to this user.
    const mode = (file) => fs.statSync(file).mode & 0o777;
    const jobDir = path.join(jobsDir(env), jobId);
    assert.deepEqual([mode(jobsDir(env)), mode(jobDir), mode(requests)], [0o700, 0o700, 0o700]);
    for (const name of ["job.json", "brief.md", "events.jsonl", "stderr.log", "runner.log", "runner.pid", "codex.pid", "result.md"]) {
      assert.equal(mode(path.join(jobDir, name)), 0o600, name);
    }
    assert.equal(mode(path.join(requests, `${id}.job`)), 0o600);

    // A later run of the same request finds that job and starts no second one.
    const again = await runNode(CLI, { args: ["run", id, "--wait", "20"], env: codexEnv, cwd: project });
    assert.match(again.stdout, new RegExp(`^CODEX_JOB ${jobId} `));
    assert.equal(fs.readdirSync(jobsDir(env)).filter((name) => name !== holder).length, 1);
    // A recorded job is never given back.
    assert.equal(restoreRequest(id, env), false);
  });
});

test("a job whose id cannot be recorded for its request still runs, and the request starts no second job", async () => {
  await withTemp(async ({ tempDir, env, project }) => {
    const fakeCodex = writeFakeCodex(
      tempDir,
      'const fs = require("node:fs");\nconst args = process.argv.slice(2);\nlet stdin = "";\nprocess.stdin.on("data", (c) => (stdin += c));\nprocess.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("-o") + 1], "done"));\n'
    );
    const codexEnv = { ...env, ORCH_CODEX_BIN: fakeCodex };
    const { id } = writeRequest({ kind: "implement", prompt: "Goal: x", cwd: project, sessionId: "s", toolUseId: "t" }, env);
    const requests = path.join(tempDir, "data", "codex-requests");
    // A folder where the job record should be makes that write fail.
    fs.mkdirSync(path.join(requests, `${id}.job`));

    const started = await runNode(CLI, { args: ["run", id, "--wait", "20"], env: codexEnv, cwd: project });
    assert.equal(started.code, 0, started.stdout);
    assert.match(started.stdout, /^CODEX_JOB \S+ exit=0/);
    assert.match(started.stderr, new RegExp(`could not be recorded for the request ${id}`));
    assert.ok(fs.existsSync(path.join(requests, `${id}.claimed.json`)), "the request stays claimed, because its job runs");

    // A later run finds a job record that it cannot read and gives up. It starts no second job.
    const again = await runNode(CLI, { args: ["run", id, "--wait", "20"], env: codexEnv, cwd: project });
    assert.equal(again.code, 2);
    assert.match(again.stdout, /job record that cannot be read/);
    assert.equal(fs.readdirSync(jobsDir(env)).length, 1);
  });
});

test("restoreRequest gives back only a claimed request without a job", async () => {
  await withTemp(({ tempDir, env, project }) => {
    const requests = path.join(tempDir, "data", "codex-requests");
    const { id } = writeRequest({ kind: "review", prompt: "Goal: review", cwd: project, sessionId: "s", toolUseId: "t" }, env);
    assert.equal(restoreRequest(id, env), false, "a stored request is not claimed, so there is nothing to give back");
    fs.renameSync(path.join(requests, `${id}.json`), path.join(requests, `${id}.claimed.json`));
    assert.equal(restoreRequest(id, env), true);
    assert.ok(fs.existsSync(path.join(requests, `${id}.json`)));
    assert.equal(restoreRequest("req-000000000000", env), false, "an unknown request is no error");
  });
});

// A lock that exists but cannot be read used to mean "nobody holds this", so a
// lock caught between its creation and its content was taken from the job that
// was writing it: two writers in one checkout. Locks are now linked into place
// whole, and an unreadable one is treated as held while it is young.
test("a lock that cannot be read is not taken from its owner, but does not block for ever", () => {
  const tempDir = makeTempDir();
  try {
    const env = cleanEnv(tempDir);
    const cwd = tempDir;
    const jobDir = path.join(jobsDir(env), "jobA");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, "runner.pid"), String(process.pid));
    assert.equal(acquireWriterLock(cwd, "jobA", env), null);

    const locks = path.join(tempDir, "data", "locks");
    const lockPath = path.join(locks, fs.readdirSync(locks).find((name) => name.endsWith(".json")));

    // The state another process would see mid-write: the file is there, its
    // content is not. The checkout must stay taken.
    fs.writeFileSync(lockPath, "");
    assert.equal(acquireWriterLock(cwd, "jobB", env), "unknown", "a lock being written is not a free lock");
    assert.equal(activeCodexWriter(cwd, env), "unknown", "the checkout still counts as busy");

    // Half a written record, which is the same situation.
    fs.writeFileSync(lockPath, '{"job_id": "jobA", "starter');
    assert.equal(acquireWriterLock(cwd, "jobB", env), "unknown");

    // A damaged lock older than any starter can live is recovered, so a broken
    // file cannot hold the checkout for good.
    const longAgo = (Date.now() - 20 * 60 * 1000) / 1000;
    fs.utimesSync(lockPath, longAgo, longAgo);
    assert.equal(acquireWriterLock(cwd, "jobB", env), null, "an old damaged lock is taken over");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).job_id, "jobB");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// A process that stands in for a runner or for Codex: it lives until killed, and
// its command line holds `marker`, as the real ones hold the job folder.
function startStandIn(marker) {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" });
}

test("a pid that a later program reuses does not hold the folder; the real runner and Codex do", async () => {
  await withTemp(async ({ env, project }) => {
    const jobId = "20260923-130000-eeeeee";
    const jobDir = path.join(jobsDir(env), jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    // The start that took the lock is gone, so only the runner and Codex can hold it.
    assert.equal(acquireWriterLock(project, jobId, env, deadPid()), null);

    // The runner and Codex were killed with SIGKILL, so there is no exit code, and
    // their pids now belong to other programs: here, this test process.
    fs.writeFileSync(path.join(jobDir, "runner.pid"), String(process.pid));
    fs.writeFileSync(path.join(jobDir, "codex.pid"), String(process.pid));
    assert.equal(activeCodexWriter(project, env), null, "a reused pid must not hold the folder");

    const runner = startStandIn(jobDir);
    const codex = startStandIn(path.join(jobDir, "result.md"));
    try {
      await new Promise((resolve) => setTimeout(resolve, 200));
      // The live runner holds the folder.
      fs.writeFileSync(path.join(jobDir, "runner.pid"), String(runner.pid));
      assert.equal(activeCodexWriter(project, env), jobId);
      // Codex that outlived its runner holds it too.
      fs.writeFileSync(path.join(jobDir, "runner.pid"), String(process.pid));
      fs.writeFileSync(path.join(jobDir, "codex.pid"), String(codex.pid));
      assert.equal(activeCodexWriter(project, env), jobId);
      // The runner's command line does not count as Codex's: it has no result.md.
      fs.writeFileSync(path.join(jobDir, "codex.pid"), String(runner.pid));
      assert.equal(activeCodexWriter(project, env), null);
    } finally {
      runner.kill("SIGKILL");
      codex.kill("SIGKILL");
    }
  });
});

test("a ps that fails counts the pid as alive, so the folder stays held", async () => {
  await withTemp(async ({ tempDir, env, project }) => {
    const jobId = "20260923-130000-ffffff";
    const jobDir = path.join(jobsDir(env), jobId);
    fs.mkdirSync(jobDir, { recursive: true });
    assert.equal(acquireWriterLock(project, jobId, env, deadPid()), null);
    fs.writeFileSync(path.join(jobDir, "runner.pid"), String(process.pid));

    // A ps that cannot look at processes, as in a sandbox.
    const bin = path.join(tempDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "ps"), '#!/bin/sh\necho "ps: operation not permitted" >&2\nexit 1\n', { mode: 0o755 });
    const realPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${realPath}`;
    try {
      assert.equal(activeCodexWriter(project, env), jobId);
    } finally {
      process.env.PATH = realPath;
    }
    // With the real ps the same pid is seen as another program's.
    assert.equal(activeCodexWriter(project, env), null);
  });
});
