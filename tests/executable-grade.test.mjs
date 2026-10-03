import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { test } from "node:test";
import { boundaryCommand, checkBoundary, gradingEnvironment, nodeRuntimeDirectory, wrapInvocation } from "../scripts/lib/execution-boundary.mjs";
import { boundWorker, loadVerification, prepareVerification, snapshotTree, verifyWorkspace } from "../scripts/lib/executable-grade.mjs";
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

test("a task with verify scores an errored or timed-out run, and the run fails", () => {
  // The workspace exists whether or not the worker finished, so a task with
  // `verify` grades every run. A run that errored or timed out is a failure,
  // not a run left out of the pass rate. This needs no OS boundary: the
  // fixture only loads the verification definition.
  const f = fixture();
  try {
    const completed = (graded) => graded.graders.find((grader) => grader.name === "worker.completed");
    for (const [label, outcome] of [["an errored", { is_error: true }], ["a timed-out", { timed_out: true }]]) {
      const graded = gradeRecord({ cwd: f.workspace, result: "", is_error: false, timed_out: false, ...outcome }, f.task);
      assert.equal(graded.scored, true, `${label} run is scored`);
      assert.equal(graded.pass, false, `${label} run fails`);
      assert.equal(completed(graded)?.pass, false, `the worker.completed grader fails ${label} run`);
    }
    const clean = gradeRecord({ cwd: f.workspace, result: "done", is_error: false, timed_out: false }, f.task);
    assert.equal(completed(clean)?.pass, true, "the worker.completed grader passes a run that completed");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unsupported boundaries fail closed and grading drops inherited credentials and runtime injection", () => {
  assert.throws(() => boundaryCommand([process.execPath], { platform: "unsupported" }), /no execution boundary/);
  assert.deepEqual(gradingEnvironment("/scratch", { PATH: "/bin", SECRET: "test-key-not-a-secret", NODE_OPTIONS: "--require=hostile", HOME: "/real" }),
    { PATH: "/bin", HOME: "/scratch", TMPDIR: "/scratch", TMP: "/scratch", TEMP: "/scratch", LANG: "C", LC_ALL: "C" });
});

test("a bounded worker keeps Claude Code's own temp files inside its scratch folder", () => {
  // Claude Code writes its internal temp files, the Bash tool's included, under
  // CLAUDE_CODE_TMPDIR (default /tmp/claude-<uid>/ on macOS). The boundary allows
  // writes only to the workspace, the data folder and the scratch folder, so
  // without this every shell command of the worker failed with EPERM.
  const root = fs.realpathSync(makeTempDir("orch-bound-"));
  try {
    const [workspace, data, scratch, empty] = ["workspace", "data", "scratch", "empty"].map((name) => {
      fs.mkdirSync(path.join(root, name));
      return path.join(root, name);
    });
    const invocation = {
      argv: [process.execPath, "-e", "0"],
      cwd: workspace,
      env: { PATH: "/bin", HOME: "/home/user", CLAUDE_CODE_TMPDIR: "/tmp", SECRET: "test-key-not-a-secret" }
    };
    const prepared = { scratch, workerOptions: { writable: [workspace, data, scratch], deniedReads: [], emptyDirectory: empty, network: true, platform: "darwin" } };
    const bound = boundWorker(invocation, prepared);
    assert.equal(bound.env.CLAUDE_CODE_TMPDIR, scratch, "Claude Code's temp folder is the scratch folder, not the inherited /tmp");
    assert.equal(bound.env.TMPDIR, scratch);
    assert.equal(bound.env.SECRET, undefined, "unrelated credentials are still dropped");
    assert.ok(bound.argv.join("\n").includes(`(allow file-write* (subpath ${JSON.stringify(scratch)}))`), "the boundary allows writes to that folder");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test("a task with history gets a workspace with the fixture's commits, pinned to the revision", () => {
  // A review task needs a base commit and a change commit; a plain export keeps
  // only the files of one commit.
  const root = fs.realpathSync(makeTempDir("orch-history-"));
  try {
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "a.txt"), "base");
    git("add", ".");
    git("commit", "-qm", "base");
    fs.writeFileSync(path.join(repo, "a.txt"), "change");
    git("commit", "-qam", "change");
    const pinned = git("rev-parse", "HEAD");
    git("tag", "pinned-tag");
    fs.writeFileSync(path.join(repo, "a.txt"), "later");
    git("commit", "-qam", "later");
    const later = git("rev-parse", "HEAD");
    git("tag", "later-tag");
    // A side branch with a commit of its own, which the pinned revision does not
    // contain either.
    git("checkout", "-q", "-b", "side", pinned);
    fs.writeFileSync(path.join(repo, "side.txt"), "side");
    git("add", ".");
    git("commit", "-qm", "side");
    const side = git("rev-parse", "HEAD");
    git("checkout", "-q", "-");

    const withHistory = exportWorkspace(repo, path.join(root, "with"), pinned, { history: true });
    const inCopy = (...args) => execFileSync("git", ["-C", withHistory, ...args], { encoding: "utf8" }).trim();
    assert.deepEqual(inCopy("log", "--format=%s").split("\n"), ["change", "base"], "the workspace holds the commits up to the pinned revision");
    assert.deepEqual(inCopy("log", "--all", "--format=%s").split("\n"), ["change", "base"], "no branch or tag keeps a later commit reachable");
    assert.equal(inCopy("for-each-ref", "--format=%(refname)"), "refs/heads/review", "only the review branch remains");
    // Deleting the refs is not enough: a worker could still read a later commit
    // by its id, and the reflog names the later tip and the fixture's path.
    for (const [label, id] of [["later", later], ["side", side]]) {
      assert.throws(() => execFileSync("git", ["-C", withHistory, "cat-file", "-e", id], { stdio: "ignore" }), undefined, `the ${label} commit is not in the copy`);
    }
    assert.deepEqual(inCopy("log", "--all", "--reflog", "--format=%s").split("\n"), ["change", "base"], "no reflog keeps a later commit reachable");
    assert.ok(!inCopy("reflog").includes(repo), "the reflog does not name the fixture's path");
    const commits = inCopy("cat-file", "--batch-all-objects", "--batch-check").split("\n").filter((line) => line.split(" ")[1] === "commit");
    assert.equal(commits.length, 2, `the copy holds only the base and change commits: ${commits.join(", ")}`);
    assert.equal(fs.readFileSync(path.join(withHistory, "a.txt"), "utf8"), "change");
    assert.equal(inCopy("remote"), "", "no remote points back at the fixture");
    assert.equal(fs.existsSync(path.join(withHistory, ".git", "objects", "info", "alternates")), false, "the objects do not point back at the fixture");
    // The snapshot of the grader refuses hard links, so the copy must have none.
    assert.doesNotThrow(() => snapshotTree(withHistory));

    const plain = exportWorkspace(repo, path.join(root, "plain"), pinned);
    assert.equal(fs.existsSync(path.join(plain, ".git")), false, "a plain export still has no history");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the task loader accepts history only as true or false, and only with export", () => {
  const root = fs.realpathSync(makeTempDir("orch-history-load-"));
  const outside = fs.realpathSync(makeTempDir("orch-history-norepo-"));
  try {
    // The clone of a history task starts at the top folder of the repository, so
    // the loader accepts history only for a cwd that is that top folder.
    execFileSync("git", ["init", "-q", root]);
    const taskFile = path.join(root, "tasks.json");
    const write = (body) => fs.writeFileSync(taskFile, JSON.stringify(body));
    write({ tasks: [{ name: "review", prompt: "review", cwd: root, export: true, history: true }] });
    assert.equal(loadTaskSet(taskFile).tasks[0].history, true);
    write({ export: true, history: true, tasks: [{ name: "review", prompt: "review", cwd: root }] });
    assert.equal(loadTaskSet(taskFile).tasks[0].history, true, "a file-level default is inherited");
    write({ tasks: [{ name: "plain", prompt: "x", cwd: root }] });
    assert.equal(loadTaskSet(taskFile).tasks[0].history, false, "history is off by default");
    write({ tasks: [{ name: "review", prompt: "review", cwd: root, history: true }] });
    assert.throws(() => loadTaskSet(taskFile), /history requires export/);
    write({ tasks: [{ name: "review", prompt: "review", cwd: root, export: true, history: "yes" }] });
    assert.throws(() => loadTaskSet(taskFile), /"history" must be true or false/);

    // A subfolder works for a plain export, but a history task would fail only
    // at run time, after earlier tasks had run. The loader refuses it first.
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub);
    write({ tasks: [{ name: "plain", prompt: "x", cwd: sub, export: true }] });
    assert.equal(loadTaskSet(taskFile).tasks[0].history, false, "a plain export of a subfolder is still accepted");
    write({ tasks: [{ name: "review", prompt: "review", cwd: sub, export: true, history: true }] });
    assert.throws(() => loadTaskSet(taskFile), /task "review": history needs cwd to be the top folder of its git repository \(it is inside sub\/\)/);
    write({ tasks: [{ name: "review", prompt: "review", cwd: outside, export: true, history: true }] });
    assert.throws(() => loadTaskSet(taskFile), /task "review": history needs cwd to be a git repository/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
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
