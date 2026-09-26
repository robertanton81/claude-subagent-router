import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { boundaryCommand, checkBoundary, gradingEnvironment, nodeRuntimeDirectory, wrapInvocation } from "../scripts/lib/execution-boundary.mjs";
import { loadVerification, prepareVerification, snapshotTree, verifyWorkspace } from "../scripts/lib/executable-grade.mjs";
import { exportWorkspace, gradeRecord, loadTaskSet, makeRecord, runOne } from "../scripts/lib/eval.mjs";
import { cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

function unavailable(error, t) {
  if (process.env.ORCH_TEST_REQUIRE_BOUNDARY === "1") throw error;
  assert.match(error.message, /execution boundary .* unavailable|needs bubblewrap|no execution boundary/);
  t.diagnostic("Boundary unavailable. Required integration coverage is npm run test:boundaries on a capable host.");
}

function fixture() {
  const root = fs.realpathSync(makeTempDir("orch-grade-"));
  const workspace = path.join(root, "workspace");
  const data = path.join(root, "data");
  fs.mkdirSync(workspace);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(workspace, "answer.txt"), "wrong");
  const script = path.join(root, "check.mjs");
  fs.writeFileSync(script, `import fs from 'node:fs'; import assert from 'node:assert/strict'; import path from 'node:path';
assert.equal(fs.readFileSync(path.join(process.argv[2], 'answer.txt'), 'utf8'), 'right');\n`);
  return { root, workspace, data, script, task: { verify: loadVerification({ script }, root, workspace) } };
}

test("executable grading rejects unsafe definitions and fingerprints file content, mode and additions", () => {
  const f = fixture();
  try {
    assert.throws(() => loadVerification({ script: "workspace/answer.txt" }, f.root, f.workspace), /external .mjs/);
    fs.writeFileSync(path.join(f.workspace, "check.mjs"), "");
    assert.throws(() => loadVerification({ script: "workspace/check.mjs" }, f.root, f.workspace), /outside/);
    assert.throws(() => loadVerification({ script: f.script, timeoutS: 0 }, f.root, f.workspace), /timeoutS/);
    const before = snapshotTree(f.workspace);
    fs.writeFileSync(path.join(f.workspace, "answer.txt"), "right");
    assert.notEqual(snapshotTree(f.workspace), before);
    const after = snapshotTree(f.workspace);
    fs.writeFileSync(path.join(f.workspace, "added.txt"), "new");
    assert.notEqual(snapshotTree(f.workspace), after);
    fs.unlinkSync(path.join(f.workspace, "added.txt"));
    fs.chmodSync(path.join(f.workspace, "answer.txt"), 0o700);
    assert.notEqual(snapshotTree(f.workspace), after);
    fs.symlinkSync(f.script, path.join(f.workspace, "escape"));
    assert.throws(() => snapshotTree(f.workspace), /link or special/);
    const taskFile = path.join(f.root, "tasks.json");
    fs.writeFileSync(taskFile, JSON.stringify({ tasks: [{ name: "edit", prompt: "edit", cwd: f.workspace, verify: { script: f.script } }] }));
    assert.throws(() => loadTaskSet(taskFile), /requires export/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unsupported boundaries fail closed and grading drops inherited credentials and runtime injection", () => {
  assert.throws(() => boundaryCommand([process.execPath], { platform: "unsupported" }), /no execution boundary/);
  assert.deepEqual(gradingEnvironment("/scratch", { PATH: "/bin", SECRET: "test-key-not-a-secret", NODE_OPTIONS: "--require=hostile", HOME: "/real" }),
    { PATH: "/bin", HOME: "/scratch", TMPDIR: "/scratch", TMP: "/scratch", TEMP: "/scratch", LANG: "C", LC_ALL: "C" });
});

test("real OS boundary protects grading assets; unavailable boundaries refuse before any worker", async (t) => {
  const f = fixture();
  try {
    let prepared;
    try { prepared = prepareVerification(f.task, f.root, f.workspace, f.data); }
    catch (error) {
      unavailable(error, t);
      return;
    }
    const outside = path.join(f.root, "outside.txt");
    fs.writeFileSync(outside, "protected");
    // Controls created after this worker's policy must also stay hidden.
    const prior = path.join(f.root, "verification", "prior");
    fs.mkdirSync(prior);
    const priorScript = path.join(prior, "grader.mjs");
    fs.copyFileSync(f.script, priorScript);
    const attempt = `const fs=require('node:fs');
      for (const p of ${JSON.stringify([outside, prepared.script])}) {
        try { fs.writeFileSync(p, 'tampered'); process.exit(8); } catch(e) {
          if (e.code === 'ENOENT' && p === ${JSON.stringify(prepared.script)}) continue; // Linux hides this directory.
          if (!['EPERM','EACCES','EROFS'].includes(e.code)) throw e;
        }
      }
      fs.writeFileSync('answer.txt', 'right'); fs.chmodSync('answer.txt', 0o664);
      for (const p of ${JSON.stringify([f.script, prepared.script, priorScript])}) {
        let text = ''; try { text = fs.readFileSync(p, 'utf8'); } catch(e) { if (!['EPERM','EACCES','ENOENT'].includes(e.code)) throw e; }
        if (text.includes('assert.equal')) process.exit(11);
      }`;
    const invocation = wrapInvocation({ argv: [process.execPath, "-e", attempt], cwd: f.workspace, env: cleanEnv(f.root, { NODE_OPTIONS: "" }) }, prepared.workerOptions);
    const attemptResult = await runOne(invocation, { timeoutMs: 5000 });
    assert.equal(attemptResult.code, 0, attemptResult.stderr);
    assert.equal(fs.readFileSync(outside, "utf8"), "protected");
    assert.equal(fs.readFileSync(prepared.script, "utf8"), fs.readFileSync(f.script, "utf8"));
    assert.equal(fs.readFileSync(path.join(f.workspace, "answer.txt"), "utf8"), "right");
    const evidence = await verifyWorkspace(f.task, f.workspace, prepared, async (...args) => {
      const result = await runOne(...args);
      if (result.code !== 0) t.diagnostic(result.stderr);
      return result;
    });
    assert.equal(evidence.status, "passed", JSON.stringify(evidence));
    const record = { cwd: f.workspace, result: "tests failed", verification: evidence };
    assert.equal(gradeRecord(record, f.task).pass, true);
    fs.writeFileSync(path.join(f.workspace, "answer.txt"), "wrong");
    assert.equal(gradeRecord(record, f.task).pass, false, "a later edit invalidates the passing evidence");
    assert.equal(gradeRecord({ ...record, verification: undefined, result: "tests passed" }, f.task).pass, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("real grader cannot read outside its roots or change the code it grades", async (t) => {
  const f = fixture();
  let server;
  try {
    const options = { writable: [f.data], readable: [f.workspace, nodeRuntimeDirectory()], network: false };
    try { checkBoundary(options, f.data); }
    catch (error) {
      unavailable(error, t);
      return;
    }
    server = net.createServer((socket) => socket.end());
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const attempt = `const fs=require('node:fs');
      try { fs.readFileSync(${JSON.stringify(f.script)}); process.exit(7); } catch(e) { if (!['ENOENT','EPERM','EACCES'].includes(e.code)) throw e; }
      try { fs.writeFileSync('answer.txt', 'right'); process.exit(8); } catch(e) { if (!['EPERM','EACCES','EROFS'].includes(e.code)) throw e; }
      const net=require('node:net'); const s=net.connect(${server.address().port},'127.0.0.1'); s.on('connect',()=>process.exit(9));
      s.on('error', e=> { if (!['EPERM','EACCES','ENETUNREACH','ECONNREFUSED'].includes(e.code)) process.exit(10); });`;
    const invocation = wrapInvocation({ argv: [process.execPath, "-e", attempt], cwd: f.workspace, env: gradingEnvironment(f.data) }, options);
    const result = await runOne(invocation, { timeoutMs: 5000 });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.workspace, "answer.txt"), "utf8"), "wrong");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("grader timeout is a failure and replacing its script invalidates old evidence", async (t) => {
  const f = fixture();
  try {
    fs.writeFileSync(f.script, "setInterval(() => {}, 1000);\n");
    f.task.verify = loadVerification({ script: f.script, timeoutS: 0.2 }, f.root, f.workspace);
    let prepared;
    try { prepared = prepareVerification(f.task, f.root, f.workspace, f.data); }
    catch (error) {
      unavailable(error, t);
      return;
    }
    const evidence = await verifyWorkspace(f.task, f.workspace, prepared, runOne);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.timed_out, true);
    assert.equal(gradeRecord({ cwd: f.workspace, verification: evidence }, f.task).pass, false);
    fs.writeFileSync(f.script, "process.exit(0);\n");
    const task = { verify: loadVerification({ script: f.script, timeoutS: 0.2 }, f.root, f.workspace) };
    assert.match(gradeRecord({ cwd: f.workspace, verification: evidence }, task).graders[0].detail, /mismatched/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("executable evaluation CLI grades the code despite a false passing report and protects the source", async (t) => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q", f.workspace]);
    execFileSync("git", ["-C", f.workspace, "add", "."]);
    execFileSync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
    const fake = path.join(f.root, "claude");
    fs.writeFileSync(fake, `#!${process.execPath}
const fs=require('node:fs');
// A later worker must not see the prior run's old control location either.
let previous=''; try { previous=fs.readFileSync(${JSON.stringify(path.join(f.root, "out/edit/off/run-1/verification/grader.mjs"))},'utf8'); } catch(e) { if (!['EPERM','EACCES','ENOENT'].includes(e.code)) throw e; }
if (previous.includes('assert.equal')) process.exit(13);
let entries=[]; try { entries=fs.readdirSync(${JSON.stringify(path.join(f.root, "out/verification"))}); } catch(e) { if (!['EPERM','EACCES'].includes(e.code)) throw e; }
if (entries.length) process.exit(14);
fs.writeFileSync('answer.txt', 'still wrong');
process.stdout.write(JSON.stringify({result:'tests passed',is_error:false,total_cost_usd:0}));\n`, { mode: 0o700 });
    const taskFile = path.join(f.root, "tasks.json");
    fs.writeFileSync(taskFile, JSON.stringify({ tasks: [{ name: "edit", prompt: "fix", cwd: f.workspace, export: true, verify: { script: f.script } }] }));
    const out = path.join(f.root, "out");
    const result = await runNode("scripts/orch-eval.mjs", { args: [taskFile, "--arms", "off", "--runs", "2", "--out", out], env: cleanEnv(f.root, { ORCH_EVAL_CLAUDE_BIN: fake }) });
    assert.equal(result.code, 1);
    const recordsFile = path.join(out, "runs.jsonl");
    if (!fs.existsSync(recordsFile)) {
      if (process.env.ORCH_TEST_REQUIRE_BOUNDARY === "1") assert.fail(result.stderr);
      assert.match(result.stderr, /execution boundary .* unavailable|needs bubblewrap|no execution boundary/);
      assert.doesNotMatch(result.stderr, /: started/);
      t.diagnostic("CLI refused before worker launch because the host boundary is unavailable.");
      return;
    }
    const records = fs.readFileSync(recordsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((item) => [item.exit_code, item.is_error, item.timed_out, item.result]),
      [[0, false, false, "tests passed"], [0, false, false, "tests passed"]]);
    const record = records[0];
    const originalRevision = execFileSync("git", ["-C", f.workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.equal(record.source_revision, originalRevision);
    assert.equal(record.exit_code, 0);
    assert.equal(record.is_error, false);
    assert.equal(record.timed_out, false);
    assert.equal(record.result, "tests passed");
    assert.equal(fs.readFileSync(path.join(record.cwd, "answer.txt"), "utf8"), "still wrong");
    assert.equal(record.verification.status, "failed");
    assert.equal(record.verification.exit_code, 1);
    const summary = JSON.parse(fs.readFileSync(path.join(out, "summary.json"), "utf8"));
    assert.equal(summary.tasks.edit.off.passed, 0);
    assert.equal(summary.tasks.edit.off.failed_graders.executable, 2);
    assert.equal(fs.readFileSync(path.join(f.workspace, "answer.txt"), "utf8"), "wrong");
    const regrade = await runNode("scripts/orch-eval.mjs", { args: [taskFile, "--regrade", out], env: cleanEnv(f.root, { ORCH_EVAL_CLAUDE_BIN: "/not/a/command" }) });
    assert.equal(regrade.code, 0);
    assert.match(regrade.stdout, /Nothing was started/);
    fs.writeFileSync(path.join(f.workspace, "answer.txt"), "new source revision");
    execFileSync("git", ["-C", f.workspace, "add", "."]);
    execFileSync("git", ["-C", f.workspace, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "second"]);
    const pinnedCopy = exportWorkspace(f.workspace, path.join(f.root, "pinned-copy"), originalRevision);
    assert.equal(fs.readFileSync(path.join(pinnedCopy, "answer.txt"), "utf8"), "wrong");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("evaluation child output is bounded and its failure is recorded", async () => {
  const result = await runOne({ argv: [process.execPath, "-e", "process.stdout.write('x'.repeat(10000))"], cwd: process.cwd(), env: { PATH: process.env.PATH } }, { timeoutMs: 5000, maxOutputBytes: 100 });
  assert.equal(result.outputLimit, true);
  assert.ok(result.stdout.length <= 100);
  const root = makeTempDir();
  try {
    const record = makeRecord({ task: { name: "limit" }, arm: "off", run: 1, invocation: { cwd: root }, dataDir: root,
      outcome: { code: 0, stdout: JSON.stringify({ result: "done", is_error: false }), stderr: "", outputLimit: true, timedOut: false, durationMs: 1 } });
    assert.equal(record.is_error, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
