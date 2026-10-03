import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseOptions } from "../scripts/lib/codex-args.mjs";
import { writeRequest } from "../scripts/lib/codex-request.mjs";
import { resolveCommitWithReason } from "../scripts/lib/evidence.mjs";
import { processJob, scanJobs, sweepSince } from "../scripts/lib/sweep.mjs";
import { consentDecision } from "../scripts/lib/triage-core.mjs";
import { claim, clearDeferral, cleanup, deferJob, deferral, publishDoneOnce, triageDir } from "../scripts/lib/triage-state.mjs";
import { ROOT, cleanEnv, makeTempDir, readLog, runNode, startFakeJev } from "./helpers.mjs";

const KEY = "test-key-not-a-secret";
// In-process calls of the worker's functions get an env, but a forgotten one
// would fall back to this process's data folder: point it at a temporary one.
process.env.ORCH_DATA_DIR = makeTempDir("orch-sweep-guard-");
const HOUR = 60 * 60 * 1000;
// Git dates for the setup commit and for moves "after the job started".
const PAST = Math.floor((Date.now() - 2 * HOUR) / 1000);
const FUTURE = Math.floor((Date.now() + HOUR) / 1000);

// Git in the tests runs with an empty home folder, so none of the user's own
// git settings or hooks can run.
const GIT_HOME = makeTempDir("orch-sweep-git-home-");
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));

function git(args, cwd, date = PAST) {
  return execFileSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: GIT_HOME, GIT_AUTHOR_DATE: `@${date} +0000`, GIT_COMMITTER_DATE: `@${date} +0000` },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10000
  })
    .toString()
    .trim();
}

function jevAnswer(choices, model = "jev-test") {
  const answers = {};
  choices.forEach((choice, n) => (answers[`finding_${n}`] = { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }));
  return { body: { model, answers, usage: { input_tokens: 900, output_tokens: 20 } } };
}

function makeRepo(dir, { objectFormat } = {}) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "a.mjs"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
  git(["init", "-q", ...(objectFormat ? [`--object-format=${objectFormat}`] : [])], dir);
  git(["add", "-A"], dir);
  git(["commit", "-qm", "x"], dir);
  return git(["rev-parse", "HEAD"], dir);
}

async function setUp(t, { config = {}, reply = jevAnswer(["supports"]), objectFormat, since = Date.now() - HOUR } = {}) {
  const tempDir = fs.realpathSync(makeTempDir("orch-sweep-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const repo = path.join(tempDir, "repo");
  const head = makeRepo(repo, { objectFormat });
  const fake = await startFakeJev(reply);
  t.after(fake.close);
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(path.join(dataDir, "triage"), { recursive: true });
  // Jev's address is in the settings file: a worker started by the launcher
  // gets only the shared settings, never a session's ORCH_TYPESAFE_URL.
  const base = { jevEnabled: true, jevModel: "jev-test", jevUrl: fake.url };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ ...base, triageMode: "log", triageProjects: [repo], ...config }));
  // A start time well before the jobs, as after an earlier first run.
  if (since !== null) fs.writeFileSync(path.join(dataDir, "triage", "sweep-since.json"), JSON.stringify({ since: new Date(since).toISOString() }));
  const env = cleanEnv(tempDir, { ORCH_TYPESAFE_URL: fake.url, TYPESAFE_API_KEY: KEY });
  return { tempDir, repo, head, fake, dataDir, env };
}

// Rewrites the settings file; Jev's address always stays the fake one.
function writeConfig(s, values) {
  fs.writeFileSync(path.join(s.dataDir, "config.json"), JSON.stringify({ jevEnabled: true, jevModel: "jev-test", jevUrl: s.fake.url, ...values }));
}

let serial = 0;
function addJob(s, { cwd = s.repo, kind = "review", scope, provenance = true, fields = {}, exitCode = "0", result = "- [P1] guard missing in src/a.mjs:10", endMs = null } = {}) {
  serial += 1;
  const id = `20261002-200000-${String(serial).padStart(6, "0")}`;
  const dir = path.join(s.dataDir, "codex-jobs", id);
  fs.mkdirSync(dir, { recursive: true });
  const theScope = scope ?? { type: "commit", value: s.head };
  const job = { id, kind, cwd, model: null, effort: null, scope: kind === "review" ? theScope : null, has_brief: false, created_at: new Date(Date.now() - 60000).toISOString() };
  if (provenance) {
    Object.assign(job, {
      provenance: 1,
      origin: "direct",
      request_id: null,
      session_id: null,
      head: s.head,
      dirty: false,
      scope_commit: theScope.type === "commit" ? s.head : null,
      base_commit: null,
      provenance_error: null
    });
  }
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ ...job, ...fields }));
  if (result !== null) fs.writeFileSync(path.join(dir, "result.md"), result);
  if (exitCode !== null) {
    fs.writeFileSync(path.join(dir, "exit-code"), exitCode);
    if (endMs !== null) fs.utimesSync(path.join(dir, "exit-code"), endMs / 1000, endMs / 1000);
  }
  return id;
}

const worker = (s, extraEnv = {}) => runNode("scripts/triage-sweep.mjs", { args: ["--worker"], env: { ...s.env, ...extraEnv }, cwd: s.repo });
const launcher = (s, extraEnv = {}) => runNode("scripts/triage-sweep.mjs", { env: { ...s.env, ...extraEnv }, cwd: s.repo, stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s1" }) });
const doneOf = (s, id) => {
  const file = path.join(s.dataDir, "triage", "done", `job-${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
const skippedOf = (s, id) => {
  const file = path.join(s.dataDir, "triage", "skipped", `job-${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).reason : null;
};
const outcomes = (record) => record.findings.map((f) => f.outcome);

async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// --- Scan and outcome ---

test("a finished direct commit review in a listed checkout is triaged once", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  const run = await worker(s);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "");
  assert.equal(s.fake.state.requests.length, 1);
  const record = doneOf(s, id);
  assert.equal(record.source, "codex_job");
  assert.equal(record.job_id, id);
  assert.equal(record.origin, "direct");
  assert.equal(record.agent_type, "subagent-router:codex-reviewer");
  assert.equal(record.reviewed_commit, s.head);
  assert.equal(record.attempt, 1);
  assert.equal(record.group_eligible, true);
  assert.deepEqual(outcomes(record), ["supports"]);
  // The excerpt that left the machine is the reviewed code.
  assert.match(s.fake.state.requests[0].body.state.findings[0].excerpt, /^10: line 10$/m);
  const logged = readLog(s.tempDir).filter((r) => r.event === "triage" && r.job_id === id);
  assert.equal(logged.length, 1, "one triage record in the log");
  // A second run sends nothing more.
  await worker(s);
  assert.equal(s.fake.state.requests.length, 1);
});

for (const [name, exitCode, result, reason] of [
  ["no exit-code", null, "- [P1] x src/a.mjs:10", null],
  ["an empty exit-code", "", "- [P1] x src/a.mjs:10", null],
  ["an exit-code that is not a number", "abc", "- [P1] x src/a.mjs:10", null],
  ["a failed job", "1", "- [P1] x src/a.mjs:10", "exit_1"],
  ["no result.md", "0", null, "no_result"],
  ["an empty result.md", "0", "", "empty_result"]
]) {
  test(`a job with ${name}: ${reason ? `recorded as unavailable (${reason})` : "not finished, left alone"}, nothing sent`, async (t) => {
    const s = await setUp(t);
    const id = addJob(s, { exitCode, result });
    await worker(s);
    assert.equal(s.fake.state.requests.length, 0);
    const record = doneOf(s, id);
    if (reason === null) {
      assert.equal(record, null);
      assert.equal(skippedOf(s, id), null, "an unfinished job is looked at again later");
    } else {
      assert.equal(record.source, "unavailable");
      assert.equal(record.reason, reason);
      assert.equal(record.parse.state, "unavailable");
    }
  });
}

test("jobs before the start time, older than 13 days, or not reviews are skipped for good", async (t) => {
  const s = await setUp(t, { since: Date.now() - 10 * 60 * 1000 });
  const before = addJob(s, { endMs: Date.now() - 20 * 60 * 1000 });
  const consult = addJob(s, { kind: "consult" });
  const fresh = addJob(s);
  await worker(s);
  assert.equal(skippedOf(s, before), "before_start");
  assert.equal(skippedOf(s, consult), "not_a_review");
  assert.equal(doneOf(s, before), null);
  assert.ok(doneOf(s, fresh), "positive control: the fresh job is processed");
  // Older than 13 days, with a start time even older.
  const s2 = await setUp(t, { since: Date.now() - 20 * 24 * HOUR });
  const old = addJob(s2, { endMs: Date.now() - 14 * 24 * HOUR });
  const young = addJob(s2, { endMs: Date.now() - 12 * 24 * HOUR });
  await worker(s2);
  assert.equal(skippedOf(s2, old), "too_old");
  assert.ok(doneOf(s2, young), "positive control: a job inside the 13 days is processed");
  assert.equal(s2.fake.state.requests.length, 1);
});

test("base, custom and uncommitted reviews are triaged and counted, but their evidence is never sent", async (t) => {
  const s = await setUp(t);
  // A clean base review whose HEAD never moved: Codex still compared the merge
  // base with the working tree, which no later check can prove.
  const base = addJob(s, { scope: { type: "base", value: "main" } });
  const custom = addJob(s, { scope: { type: "custom" } });
  const uncommitted = addJob(s, { scope: { type: "uncommitted" } });
  await worker(s);
  assert.equal(s.fake.state.requests.length, 0);
  for (const id of [base, custom, uncommitted]) {
    const record = doneOf(s, id);
    assert.deepEqual(outcomes(record), ["unverifiable_scope"]);
    assert.equal(record.parse.count, 1);
    assert.equal(record.findings[0].excerpt, null);
  }
});

test("a job without provenance gets missing_provenance and sends nothing", async (t) => {
  const s = await setUp(t);
  const id = addJob(s, { provenance: false });
  await worker(s);
  assert.equal(s.fake.state.requests.length, 0);
  assert.deepEqual(outcomes(doneOf(s, id)), ["missing_provenance"]);
});

test("a job with no known reviewed commit gets its own group, which is not eligible", async (t) => {
  const s = await setUp(t);
  const a = addJob(s, { scope: { type: "custom" }, fields: { head: null } });
  const b = addJob(s, { scope: { type: "custom" }, fields: { head: null } });
  await worker(s);
  const [ra, rb] = [doneOf(s, a), doneOf(s, b)];
  assert.equal(ra.group_eligible, false);
  assert.notEqual(ra.change_group, rb.change_group, "two unknown jobs never share a group");
  // Positive control: a known commit gives an eligible group.
  const known = addJob(s);
  await worker(s);
  assert.equal(doneOf(s, known).group_eligible, true);
});

// --- Workers and claims ---

test("two workers started at once send one request in total", async (t) => {
  const s = await setUp(t, { reply: { ...jevAnswer(["supports"]), delayMs: 300 } });
  const id = addJob(s);
  await Promise.all([worker(s), worker(s)]);
  assert.equal(s.fake.state.requests.length, 1);
  assert.ok(doneOf(s, id));
});

test("the sweep lock: a dead or old owner is taken over, a live one is not", async (t) => {
  const s = await setUp(t);
  const lock = path.join(s.dataDir, "triage", "sweep.lock");
  const id = addJob(s);
  // A live owner (this test process, just started): the worker does nothing.
  fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: process.pid, startedAt: Date.now() }));
  await worker(s);
  assert.equal(doneOf(s, id), null);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).token, "other", "a live owner's lock is left alone");
  // The same live owner, but older than 15 minutes: taken over.
  fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: process.pid, startedAt: Date.now() - 16 * 60 * 1000 }));
  await worker(s);
  assert.ok(doneOf(s, id));
  // A dead owner: taken over at once.
  const next = addJob(s);
  const ended = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).toString();
  fs.writeFileSync(lock, JSON.stringify({ token: "other", pid: Number(ended), startedAt: Date.now() }));
  await worker(s);
  assert.ok(doneOf(s, next));
  assert.equal(fs.existsSync(lock), false, "the worker removes its own lock");
});


test("a worker that lost its lock sends nothing, writes no result, and the job is done later", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  const candidate = scanJobs(Date.now() - HOUR, s.env).find((c) => c.id === id);
  const { loadConfig } = await import("../scripts/lib/config.mjs");
  const { config } = loadConfig(s.env);
  // The run's own check says the lock went to another worker.
  await processJob(candidate, config, s.env, () => false);
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(doneOf(s, id), null, "no result without an answer");
  assert.equal(fs.existsSync(path.join(triageDir(s.env), "claimed", `job-${id}`)), false, "the claim is released");
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, id)), ["supports"]);
  assert.equal(s.fake.state.requests.length, 1);
});

test("a claim taken over by another worker is never overwritten or removed by the first", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  const key = `job-${id}`;
  const { ownsClaim, releaseIfOwner, writeDoneOnce } = await import("../scripts/lib/triage-state.mjs");
  const mine = claim(key, { env: s.env });
  assert.equal(mine.claimed, true);
  assert.equal(ownsClaim(key, mine.token, s.env), true, "positive control: the first owner holds it");
  fs.writeFileSync(path.join(triageDir(s.env), "claimed", key), JSON.stringify({ pid: 1, startedAt: Date.now(), attempts: 2, token: "new-owner" }));
  assert.equal(ownsClaim(key, mine.token, s.env), false);
  assert.equal(writeDoneOnce(key, mine.token, { by: "old" }, s.env), false);
  assert.equal(releaseIfOwner(key, mine.token, s.env), false);
  assert.ok(fs.existsSync(path.join(triageDir(s.env), "claimed", key)), "the new owner's claim stays");
  // The first result published wins; a later one never overwrites it.
  assert.equal(writeDoneOnce(key, "new-owner", { by: "new" }, s.env), true);
  fs.writeFileSync(path.join(triageDir(s.env), "claimed", key), JSON.stringify({ token: "third" }));
  assert.equal(writeDoneOnce(key, "third", { by: "third" }, s.env), false);
  assert.equal(doneOf(s, id).by, "new");
});

test("a job whose claims used up three attempts gets an abandoned result, once, and nothing is sent", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  const claimed = path.join(s.dataDir, "triage", "claimed");
  fs.mkdirSync(claimed, { recursive: true });
  fs.writeFileSync(path.join(claimed, `job-${id}`), JSON.stringify({ pid: 999999, startedAt: Date.now() - HOUR, attempts: 3, token: "dead" }));
  const old = (Date.now() - HOUR) / 1000;
  fs.utimesSync(path.join(claimed, `job-${id}`), old, old);
  await worker(s);
  assert.equal(doneOf(s, id).error, "abandoned");
  assert.equal(s.fake.state.requests.length, 0);
});

test("a missing checkout is put off, not skipped; it is done once it is back, and skipped after three tries", async (t) => {
  const s = await setUp(t);
  const away = path.join(s.tempDir, "away");
  const id = addJob(s, { cwd: away, fields: { head: s.head, scope_commit: s.head } });
  const deferredFile = path.join(s.dataDir, "triage", "deferred", `job-${id}.json`);
  await worker(s);
  assert.equal(skippedOf(s, id), null, "no permanent marker for a checkout that may come back");
  assert.equal(JSON.parse(fs.readFileSync(deferredFile, "utf8")).reason, "checkout_missing");
  // The checkout comes back (here: as a worktree of the listed repository), and the hour has passed.
  git(["worktree", "add", "-q", "--detach", away], s.repo);
  writeConfig(s, { triageMode: "log", triageProjects: [s.repo], triageWorktrees: true });
  fs.writeFileSync(deferredFile, JSON.stringify({ reason: "checkout_missing", count: 1, until: Date.now() - 1000 }));
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, id)), ["supports"]);
  // A checkout that never comes back is skipped after the third try.
  const gone = addJob(s, { cwd: path.join(s.tempDir, "gone") });
  for (let n = 0; n < 3; n += 1) {
    const file = path.join(s.dataDir, "triage", "deferred", `job-${gone}.json`);
    if (fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), until: Date.now() - 1000 }));
    await worker(s);
  }
  assert.equal(skippedOf(s, gone), "checkout_missing");
});

test("a Jev outage is retried an hour later; after three tries the error is kept", async (t) => {
  const s = await setUp(t, { reply: { status: 503, body: "busy" } });
  const id = addJob(s);
  const deferredFile = path.join(s.dataDir, "triage", "deferred", `job-${id}.json`);
  await worker(s);
  assert.equal(doneOf(s, id), null);
  const first = JSON.parse(fs.readFileSync(deferredFile, "utf8"));
  assert.equal(first.reason, "jev_http_503");
  assert.ok(Math.abs(first.until - (Date.now() + HOUR)) < 60000, "put off for one hour");
  // Within the hour nothing is tried again.
  await worker(s);
  assert.equal(s.fake.state.requests.length, 1);
  for (let n = 0; n < 2; n += 1) {
    fs.writeFileSync(deferredFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(deferredFile, "utf8")), until: Date.now() - 1000 }));
    await worker(s);
  }
  assert.equal(doneOf(s, id).jev.error, "http_503");
  assert.equal(s.fake.state.requests.length, 3);
});

test("an unreadable job.json is skipped for good; a job folder without job.json yet is not", async (t) => {
  const s = await setUp(t);
  const broken = addJob(s);
  fs.writeFileSync(path.join(s.dataDir, "codex-jobs", broken, "job.json"), "{ broken");
  const early = addJob(s);
  fs.rmSync(path.join(s.dataDir, "codex-jobs", early, "job.json"));
  await worker(s);
  assert.equal(skippedOf(s, broken), "unreadable_job");
  assert.equal(skippedOf(s, early), null);
  assert.equal(doneOf(s, early), null);
});

test("a commit review of an older commit is checked against that commit, not today's HEAD", async (t) => {
  const s = await setUp(t);
  const reviewed = s.head;
  // HEAD moves on with a commit that leaves src/a.mjs alone.
  fs.writeFileSync(path.join(s.repo, "other.txt"), "later");
  git(["add", "-A"], s.repo);
  git(["commit", "-qm", "later"], s.repo);
  const now = git(["rev-parse", "HEAD"], s.repo);
  assert.notEqual(now, reviewed);
  const old = addJob(s, { fields: { head: reviewed, scope_commit: reviewed } });
  const current = addJob(s, { fields: { head: now, scope_commit: now } });
  await worker(s);
  const [ro, rc] = [doneOf(s, old), doneOf(s, current)];
  assert.deepEqual(outcomes(ro), ["supports"], "the file is unchanged since the reviewed commit");
  assert.equal(ro.reviewed_commit, reviewed);
  assert.notEqual(ro.change_group, rc.change_group, "the group is the reviewed commit, not the HEAD at triage time");
  // Once the file changes, the old review's evidence is stale.
  fs.appendFileSync(path.join(s.repo, "src", "a.mjs"), "\nchanged");
  git(["commit", "-qam", "change"], s.repo);
  const stale = addJob(s, { fields: { head: reviewed, scope_commit: reviewed } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, stale)), ["stale_evidence"]);
});

test("git never sees the key, also when a repository's settings run a program", async (t) => {
  const s = await setUp(t);
  const out = path.join(s.tempDir, "fsmonitor-env.txt");
  const script = path.join(s.tempDir, "fsmonitor.sh");
  fs.writeFileSync(script, `#!/bin/sh\nenv >> "${out}"\nexit 1\n`, { mode: 0o755 });
  git(["config", "core.fsmonitor", script], s.repo);
  addJob(s);
  await worker(s);
  assert.ok(fs.existsSync(out), "positive control: git ran the repository's program");
  assert.equal(fs.readFileSync(out, "utf8").includes(KEY), false);
});

test("the budget counts only claimed jobs: refused jobs never starve an allowed one; one run takes at most 25", async (t) => {
  const s = await setUp(t);
  const other = path.join(s.tempDir, "other");
  makeRepo(other);
  for (let i = 0; i < 30; i += 1) addJob(s, { cwd: other, endMs: Date.now() - 50 * 60 * 1000 + i });
  const allowed = addJob(s);
  await worker(s);
  assert.ok(doneOf(s, allowed), "the allowed job behind 30 refused ones is processed");
  assert.equal(s.fake.state.requests.length, 1);
  // 30 allowed jobs: one run takes 25.
  const s2 = await setUp(t);
  const ids = Array.from({ length: 30 }, (_, i) => addJob(s2, { endMs: Date.now() - 50 * 60 * 1000 + i * 1000 }));
  await worker(s2);
  assert.equal(ids.filter((id) => doneOf(s2, id)).length, 25);
  await worker(s2);
  assert.equal(ids.filter((id) => doneOf(s2, id)).length, 30);
});

test("the start time is published once, also when two workers start together, and never moves", async (t) => {
  const s = await setUp(t, { since: null });
  await Promise.all([worker(s), worker(s)]);
  const file = path.join(s.dataDir, "triage", "sweep-since.json");
  const first = fs.readFileSync(file, "utf8");
  assert.ok(Number.isFinite(Date.parse(JSON.parse(first).since)));
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, "triage")).filter((n) => n.endsWith(".tmp")), [], "no temporary file is left");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await worker(s);
  assert.equal(fs.readFileSync(file, "utf8"), first);
  assert.equal(sweepSince(s.env), Date.parse(JSON.parse(first).since));
});

test("a worker without a key claims nothing and logs once; a later worker with the key does the job", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  await worker(s, { TYPESAFE_API_KEY: "" });
  await worker(s, { TYPESAFE_API_KEY: "" });
  assert.equal(doneOf(s, id), null);
  assert.deepEqual(fs.readdirSync(path.join(s.dataDir, "triage")).filter((n) => n === "claimed"), []);
  assert.equal(readLog(s.tempDir).filter((r) => r.event === "hook_error" && r.reason === "no_key").length, 1);
  await worker(s);
  assert.ok(doneOf(s, id));
});

test("a crash after the answer and before the result leads to one retry and one result", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  // A stale claim of a worker that died, as after a crash.
  const claimed = path.join(s.dataDir, "triage", "claimed");
  fs.mkdirSync(claimed, { recursive: true });
  fs.writeFileSync(path.join(claimed, `job-${id}`), JSON.stringify({ pid: 999999, startedAt: Date.now() - HOUR, attempts: 1, token: "dead" }));
  const old = (Date.now() - HOUR) / 1000;
  fs.utimesSync(path.join(claimed, `job-${id}`), old, old);
  await worker(s);
  const record = doneOf(s, id);
  assert.equal(record.attempt, 2);
  assert.equal(s.fake.state.requests.length, 1);
});

test("the key never appears in the log, the worker's error file or its output", async (t) => {
  // A final error (not an outage), so the job ends with a result at once.
  const s = await setUp(t, { reply: { status: 400, body: `upstream echoed ${KEY}` } });
  addJob(s, { result: `- [P1] the client sends ${KEY} in src/a.mjs:10` });
  const run = await worker(s);
  const errFile = path.join(s.dataDir, "triage", "sweep-worker.err");
  const texts = [run.stdout, run.stderr, fs.readFileSync(path.join(s.dataDir, "dispatch-log.jsonl"), "utf8"), fs.existsSync(errFile) ? fs.readFileSync(errFile, "utf8") : ""];
  for (const text of texts) assert.equal(text.includes(KEY), false);
  // A final error (http_400) ends the job at once, and its stored result holds no key.
  const [doneFile] = fs.readdirSync(path.join(s.dataDir, "triage", "done"));
  assert.equal(fs.readFileSync(path.join(s.dataDir, "triage", "done", doneFile), "utf8").includes(KEY), false);
  // The finding text that went out was masked too. (The key belongs only in the
  // Authorization header, which the fake records as well.)
  assert.equal(s.fake.state.requests.length, 1);
  assert.equal(JSON.stringify(s.fake.state.requests.map((r) => r.body)).includes(KEY), false);
  assert.match(s.fake.state.requests[0].body.state.findings[0].text, /<redacted>/);
});

// --- Launcher ---

test("the launcher exits 0 with empty output when off, with broken settings and with an unusable data folder", async (t) => {
  const s = await setUp(t, { config: { triageMode: "off" } });
  addJob(s);
  let run = await launcher(s, { ORCH_TRIAGE_NO_WORKER: "" });
  assert.deepEqual([run.code, run.stdout], [0, ""]);
  assert.equal(fs.existsSync(path.join(s.dataDir, "triage", "sweep-worker.err")), false, "no worker was started");
  fs.writeFileSync(path.join(s.dataDir, "config.json"), "{ broken");
  run = await launcher(s);
  assert.deepEqual([run.code, run.stdout], [0, ""]);
  assert.match(run.stderr, /subagent-router config: /, "the reason the triage is off stays visible");
  // Triage on, a job waiting, but the triage folder cannot be used: exit 0, no
  // output, and the failure is in the dispatch log.
  writeConfig(s, { triageMode: "log", triageProjects: [s.repo] });
  fs.rmSync(path.join(s.dataDir, "triage"), { recursive: true, force: true });
  fs.writeFileSync(path.join(s.dataDir, "triage"), "not a folder");
  run = await launcher(s);
  assert.deepEqual([run.code, run.stdout], [0, ""]);
  assert.ok(readLog(s.tempDir).some((r) => r.event === "hook_error" && r.hook === "triage-sweep"), "the failure is logged");
});


test("the launcher returns before the worker ends, and the worker's result appears later", async (t) => {
  // Jev answers after 3 seconds, so a launcher that waited for the worker would take that long.
  const s = await setUp(t, { reply: { ...jevAnswer(["supports"]), delayMs: 3000 } });
  const id = addJob(s);
  const started = Date.now();
  const run = await launcher(s);
  const took = Date.now() - started;
  assert.deepEqual([run.code, run.stdout], [0, ""]);
  assert.ok(took < 2500, `the launcher took ${took} ms`);
  assert.equal(doneOf(s, id), null, "the result is not there when the launcher returns");
  assert.ok(await waitFor(() => doneOf(s, id) !== null), "the detached worker wrote the result");
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.dataDir, "triage", "sweep.lock"))), "the worker ended and left no lock");
});

test("the launcher starts no worker without a waiting job, without a key, with an empty project list or with a live worker", async (t) => {
  // Starting a worker opens its error file, so the file's absence shows that none was started.
  const errFile = (s) => path.join(s.dataDir, "triage", "sweep-worker.err");
  const s = await setUp(t);
  await launcher(s);
  assert.equal(fs.existsSync(errFile(s)), false, "no job waits");
  addJob(s);
  await launcher(s, { TYPESAFE_API_KEY: "" });
  assert.equal(fs.existsSync(errFile(s)), false, "no key");
  fs.writeFileSync(path.join(s.dataDir, "triage", "sweep.lock"), JSON.stringify({ token: "other", pid: process.pid, startedAt: Date.now() }));
  await launcher(s);
  assert.equal(fs.existsSync(errFile(s)), false, "a live worker holds the lock");
  fs.rmSync(path.join(s.dataDir, "triage", "sweep.lock"));
  writeConfig(s, { triageMode: "log", triageProjects: [] });
  await launcher(s);
  assert.equal(fs.existsSync(errFile(s)), false, "no project may send");
  // Positive control: everything in place, one worker starts and does the job.
  // The empty list was "off for everyone", so the start time is new: only a
  // job that ends after it is taken.
  writeConfig(s, { triageMode: "log", triageProjects: [s.repo] });
  await launcher(s, { TYPESAFE_API_KEY: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const fresh = addJob(s);
  await launcher(s);
  assert.equal(fs.existsSync(errFile(s)), true);
  assert.ok(await waitFor(() => doneOf(s, fresh) !== null), "the worker finished its job");
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.dataDir, "triage", "sweep.lock"))));
  // A job put off for an hour does not wake the launcher either.
  const later = addJob(s);
  deferJob(`job-${later}`, "checkout_missing", s.env);
  fs.rmSync(errFile(s));
  await launcher(s);
  assert.equal(fs.existsSync(errFile(s)), false, "a deferred job is not waiting");
});

test("the start time: published by the launcher before the first job, removed while the triage is off", async (t) => {
  const s = await setUp(t, { since: null });
  const sinceFile = path.join(s.dataDir, "triage", "sweep-since.json");
  await launcher(s);
  assert.ok(fs.existsSync(sinceFile), "published at the switch-on, before any job ended");
  // The first job after the switch-on is triaged, not skipped as older than the start time.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const first = addJob(s);
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, first)), ["supports"]);
  // The triage goes off: the start time goes; a job ends; the triage comes back on.
  writeConfig(s, { triageMode: "off", triageProjects: [s.repo] });
  await launcher(s);
  assert.equal(fs.existsSync(sinceFile), false);
  const whileOff = addJob(s);
  await new Promise((resolve) => setTimeout(resolve, 20));
  writeConfig(s, { triageMode: "log", triageProjects: [s.repo] });
  // Without the key the launcher publishes the start time but starts no worker,
  // so only the worker below runs.
  await launcher(s, { TYPESAFE_API_KEY: "" });
  await worker(s);
  assert.equal(skippedOf(s, whileOff), "before_start", "a job that ended while the triage was off is never sent");
  assert.equal(s.fake.state.requests.length, 1);
});

test("a switch for one session never resets the shared start time; the settings file does", async (t) => {
  const s = await setUp(t);
  const sinceFile = path.join(s.dataDir, "triage", "sweep-since.json");
  const before = fs.readFileSync(sinceFile, "utf8");
  for (const off of [{ ORCH_MODE: "off" }, { ORCH_JEV_ENABLED: "0" }]) {
    const run = await launcher(s, off);
    assert.deepEqual([run.code, run.stdout], [0, ""]);
    assert.equal(fs.readFileSync(sinceFile, "utf8"), before, JSON.stringify(off));
  }
  // Positive control: off in the settings file, which all sessions share.
  writeConfig(s, { triageMode: "off", triageProjects: [s.repo] });
  await launcher(s);
  assert.equal(fs.existsSync(sinceFile), false);
});

test("a launcher without the key starts no worker but logs it, at most once a day", async (t) => {
  const s = await setUp(t);
  addJob(s);
  await launcher(s, { TYPESAFE_API_KEY: "" });
  await launcher(s, { TYPESAFE_API_KEY: "" });
  assert.equal(readLog(s.tempDir).filter((r) => r.event === "hook_error" && r.reason === "no_key").length, 1);
  assert.equal(fs.existsSync(path.join(s.dataDir, "triage", "sweep-worker.err")), false, "no worker was started");
});

test("a Codex reviewer stop starts the worker, which triages the job", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  // The links from the agent to the job, as the route and log hooks write them.
  fs.mkdirSync(path.join(s.dataDir, "codex-requests"), { recursive: true });
  fs.writeFileSync(path.join(s.dataDir, "codex-requests", "req-abc123def456.job"), id);
  fs.appendFileSync(
    path.join(s.dataDir, "dispatch-log.jsonl"),
    `${JSON.stringify({ event: "dispatch", tool_use_id: "tu", codex_request: "req-abc123def456" })}\n${JSON.stringify({ event: "launched", tool_use_id: "tu", agent_id: "ac" })}\n`
  );
  const stop = JSON.stringify({ session_id: "s1", hook_event_name: "SubagentStop", agent_id: "ac", agent_type: "subagent-router:codex-reviewer", cwd: s.repo, permission_mode: "default", last_assistant_message: "Done." });
  const run = await runNode("scripts/triage-hook.mjs", { stdin: stop, env: { ...s.env, ORCH_TRIAGE_LINK_WAIT_MS: "500" }, cwd: s.repo });
  assert.equal(run.stdout, "");
  assert.ok(await waitFor(() => doneOf(s, id) !== null), "the worker that the hook started triaged the job");
  assert.ok(await waitFor(() => !fs.existsSync(path.join(s.dataDir, "triage", "sweep.lock"))));
});

test("hooks.json registers the launcher on Stop and SessionStart, synchronous, with timeout 5", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8")).hooks;
  for (const event of ["Stop", "SessionStart"]) {
    const entries = hooks[event].flatMap((group) => group.hooks).filter((h) => h.args?.[0]?.endsWith("/scripts/triage-sweep.mjs"));
    assert.equal(entries.length, 1, event);
    assert.equal(entries[0].timeout, 5);
    assert.equal(entries[0].async, undefined);
  }
});

// --- Consent and evidence ---

test("a job in an unlisted checkout: no request, no record, one skip marker; withdrawn consent stops the send", async (t) => {
  const s = await setUp(t);
  const other = path.join(s.tempDir, "repo-copy");
  makeRepo(other);
  const id = addJob(s, { cwd: other });
  await worker(s);
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(doneOf(s, id), null);
  assert.equal(skippedOf(s, id), "not_consented");
  // Consent withdrawn after the job was picked: the settings are read again right before the send.
  const listed = addJob(s);
  const candidate = scanJobs(Date.now() - HOUR, s.env).find((c) => c.id === listed);
  const { loadConfig } = await import("../scripts/lib/config.mjs");
  const { config } = loadConfig(s.env);
  writeConfig(s, { triageMode: "off", triageProjects: [s.repo] });
  await processJob(candidate, config, s.env);
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(doneOf(s, listed).jev.error, "consent_withdrawn");
});

test("a cited file in a nested repository gets outside_checkout and is not sent", async (t) => {
  const s = await setUp(t);
  const nested = path.join(s.repo, "vendor", "lib");
  makeRepo(nested);
  const id = addJob(s, { result: "- [P1] guard missing in vendor/lib/src/a.mjs:10" });
  await worker(s);
  assert.equal(s.fake.state.requests.length, 0);
  assert.deepEqual(outcomes(doneOf(s, id)), ["outside_checkout"]);
});

test("commit scope: an unchanged file is sent; a file changed after the commit is stale", async (t) => {
  const s = await setUp(t);
  const sent = addJob(s);
  await worker(s);
  assert.equal(s.fake.state.requests.length, 1);
  assert.deepEqual(outcomes(doneOf(s, sent)), ["supports"]);
  fs.appendFileSync(path.join(s.repo, "src", "a.mjs"), "\nchanged after the review");
  const stale = addJob(s);
  await worker(s);
  assert.equal(s.fake.state.requests.length, 1);
  assert.deepEqual(outcomes(doneOf(s, stale)), ["stale_evidence"]);
});



test("a private key anywhere in a cited file of the reviewed commit holds the whole finding back", async (t) => {
  const s = await setUp(t);
  // Key lines are built at run time, so this file holds no literal key line.
  // The body lines are repeated letters, not a key.
  const dashes = "-".repeat(5);
  const keyLine = (edge, label) => `${dashes}${edge} ${label}${dashes}`;
  const code = (count, from) => Array.from({ length: count }, (_, i) => `code ${from + i}`);
  const body = (count) => Array.from({ length: count }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(64));
  // Lines 1-10 code, 11 BEGIN, 12-36 key body, 37 END, 38-80 code.
  fs.writeFileSync(path.join(s.repo, "src", "conf.mjs"), [...code(10, 1), keyLine("BEGIN", "RSA PRIVATE KEY"), ...body(25), keyLine("END", "RSA PRIVATE KEY"), ...code(43, 38)].join("\n"));
  fs.writeFileSync(path.join(s.repo, "src", "pgp.mjs"), [...code(5, 1), keyLine("BEGIN", "PGP PRIVATE KEY BLOCK"), ...body(25), keyLine("END", "PGP PRIVATE KEY BLOCK"), ...code(40, 33)].join("\n"));
  git(["add", "-A"], s.repo);
  git(["commit", "-qm", "key"], s.repo);
  const head = git(["rev-parse", "HEAD"], s.repo);
  const result = [
    "- [P1] a body line src/conf.mjs:34",
    "- [P1] the first line after the end src/conf.mjs:38",
    "- [P1] the key file first src/conf.mjs:34, a clean file second src/a.mjs:5",
    "- [P1] a clean file first src/a.mjs:5, the key file second src/conf.mjs:34",
    "- [P1] a PGP key file src/pgp.mjs:60"
  ].join("\n");
  const id = addJob(s, { result, fields: { head, scope_commit: head } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, id)), Array.from({ length: 5 }, () => "withheld_secret"));
  assert.equal(s.fake.state.requests.length, 0);
  // Positive control: a clean file of the same commit is sent.
  const clean = addJob(s, { result: "- [P1] a clean file src/a.mjs:5", fields: { head, scope_commit: head } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, clean)), ["supports"]);
  assert.equal(s.fake.state.requests.length, 1);
});

test("a key file changed after the reviewed commit still holds the whole finding back", async (t) => {
  const s = await setUp(t);
  const dashes = "-".repeat(5);
  const keyLine = (edge) => `${dashes}${edge} RSA PRIVATE KEY${dashes}`;
  const code = (count, from) => Array.from({ length: count }, (_, i) => `code ${from + i}`);
  const body = Array.from({ length: 25 }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(64));
  // Lines 1-10 code, 11 BEGIN, 12-36 key body, 37 END, 38-80 code.
  fs.writeFileSync(path.join(s.repo, "src", "conf.mjs"), [...code(10, 1), keyLine("BEGIN"), ...body, keyLine("END"), ...code(43, 38)].join("\n"));
  git(["add", "-A"], s.repo);
  git(["commit", "-qm", "key"], s.repo);
  const head = git(["rev-parse", "HEAD"], s.repo);
  // The key file changes after the review, so its bytes no longer match the commit.
  fs.appendFileSync(path.join(s.repo, "src", "conf.mjs"), "\ncode 81");
  const id = addJob(s, { result: "- [P1] a clean file src/a.mjs:5 and the key file src/conf.mjs:75", fields: { head, scope_commit: head } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, id)), ["withheld_secret"]);
  assert.equal(s.fake.state.requests.length, 0);
});

test("a Codex finding that cites a credential-named file is held back whole, in either order, and nothing is sent", async (t) => {
  const s = await setUp(t);
  // The file is in the reviewed commit; its content is no key at all.
  fs.writeFileSync(path.join(s.repo, "src", "deploy.pem"), "not a key\n".repeat(5));
  git(["add", "-A"], s.repo);
  git(["commit", "-qm", "pem"], s.repo);
  const head = git(["rev-parse", "HEAD"], s.repo);
  const result = ["- [P1] the key file first src/deploy.pem:1, a clean file second src/a.mjs:5", "- [P1] a clean file first src/a.mjs:5, the key file second src/deploy.pem:1"].join("\n");
  const id = addJob(s, { result, fields: { head, scope_commit: head } });
  await worker(s);
  const record = doneOf(s, id);
  assert.deepEqual(outcomes(record), ["withheld_secret", "withheld_secret"]);
  assert.deepEqual(record.findings.map((f) => f.citation?.path), ["src/deploy.pem", "src/deploy.pem"]);
  assert.equal(s.fake.state.requests.length, 0);
  // Positive control: a clean file of the same commit is sent.
  const clean = addJob(s, { result: "- [P1] a clean file src/a.mjs:5", fields: { head, scope_commit: head } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, clean)), ["supports"]);
  assert.equal(s.fake.state.requests.length, 1);
});

test("a citation through a symbolic link, or in another letter case, is stale", async (t) => {
  const s = await setUp(t);
  fs.symlinkSync("a.mjs", path.join(s.repo, "src", "alias.mjs"));
  git(["add", "-A"], s.repo);
  git(["commit", "-qm", "alias"], s.repo);
  const head = git(["rev-parse", "HEAD"], s.repo);
  const linked = addJob(s, { result: "- [P1] guard missing in src/alias.mjs:10", fields: { head, scope_commit: head } });
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, linked)), ["stale_evidence"]);
  // On a file system that ignores case, src/A.mjs opens src/a.mjs; the letter case must still match.
  if (fs.existsSync(path.join(s.repo, "src", "A.mjs"))) {
    const cased = addJob(s, { result: "- [P1] guard missing in src/A.mjs:10", fields: { head, scope_commit: head } });
    await worker(s);
    assert.deepEqual(outcomes(doneOf(s, cased)), ["stale_evidence"]);
  }
  assert.equal(s.fake.state.requests.length, 0);
});

test("a repository with SHA-256 ids: a commit review is sent", async (t) => {
  const s = await setUp(t, { objectFormat: "sha256" });
  assert.equal(s.head.length, 64);
  const id = addJob(s);
  await worker(s);
  assert.deepEqual(outcomes(doneOf(s, id)), ["supports"]);
});

test("a revision that looks like an option is never passed to git", () => {
  assert.deepEqual(resolveCommitWithReason(ROOT, "--output=/tmp/x"), { id: null, error: "bad_revision" });
  assert.deepEqual(resolveCommitWithReason(ROOT, "-x"), { id: null, error: "bad_revision" });
});

// --- Round 2 of the implementation review ---

test("a worker started by the launcher has no key in its environment, so a repository's program cannot read it", async (t) => {
  const s = await setUp(t);
  const out = path.join(s.tempDir, "parents-env.txt");
  const script = path.join(s.tempDir, "fsmonitor.sh");
  // The program reads the environment of git and of git's parent, the worker.
  fs.writeFileSync(
    script,
    `#!/bin/sh\ngp=$(ps -o ppid= -p $PPID | tr -d ' ')\nfor p in $PPID $gp; do\n  if [ -r /proc/$p/environ ]; then tr '\\0' '\\n' < /proc/$p/environ; else ps -E -ww -o command= -p $p; fi\ndone >> "${out}"\nexit 1\n`,
    { mode: 0o755 }
  );
  git(["config", "core.fsmonitor", script], s.repo);
  const id = addJob(s);
  await launcher(s, { CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY: KEY });
  assert.ok(await waitFor(() => doneOf(s, id) !== null), "the worker did the job with the key it got through the pipe");
  assert.deepEqual(outcomes(doneOf(s, id)), ["supports"]);
  const dumped = fs.readFileSync(out, "utf8");
  assert.match(dumped, /PATH=/, "positive control: the program read the environments");
  assert.equal(dumped.includes(KEY), false);
});

test("the worker follows the shared settings, never one session's address for Jev", async (t) => {
  const s = await setUp(t);
  const other = await startFakeJev(jevAnswer(["contradicts"]));
  t.after(other.close);
  const id = addJob(s);
  await launcher(s, { ORCH_TYPESAFE_URL: other.url });
  assert.ok(await waitFor(() => doneOf(s, id) !== null));
  assert.equal(other.state.requests.length, 0, "the session's own address got nothing");
  assert.equal(s.fake.state.requests.length, 1);
});

test("orch-codex publishes the start time when a review starts, and its job is triaged end to end", async (t) => {
  const s = await setUp(t, { since: null });
  const codex = path.join(s.tempDir, "fake-codex-finding.cjs");
  fs.writeFileSync(
    codex,
    '#!/usr/bin/env node\nif (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nprocess.stdin.resume();\nprocess.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("-o") + 1], "- [P1] guard missing in src/a.mjs:10"));\n',
    { mode: 0o755 }
  );
  const run = await runNode("scripts/orch-codex.mjs", { args: ["review", "--commit", s.head, "--wait", "60"], env: { ...s.env, ORCH_CODEX_BIN: codex }, cwd: s.repo });
  assert.equal(run.code, 0, run.stdout + run.stderr);
  const jobId = run.stdout.match(/^CODEX_JOB (\S+)/)[1];
  const since = Date.parse(JSON.parse(fs.readFileSync(path.join(s.dataDir, "triage", "sweep-since.json"), "utf8")).since);
  assert.ok(since <= Date.parse(jobOf(s, run.stdout).created_at), "the start time is not later than the job's start");
  await worker(s);
  const record = doneOf(s, jobId);
  assert.deepEqual(outcomes(record), ["supports"], "the real job folder, as orch-codex wrote it, is triaged");
  assert.equal(record.origin, "direct");
});

test("consent: definite answers are allowed or refused; a failed lookup is unknown", () => {
  const root = makeTempDir("orch-consent-");
  const repo = path.join(root, "repo");
  makeRepo(repo);
  const real = fs.realpathSync(repo);
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  const config = (projects, triageWorktrees = false) => ({ triageProjects: projects, triageWorktrees });
  const identity = { root: real, commonDir: fs.realpathSync(path.join(repo, ".git")) };
  assert.equal(consentDecision(identity, config([repo])), "allowed");
  assert.equal(consentDecision(identity, config([plain])), "refused", "every lookup worked, nothing matched");
  assert.equal(consentDecision({ root: null, error: "not_a_repo" }, config([repo])), "refused", "a folder outside git");
  assert.equal(consentDecision({ root: null, error: "git_missing" }, config([repo])), "unknown", "a folder that is gone");
  assert.equal(consentDecision(identity, config([plain, path.join(root, "gone")])), "unknown", "a listed folder that is gone");
  assert.equal(consentDecision({ ...identity, commonDir: null }, config([plain], true)), "unknown", "the repository could not be named");
  assert.equal(consentDecision(identity, config([plain], true)), "unknown", "a listed folder outside git cannot be compared");
  fs.rmSync(root, { recursive: true, force: true });
});

test("consent that becomes unknown right before the send puts the job off; it is not a final result", async (t) => {
  const s = await setUp(t);
  const id = addJob(s);
  const candidate = scanJobs(Date.now() - HOUR, s.env).find((c) => c.id === id);
  const { loadConfig } = await import("../scripts/lib/config.mjs");
  const { config } = loadConfig(s.env);
  // The settings change between the scan and the send: a listed folder is gone.
  writeConfig(s, { triageMode: "log", triageProjects: [path.join(s.tempDir, "gone")] });
  await processJob(candidate, config, s.env, () => true, KEY);
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(doneOf(s, id), null);
  assert.equal(deferral(`job-${id}`, s.env).reason, "jev_consent_unknown");
});

test("a job.json that holds JSON null is skipped, and the other jobs are still done", async (t) => {
  const s = await setUp(t);
  const broken = addJob(s);
  fs.writeFileSync(path.join(s.dataDir, "codex-jobs", broken, "job.json"), "null");
  const fine = addJob(s);
  await worker(s);
  assert.equal(skippedOf(s, broken), "unreadable_job");
  assert.ok(doneOf(s, fine));
});

test("a running worker stops when the start time changes, so a job from an off period is never sent", async (t) => {
  const s = await setUp(t, { reply: { ...jevAnswer(["supports"]), delayMs: 1500 } });
  const first = addJob(s, { endMs: Date.now() - 2000 });
  const second = addJob(s, { endMs: Date.now() - 1000 });
  const running = worker(s);
  assert.ok(await waitFor(() => s.fake.state.requests.length === 1), "the first job is being sent");
  // The triage goes off and on again while the request is in flight.
  fs.writeFileSync(path.join(s.dataDir, "triage", "sweep-since.json"), JSON.stringify({ since: new Date().toISOString() }));
  await running;
  assert.ok(doneOf(s, first), "the job in flight is finished");
  assert.equal(doneOf(s, second), null, "the run stopped before the next job");
  assert.equal(s.fake.state.requests.length, 1);
});

test("the state helpers: a result is published once; a deferral counts up and clears; cleanup removes old markers", () => {
  const dataDir = makeTempDir("orch-state-");
  const env = { ORCH_DATA_DIR: dataDir };
  assert.equal(publishDoneOnce("job-x", { by: "first" }, env), true);
  assert.equal(publishDoneOnce("job-x", { by: "second" }, env), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "triage", "done", "job-x.json"), "utf8")).by, "first");
  assert.equal(deferJob("job-y", "jev_timeout", env), 1);
  assert.equal(deferJob("job-y", "jev_timeout", env), 2);
  assert.equal(deferral("job-y", env).count, 2);
  clearDeferral("job-y", env);
  assert.equal(deferral("job-y", env), null);
  // Markers older than 30 days go.
  deferJob("job-z", "checkout_missing", env);
  const old = (Date.now() - 31 * 24 * HOUR) / 1000;
  fs.utimesSync(path.join(dataDir, "triage", "deferred", "job-z.json"), old, old);
  cleanup({ env });
  assert.equal(deferral("job-z", env), null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// --- Provenance written by orch-codex.mjs ---

function fakeCodex(dir) {
  const file = path.join(dir, "fake-codex.cjs");
  fs.writeFileSync(
    file,
    '#!/usr/bin/env node\nif (process.argv[2] === "login") { process.stderr.write("Logged in using ChatGPT\\n"); process.exit(0); }\nconst fs = require("node:fs");\nconst args = process.argv.slice(2);\nprocess.stdin.resume();\nprocess.stdin.on("end", () => fs.writeFileSync(args[args.indexOf("-o") + 1], "No actionable regressions found."));\n',
    { mode: 0o755 }
  );
  return file;
}

const jobOf = (s, stdout) => JSON.parse(fs.readFileSync(path.join(s.dataDir, "codex-jobs", stdout.match(/^CODEX_JOB (\S+)/)[1], "job.json"), "utf8"));

test("orch-codex records the provenance of a review job before its runner starts", async (t) => {
  const s = await setUp(t);
  const env = { ...s.env, ORCH_CODEX_BIN: fakeCodex(s.tempDir) };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], s.repo);

  const direct = await runNode("scripts/orch-codex.mjs", { args: ["review", "--commit", s.head.slice(0, 12), "--wait", "60"], env, cwd: s.repo });
  assert.equal(direct.code, 0, direct.stdout + direct.stderr);
  const job = jobOf(s, direct.stdout);
  assert.deepEqual(
    [job.provenance, job.origin, job.request_id, job.head, job.dirty, job.scope_commit, job.base_commit, job.provenance_error],
    [1, "direct", null, s.head, false, s.head, null, null],
    "a short id is resolved to the full one"
  );

  const base = await runNode("scripts/orch-codex.mjs", { args: ["review", "--base", branch, "--wait", "60"], env, cwd: s.repo });
  assert.equal(base.code, 0, base.stdout + base.stderr);
  assert.deepEqual([jobOf(s, base.stdout).base_commit, jobOf(s, base.stdout).scope_commit], [s.head, null]);

  // Uncommitted changes at the start are recorded.
  fs.appendFileSync(path.join(s.repo, "src", "a.mjs"), "\nnot committed");
  const dirty = await runNode("scripts/orch-codex.mjs", { args: ["review", "--commit", s.head, "--wait", "60"], env, cwd: s.repo });
  assert.equal(jobOf(s, dirty.stdout).dirty, true);

  // Outside git: the job still starts, and the reason is kept.
  const plain = path.join(s.tempDir, "plain");
  fs.mkdirSync(plain);
  const outside = await runNode("scripts/orch-codex.mjs", { args: ["review", "--wait", "60"], env, cwd: plain });
  assert.equal(outside.code, 0, outside.stdout + outside.stderr);
  assert.deepEqual([jobOf(s, outside.stdout).head, jobOf(s, outside.stdout).provenance_error], [null, "not_a_repo"]);

  // A routed run names its request.
  const { id } = writeRequest({ kind: "review", prompt: "Goal: review the change", cwd: s.repo, sessionId: "s1", toolUseId: "tu1" }, env);
  const routed = await runNode("scripts/orch-codex.mjs", { args: ["run", id, "--wait", "60"], env, cwd: s.repo });
  assert.equal(routed.code, 0, routed.stdout + routed.stderr);
  assert.deepEqual([jobOf(s, routed.stdout).origin, jobOf(s, routed.stdout).request_id], ["routed", id]);
});

test("a 64-character commit id passes the review options; 65 does not", () => {
  assert.deepEqual(parseOptions(["--commit", "a".repeat(64)]).scope, { type: "commit", value: "a".repeat(64) });
  assert.throws(() => parseOptions(["--commit", "a".repeat(65)]), /7 to 64 hex/);
});
