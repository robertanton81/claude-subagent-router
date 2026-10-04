import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../scripts/lib/config.mjs";
import { evaluate, register, reserve, sample, score, saveLabel, readItems, readLabels, status, statusLine } from "../scripts/lib/labels.mjs";
import { poolOf, poolsFile } from "../scripts/lib/pools.mjs";
import { evalVersion } from "../scripts/lib/questions.mjs";
import { writeDone } from "../scripts/lib/triage-state.mjs";
import { cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const START = "2026-10-01T00:00:00.000Z";
const END = "2026-10-21T00:00:00.000Z";

function setUp(t, config = {}) {
  const tempDir = fs.realpathSync(makeTempDir("orch-label-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const checkout = path.join(tempDir, "checkout");
  fs.mkdirSync(checkout);
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ jevModel: "jev-1.13.0", triageMode: "log", triageProjects: [checkout], ...config }));
  const env = { ORCH_DATA_DIR: dataDir, PATH: process.env.PATH, HOME: tempDir };
  return { tempDir, checkout, dataDir, env, at: (iso) => ({ ...env, ORCH_LABEL_NOW: iso }) };
}

// Change-group keys that land in the wanted pool.
function groupKeys(pool, count) {
  const keys = [];
  for (let i = 0; keys.length < count; i += 1) {
    const key = createHash("sha256").update(`g${i}`).digest("hex").slice(0, 16);
    if (poolOf(key) === pool) keys.push(key);
  }
  return keys;
}

// A test that pins ids passes `id`: then the report id and the done file name
// never depend on how many results the tests before it wrote. The done files
// are read in name order, so their names decide the order of the results.
let serial = 0;
function addResult(s, { id = null, group, outcome = "supports", cited = true, eligible = true, ts = "2026-10-05T10:00:00.000Z", agentType = "subagent-router:codex-reviewer", state = "parsed", root = s.checkout, commonDir = null, version = null, handbackChecked = true, handbackMissing = false }) {
  serial += 1;
  const reportId = id ?? `r${serial}`;
  const { config } = loadConfig(s.env);
  writeDone(
    `k-${reportId}`,
    {
      event: "triage",
      ts,
      report_id: reportId,
      agent_type: agentType,
      handback_checked: handbackChecked,
      handback_missing: handbackMissing,
      eval_version: version ?? evalVersion(config),
      change_group: group,
      group_eligible: eligible,
      repo: { root, common_dir: commonDir, head: "a".repeat(40), dirty: false },
      parse: { state, count: 1 },
      snapshot: `[P1] finding ${reportId}`,
      findings: [{ finding_id: `${reportId}#0`, index: 0, label: "P1", text: `finding ${reportId}`, citation: cited ? { path: "src/a.mjs", start: 3, end: 3 } : null, excerpt: cited ? "3: code" : null, outcome }]
    },
    s.env
  );
  return reportId;
}

test("reserve runs once; register refuses an unpinned model, a bad window and a second window", (t) => {
  const s = setUp(t);
  assert.throws(() => register({ start: START, end: END }, s.env), /reserve/);
  reserve(s.env);
  assert.throws(() => reserve(s.env), /already reserved/);
  assert.throws(() => register({ start: END, end: START }, s.env), /end must come after/);
  const reg = register({ start: START, end: END, seed: 7 }, s.env);
  assert.equal(reg.seed, 7);
  assert.deepEqual(reg.population.triageProjects, [s.checkout]);
  assert.throws(() => register({ start: START, end: END }, s.env), /already registered/);
  const pools = JSON.parse(fs.readFileSync(poolsFile(s.env), "utf8"));
  assert.equal(fs.statSync(poolsFile(s.env)).mode & 0o077, 0);
  assert.equal(pools.registration.end, END);

  const latest = setUp(t, { jevModel: "jev-latest" });
  reserve(latest.env);
  assert.throws(() => register({ start: START, end: END }, latest.env), /Pin an exact version/);
});

test("sample: never before the end; one finding per group; tuning, ineligible and other projects are never drawn", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 3 }, s.env);
  const evaluation = groupKeys("evaluation", 75);
  for (const group of evaluation) {
    addResult(s, { group });
    addResult(s, { group }); // a second review of the same commit
  }
  for (const group of groupKeys("tuning", 5)) addResult(s, { group, outcome: "contradicts" });
  // Groups that must never be drawn, each with no other eligible result:
  const extra = groupKeys("evaluation", 80).slice(75);
  addResult(s, { group: extra[0], eligible: false }); // ineligible only
  addResult(s, { group: extra[1], root: path.join(s.tempDir, "other-checkout") }); // another project
  addResult(s, { group: extra[2], agentType: "acme:not-registered" }); // an agent type outside the population
  addResult(s, { group: extra[3], ts: "2026-11-01T00:00:00.000Z" }); // after the window
  assert.throws(() => sample("s1", s.at("2026-10-20T00:00:00.000Z")), /window ends/);

  const drawn = sample("s1", s.at("2026-10-22T00:00:00.000Z"));
  assert.equal(drawn.findings, 60);
  const items = readItems(drawn.dir);
  const findings = items.filter((i) => i.kind === "finding");
  assert.equal(new Set(findings.map((i) => i.id)).size, 60);
  // No Jev answer is in the labelling file.
  assert.ok(!JSON.stringify(items).includes('"outcome"'));
  assert.equal(fs.statSync(path.join(drawn.dir, "answers.json")).mode & 0o077, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(drawn.dir, "meta.json"), "utf8"));
  assert.equal(new Set(meta.groups).size, 60);
  for (const group of meta.groups) assert.equal(poolOf(group), "evaluation");
  for (const group of extra.slice(0, 4)) assert.ok(!meta.groups.includes(group), `group ${group} must not be drawn`);
  // The tuning results answered "contradicts"; none may appear, also not as precision items.
  assert.equal(items.filter((i) => i.kind === "precision").length, 0);
});

test("sample after the end takes every eligible group below 60, and a seeded 60 above", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 3 }, s.env);
  for (const group of groupKeys("evaluation", 59)) addResult(s, { group });
  assert.equal(sample("small", s.at("2026-10-22T00:00:00.000Z")).findings, 59);
});

test("sample refuses when triageProjects changed after registration", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END }, s.env);
  fs.writeFileSync(path.join(s.dataDir, "config.json"), JSON.stringify({ jevModel: "jev-1.13.0", triageMode: "log", triageProjects: [] }));
  assert.throws(() => sample("x", s.at("2026-10-22T00:00:00.000Z")), /triageProjects or triageWorktrees changed/);
  // The same list with the worktree switch turned on is a changed population too.
  fs.writeFileSync(path.join(s.dataDir, "config.json"), JSON.stringify({ jevModel: "jev-1.13.0", triageMode: "log", triageProjects: [s.checkout], triageWorktrees: true }));
  assert.throws(() => sample("x", s.at("2026-10-22T00:00:00.000Z")), /triageProjects or triageWorktrees changed/);
});

test("with triageWorktrees the population takes worktrees of a listed repository, by the git common directory stored at registration", (t) => {
  for (const worktrees of [true, false]) {
    const s = setUp(t, { triageWorktrees: worktrees });
    const git = (args, cwd) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git(["init", "-q"], s.checkout);
    git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], s.checkout);
    const worktree = path.join(s.tempDir, "worktree");
    git(["worktree", "add", "-q", "--detach", worktree], s.checkout);
    const commonDir = fs.realpathSync(path.join(s.checkout, ".git"));
    reserve(s.env);
    const reg = register({ start: START, end: END, seed: 3 }, s.env);
    assert.deepEqual(reg.population.commonDirs, worktrees ? [commonDir] : []);
    const [inWorktree, elsewhere] = groupKeys("evaluation", 2);
    const fromWorktree = addResult(s, { group: inWorktree, root: worktree, commonDir });
    // A sibling whose path starts with the listed one, in another repository.
    addResult(s, { group: elsewhere, root: `${s.checkout}-other`, commonDir: `${s.checkout}-other/.git` });
    const drawn = sample("w", s.at("2026-10-22T00:00:00.000Z"));
    const ids = readItems(drawn.dir).filter((i) => i.kind !== "report").map((i) => i.id);
    assert.deepEqual(ids, worktrees ? [`${fromWorktree}#0`] : [], `triageWorktrees ${worktrees}`);
  }
});

test("register refuses when triageWorktrees is on and git names no repository for a listed checkout", (t) => {
  // The checkout of setUp is a plain folder, not a git checkout.
  const s = setUp(t, { triageWorktrees: true });
  reserve(s.env);
  assert.throws(() => register({ start: START, end: END }, s.env), /triageWorktrees is on, but git names no repository for: .*checkout \(not_a_repo\)/);
  // Positive control: with the switch off, the same list registers.
  const off = setUp(t);
  reserve(off.env);
  assert.ok(register({ start: START, end: END }, off.env));
});

test("a result of another evaluation version is never drawn", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 6 }, s.env);
  const [current, older] = groupKeys("evaluation", 2);
  const kept = addResult(s, { group: current });
  const { config } = loadConfig(s.env);
  addResult(s, { group: older, version: { ...evalVersion(config), parser: "older-parser" } });
  const drawn = sample("v", s.at("2026-10-22T00:00:00.000Z"));
  assert.deepEqual(readItems(drawn.dir).filter((i) => i.kind !== "report").map((i) => i.id), [`${kept}#0`]);
});

test("precision items are contradicts answers from groups outside the representative sample", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 5 }, s.env);
  const groups = groupKeys("evaluation", 70);
  for (const group of groups) addResult(s, { group, outcome: "contradicts" });
  const drawn = sample("p", s.at("2026-10-22T00:00:00.000Z"));
  const items = readItems(drawn.dir);
  const meta = JSON.parse(fs.readFileSync(path.join(drawn.dir, "meta.json"), "utf8"));
  const precision = items.filter((i) => i.kind === "precision");
  assert.equal(precision.length, 10);
  const findingIds = new Set(items.filter((i) => i.kind === "finding").map((i) => i.id));
  for (const item of precision) assert.ok(!findingIds.has(item.id));
  assert.equal(meta.groups.length, 60);
});

// 65 change groups with three results each: "a" supports, "b" and "c"
// contradict. 60 groups go to the main sample, and the "b" and "c" findings of
// the other 5 groups are the 10 candidates for precision items. Ids like "07b"
// are explicit, so the pinned ids below hold wherever this test stands.
function blindFixture(t) {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 11 }, s.env);
  const groups = groupKeys("evaluation", 65);
  groups.forEach((group, n) => {
    const at = String(n).padStart(2, "0");
    addResult(s, { group, id: `${at}a`, outcome: "supports" });
    addResult(s, { group, id: `${at}b`, outcome: "contradicts" });
    addResult(s, { group, id: `${at}c`, outcome: "contradicts" });
  });
  return { s, groups };
}

// What the code before the presentation shuffle drew for this fixture with
// seed 11, in draw order. The shuffle may change the order on the screen only,
// so the same seed must still draw exactly these.
const DRAWN_FINDINGS = (
  "32b 60c 45a 11b 41b 04c 06a 00a 16b 34b 15a 63b 26b 58c 64c 03b 47b 21c 18b 07b " +
  "24a 23b 50a 20c 59a 46b 17a 61a 02c 55b 51b 14a 35b 44b 48c 56c 08b 52b 53b 42b " +
  "22a 30b 19b 31c 49c 10a 25a 36b 13c 27b 39c 62b 38c 05b 40a 43a 09b 01b 29b 28a"
).split(" ");
const DRAWN_PRECISION = "37b 12c 37c 54b 57c 57b 33c 12b 33b 54c".split(" ");
const DRAWN_REPORTS = "52b 16c 26c 33c 28b 37a 38a 61c 44a 24b 31b 63c 21c 62b 46c 43b 53b 24a 45a 19b".split(" ");

test("sample mixes the precision items among the main findings, and the same seed still draws the same items", (t) => {
  const { s, groups } = blindFixture(t);
  const at = s.at("2026-10-22T00:00:00.000Z");
  const one = sample("one", at);
  const two = sample("two", at);
  // (a) The same inputs draw the same file.
  const text = fs.readFileSync(path.join(one.dir, "items.json"), "utf8");
  assert.equal(fs.readFileSync(path.join(two.dir, "items.json"), "utf8"), text);
  const items = JSON.parse(text);
  const blind = items.filter((i) => i.kind !== "report");
  // (b) The two kinds are mixed, so their position no longer tells them apart.
  const kinds = blind.map((i) => i.kind[0]).join("");
  assert.notEqual(kinds, `${"f".repeat(60)}${"p".repeat(10)}`, "the precision items sit in one block after the main findings");
  assert.equal(kinds, "fffffffffffpfffffpfffpffffffffffpfpfffpfffpfpffffffffffffffpffffpfffff");
  // (c) The same items with the same kinds, and the reports last, in their old order.
  const kindOf = new Map([...DRAWN_FINDINGS.map((id) => [`${id}#0`, "finding"]), ...DRAWN_PRECISION.map((id) => [`${id}#0`, "precision"])]);
  assert.deepEqual(blind.map((i) => i.id).sort(), [...kindOf.keys()].sort());
  for (const it of blind) assert.equal(it.kind, kindOf.get(it.id), it.id);
  assert.deepEqual(
    items.slice(blind.length).map((i) => [i.kind, i.id]),
    DRAWN_REPORTS.map((id) => ["report", id])
  );
  // answers.json and meta.json stay in draw order.
  const answers = JSON.parse(fs.readFileSync(path.join(one.dir, "answers.json"), "utf8"));
  assert.deepEqual(Object.keys(answers), [...kindOf.keys()]);
  for (const [id, answer] of Object.entries(answers)) assert.equal(answer, id[2] === "a" ? "supports" : "contradicts", id);
  const meta = JSON.parse(fs.readFileSync(path.join(one.dir, "meta.json"), "utf8"));
  assert.deepEqual(meta.groups, DRAWN_FINDINGS.map((id) => groups[Number(id.slice(0, 2))]));
  assert.deepEqual(meta.counts, { findings: 60, precision: 10, reports: 20 });
  assert.deepEqual([one.findings, one.precision, one.reports], [60, 10, 20]);
});

// The shuffle exists for the labelling screen, so the screen must follow it:
// no sorting or grouping by kind, and no word that names the precision kind.
test("the labelling screen shows the items in the shuffled order and never names the precision kind", async (t) => {
  const { s } = blindFixture(t);
  const drawn = sample("screen", s.at("2026-10-22T00:00:00.000Z"));
  const items = readItems(drawn.dir);
  const env = cleanEnv(s.tempDir, { ORCH_DATA_DIR: s.dataDir });
  const input = items.map((i) => (i.kind === "report" ? "y\ny" : "s")).join("\n");
  const result = await runNode("scripts/orch-label.mjs", { args: ["label", drawn.dir], stdin: `${input}\n`, env });
  assert.equal(result.code, 0, result.stderr);
  const blocks = result.stdout.split(/\n=== \d+ of \d+ ===\n/).slice(1);
  const shown = blocks.filter((b) => b.startsWith("Finding (")).map((b) => `${b.split("\n")[1].replace(/^finding /, "")}#0`);
  assert.deepEqual(shown, items.filter((i) => i.kind !== "report").map((i) => i.id));
  assert.equal(shown.length, 70);
  assert.doesNotMatch(result.stdout, /precision/i);
});

test("label works from stdin and never needs the answers; score refuses early and runs once", async (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 1 }, s.env);
  for (const group of groupKeys("evaluation", 3)) addResult(s, { group });
  const drawn = sample("l", s.at("2026-10-22T00:00:00.000Z"));
  assert.throws(() => score(drawn.dir, s.env), /not labelled/);
  // Labelling must not depend on the answers: remove them during labelling.
  const answers = fs.readFileSync(path.join(drawn.dir, "answers.json"));
  fs.rmSync(path.join(drawn.dir, "answers.json"));
  const env = cleanEnv(s.tempDir, { ORCH_DATA_DIR: s.dataDir });
  const items = readItems(drawn.dir);
  const input = items.map((i) => (i.kind === "report" ? "y\ny" : "s")).join("\n");
  const result = await runNode("scripts/orch-label.mjs", { args: ["label", drawn.dir], stdin: `${input}\n`, env });
  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /supports|contradicts/);
  fs.writeFileSync(path.join(drawn.dir, "answers.json"), answers);
  const scored = score(drawn.dir, s.env);
  assert.equal(scored.harm.n, 3);
  assert.throws(() => score(drawn.dir, s.env), /scored already/);
});

const item = (id, kind = "finding", extra = {}) => ({ id, kind, ...extra });

function worked({ supported, harms, contradicted, found, coverageSupportsOf = null, reports = 20, complete = 17 }) {
  const items = [];
  const labels = {};
  const answers = {};
  for (let i = 0; i < supported; i += 1) {
    items.push(item(`s${i}#0`));
    labels[`s${i}#0`] = "s";
    answers[`s${i}#0`] = i < harms ? "contradicts" : "supports";
  }
  for (let i = 0; i < contradicted; i += 1) {
    items.push(item(`c${i}#0`));
    labels[`c${i}#0`] = "c";
    answers[`c${i}#0`] = i < found ? "contradicts" : "insufficient";
  }
  if (coverageSupportsOf !== null) {
    for (const [id, answer] of Object.entries(answers)) answers[id] = answer === "contradicts" ? answer : "insufficient";
    const ids = Object.keys(answers).filter((id) => answers[id] !== "contradicts");
    ids.slice(0, coverageSupportsOf).forEach((id) => (answers[id] = "supports"));
  }
  for (let i = 0; i < reports; i += 1) {
    items.push(item(`r${i}`, "report", { parse_state: "parsed" }));
    labels[`r${i}`] = { allFound: i < complete, boundariesRight: true, missed: 0 };
  }
  return evaluate(items, labels, answers);
}

test("worked cases of the frozen bar", () => {
  const pass = worked({ supported: 30, harms: 0, contradicted: 8, found: 4 });
  assert.equal(pass.overall, "PASS", JSON.stringify(pass));
  assert.equal(worked({ supported: 28, harms: 0, contradicted: 8, found: 4 }).harm.verdict, "NOT DECIDABLE");
  assert.equal(worked({ supported: 28, harms: 0, contradicted: 8, found: 4 }).overall, "NOT DECIDABLE");
  assert.equal(worked({ supported: 46, harms: 3, contradicted: 8, found: 4 }).harm.verdict, "FAIL");
  assert.equal(worked({ supported: 46, harms: 1, contradicted: 8, found: 4 }).harm.verdict, "PASS");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 3 }).use.verdict, "FAIL");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 7, found: 7 }).use.verdict, "NOT DECIDABLE");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 4, complete: 15 }).parsing.verdict, "FAIL");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 4, complete: 15 }).overall, "FAIL");
  // Exact boundaries: 29 supported with no harm is decidable (and passes); 16 of 20 reports is exactly 80 percent.
  assert.equal(worked({ supported: 29, harms: 0, contradicted: 8, found: 4 }).harm.verdict, "PASS");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 4, complete: 16 }).parsing.verdict, "PASS");
  // A FAIL wins over a NOT DECIDABLE in the overall verdict.
  const mixed = worked({ supported: 20, harms: 0, contradicted: 8, found: 4, complete: 10 });
  assert.deepEqual([mixed.harm.verdict, mixed.parsing.verdict, mixed.overall], ["NOT DECIDABLE", "FAIL", "FAIL"]);
  // 38 labelled: 4 contradicts plus 15 supports covers 19 of 38 = 50 percent: pass; 14 supports: fail.
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 4, coverageSupportsOf: 15 }).coverage.verdict, "PASS");
  assert.equal(worked({ supported: 30, harms: 0, contradicted: 8, found: 4, coverageSupportsOf: 14 }).coverage.verdict, "FAIL");
});

test("errors are left out of harm and count as not covered; skips are counted apart", () => {
  const items = [item("a#0"), item("b#0"), item("c#0")];
  const result = evaluate(items, { "a#0": "s", "b#0": "s", "c#0": "skip" }, { "a#0": "error", "b#0": "supports", "c#0": "supports" });
  assert.equal(result.harm.n, 1);
  assert.deepEqual([result.coverage.k, result.coverage.n], [1, 2]);
  assert.equal(result.skipped, 1);
});

test("the labelling screen shows a Codex job's reviewed commit, not the HEAD at triage time", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 7 }, s.env);
  const [group] = groupKeys("evaluation", 1);
  const id = addResult(s, { group });
  // Turn the stored result into a Codex job's: reviewed commit b..., HEAD a..., dirty.
  const doneDir = path.join(s.dataDir, "triage", "done");
  for (const name of fs.readdirSync(doneDir)) {
    const file = path.join(doneDir, name);
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    if (result.report_id === id) {
      Object.assign(result, { job_id: "job-1", reviewed_commit: "b".repeat(40) });
      result.repo.dirty = true;
      fs.writeFileSync(file, JSON.stringify(result));
    }
  }
  const drawn = sample("c", s.at("2026-10-22T00:00:00.000Z"));
  const [finding] = readItems(drawn.dir).filter((i) => i.kind !== "report");
  assert.deepEqual([finding.head, finding.dirty], ["b".repeat(40), false]);
});

test("outcomes where no excerpt went to Jev are never answers", () => {
  const outcomes = ["stale_evidence", "missing_provenance", "unverifiable_scope", "outside_checkout"];
  const items = [...outcomes.map((o) => item(`${o}#0`)), item("ok#0")];
  const labels = Object.fromEntries(items.map((i) => [i.id, "s"]));
  const answers = { ...Object.fromEntries(outcomes.map((o) => [`${o}#0`, o])), "ok#0": "supports" };
  const result = evaluate(items, labels, answers);
  assert.equal(result.harm.n, 1, "only the real answer enters the harm count");
  assert.deepEqual([result.coverage.k, result.coverage.n], [1, 5]);
});

test("status: the tripwire fires on day 7 with 14 groups, not with 15, not on day 6, and the same after a restart", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END }, s.env);
  const groups = groupKeys("evaluation", 15);
  for (const group of groups.slice(0, 14)) addResult(s, { group });
  // One uncited finding in a group that counts already: 15 parsed, 14 usable, still 14 groups,
  // so the two numbers in the text differ and their order is checked.
  addResult(s, { group: groups[0], cited: false });
  assert.equal(status(s.at("2026-10-07T12:00:00.000Z")).tripwire, false, "day 6");
  assert.equal(status(s.at("2026-10-08T00:00:00.000Z")).tripwire, true, "day 7 with 14 groups");
  const line = statusLine(s.at("2026-10-08T00:00:00.000Z"));
  assert.match(line, /^TRIPWIRE: Finding triage, day 7 of the window: 14 eligible change groups of 60, .*Stop waiting/);
  // The action names the measured excerpt share and no file of the development repository.
  assert.match(line, /14 of 15 parsed findings have a usable code excerpt/);
  assert.doesNotMatch(line, /\.claude\/|development repository/);
  addResult(s, { group: groups[14] });
  // A new process reads the same files: state lives in files only.
  assert.equal(status(s.at("2026-10-08T00:00:00.000Z")).tripwire, false, "day 7 with 15 groups");
  assert.doesNotMatch(statusLine(s.at("2026-10-08T00:00:00.000Z")), /TRIPWIRE/);
});

test("status counts hand-back misses only over the results whose hand-back was checked", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END }, s.env);
  const groups = groupKeys("evaluation", 10);
  // 8 checked results, and the hand-back of 1 of them was missing.
  groups.slice(0, 8).forEach((group, n) => addResult(s, { group, handbackChecked: true, handbackMissing: n === 3 }));
  // 2 results whose hand-back was never checked. Their missing flag is set, so
  // they would raise both numbers if they were counted.
  for (const group of groups.slice(8)) addResult(s, { group, handbackChecked: false, handbackMissing: true });
  const now = status(s.at("2026-10-05T00:00:00.000Z"));
  assert.deepEqual([now.handbackMissing, now.handbackChecked], [1, 8]);
  assert.match(statusLine(s.at("2026-10-05T00:00:00.000Z")), /hand-back missing 1 of 8\./);
});

function labelAll(dir) {
  for (const it of readItems(dir)) saveLabel(dir, it.id, it.kind === "report" ? { allFound: true, boundariesRight: true, missed: 0 } : "s");
}

// The pools file is written through a temporary file named after the process
// id, then renamed. score() runs in this process, so a folder at that name makes
// the pools write fail after meta.json was written.
function blockPoolsWrite(env) {
  const blocker = `${poolsFile(env)}.${process.pid}.tmp`;
  fs.mkdirSync(blocker);
  return () => fs.rmSync(blocker, { recursive: true });
}

test("a score stopped between its two writes finishes with the saved result and never evaluates again", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 1 }, s.env);
  for (const group of groupKeys("evaluation", 3)) addResult(s, { group });
  const drawn = sample("half", s.at("2026-10-22T00:00:00.000Z"));
  labelAll(drawn.dir);
  const items = readItems(drawn.dir);
  const answers = JSON.parse(fs.readFileSync(path.join(drawn.dir, "answers.json"), "utf8"));
  const first = evaluate(items, readLabels(drawn.dir), answers);
  const poolsBefore = fs.readFileSync(poolsFile(s.env), "utf8");

  const unblock = blockPoolsWrite(s.env);
  assert.throws(() => score(drawn.dir, s.at("2026-10-23T00:00:00.000Z")), /EISDIR/);
  unblock();
  // meta.json is the commit point: it holds the one result. pools.json did not change.
  const meta = JSON.parse(fs.readFileSync(path.join(drawn.dir, "meta.json"), "utf8"));
  assert.deepEqual([meta.scored, meta.scoredAt, meta.result], [true, "2026-10-23T00:00:00.000Z", first]);
  assert.equal(fs.readFileSync(poolsFile(s.env), "utf8"), poolsBefore);
  assert.equal(status(s.at("2026-10-23T00:00:00.000Z")).state, "awaiting_score");

  // Change every finding label now. A second evaluation would see the change.
  for (const it of items) if (it.kind !== "report") saveLabel(drawn.dir, it.id, "c");
  const changed = evaluate(items, readLabels(drawn.dir), answers);
  assert.notDeepEqual(changed, first, "the changed labels give another result");

  const finished = score(drawn.dir, s.at("2026-10-24T00:00:00.000Z"));
  assert.deepEqual(finished, first);
  const pools = JSON.parse(fs.readFileSync(poolsFile(s.env), "utf8"));
  assert.deepEqual(pools.scoredVersions, [meta.evalVersion]);
  assert.deepEqual(pools.exposedGroups, meta.groups);
  // The first score time stays; finishing it writes meta.json no more.
  assert.equal(JSON.parse(fs.readFileSync(path.join(drawn.dir, "meta.json"), "utf8")).scoredAt, "2026-10-23T00:00:00.000Z");
  assert.equal(status(s.at("2026-10-24T00:00:00.000Z")).state, "scored");
  assert.throws(() => score(drawn.dir, s.env), /scored already/);
});

test("a meta.json that says scored but holds no result is refused by name and never evaluated", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 1 }, s.env);
  for (const group of groupKeys("evaluation", 2)) addResult(s, { group });
  const drawn = sample("old", s.at("2026-10-22T00:00:00.000Z"));
  labelAll(drawn.dir);
  // The shape an older score() left when its pools write failed.
  const metaFile = path.join(drawn.dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  const poolsBefore = fs.readFileSync(poolsFile(s.env), "utf8");
  // No result, and results that are not an object of rules: none may reach the pools.
  for (const result of [undefined, null, "PASS", 3, []]) {
    fs.writeFileSync(metaFile, JSON.stringify({ ...meta, scored: true, scoredAt: "2026-10-23T00:00:00.000Z", result }));
    assert.throws(
      () => score(drawn.dir, s.env),
      (error) => error.message.startsWith(`${metaFile} says the sample was scored, but it holds no saved result.`),
      JSON.stringify(result)
    );
    assert.equal(fs.readFileSync(poolsFile(s.env), "utf8"), poolsBefore, JSON.stringify(result));
    assert.deepEqual(JSON.parse(fs.readFileSync(metaFile, "utf8")).result, result, JSON.stringify(result));
  }
});

test("status: after the score the daily line ends, and the status command says the version was scored", async (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 1 }, s.env);
  for (const group of groupKeys("evaluation", 2)) addResult(s, { group });
  const drawn = sample("done", s.at("2026-10-22T00:00:00.000Z"));
  labelAll(drawn.dir);
  score(drawn.dir, s.at("2026-10-23T00:00:00.000Z"));
  // The scored groups are exposed now, so the window has fewer than 15 eligible
  // groups, long after day 7: the old line showed the tripwire here every day.
  for (const when of ["2026-10-23T00:00:00.000Z", "2026-12-01T00:00:00.000Z"]) {
    const line = statusLine(s.at(when));
    assert.equal(line, null, `${when}: ${line}`);
    assert.doesNotMatch(String(line), /TRIPWIRE|day \d+ of the window/);
    assert.equal(status(s.at(when)).state, "scored");
  }
  const env = cleanEnv(s.tempDir, { ORCH_DATA_DIR: s.dataDir, ORCH_LABEL_NOW: "2026-10-24T00:00:00.000Z" });
  const result = await runNode("scripts/orch-label.mjs", { args: ["status"], env });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /was scored/);
  assert.match(result.stdout, /model jev-1\.13\.0/);
  assert.doesNotMatch(result.stdout, /No window is registered|TRIPWIRE|day \d+ of the window/);
  // Positive control: with no window, the command says so.
  const empty = setUp(t);
  const none = await runNode("scripts/orch-label.mjs", { args: ["status"], env: cleanEnv(empty.tempDir, { ORCH_DATA_DIR: empty.dataDir }) });
  assert.match(none.stdout, /No window is registered/);
});

test("status: an ended window says to run sample, and after a sample says to label and score it", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 2 }, s.env);
  for (const group of groupKeys("evaluation", 3)) addResult(s, { group });
  const ended = s.at("2026-10-22T00:00:00.000Z");
  const before = statusLine(ended);
  assert.match(before, /window ended on 2026-10-21/);
  assert.match(before, /sample --name/);
  assert.doesNotMatch(before, /TRIPWIRE|day \d+/);
  assert.equal(status(ended).state, "awaiting_sample");
  const drawn = sample("drawn", ended);
  const after = statusLine(s.at("2026-10-23T00:00:00.000Z"));
  assert.match(after, /window ended on 2026-10-21/);
  assert.match(after, /label .*score/);
  assert.ok(after.includes(drawn.dir), after);
  assert.doesNotMatch(after, /TRIPWIRE|day \d+|sample --name/);
  assert.equal(status(s.at("2026-10-23T00:00:00.000Z")).state, "awaiting_score");
});

test("status: a damaged meta.json under labels names its file after the end; a meta that is not an object never matches", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 2 }, s.env);
  for (const group of groupKeys("evaluation", 3)) addResult(s, { group });
  // A folder of an earlier window, with a meta.json that is not valid JSON.
  const damaged = path.join(s.dataDir, "labels", "2026-09-01", "older", "meta.json");
  fs.mkdirSync(path.dirname(damaged), { recursive: true });
  fs.writeFileSync(damaged, "{not json");
  // Before the end, status never reads the samples, so it still works.
  assert.equal(status(s.at("2026-10-05T00:00:00.000Z")).state, "collecting");
  const ended = s.at("2026-10-22T00:00:00.000Z");
  assert.throws(
    () => status(ended),
    (error) => error.message.startsWith(`${damaged} could not be read: `)
  );
  // A meta.json that holds JSON null or a list is no sample of this window.
  fs.writeFileSync(damaged, "null");
  const other = path.join(s.dataDir, "labels", "2026-09-02", "list", "meta.json");
  fs.mkdirSync(path.dirname(other), { recursive: true });
  fs.writeFileSync(other, "[1, 2]");
  assert.equal(status(ended).state, "awaiting_sample");
  // Positive control: a real sample next to them is still found.
  const drawn = sample("drawn", ended);
  const after = status(s.at("2026-10-23T00:00:00.000Z"));
  assert.equal(after.state, "awaiting_score");
  assert.equal(after.sample, drawn.dir);
});

test("status and sample agree on the moment the window ends", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 2 }, s.env);
  for (const group of groupKeys("evaluation", 3)) addResult(s, { group });
  const atEnd = s.at(END);
  const justAfter = s.at(new Date(Date.parse(END) + 1).toISOString());
  assert.throws(() => sample("x", atEnd), /window ends/);
  assert.equal(status(atEnd).state, "collecting");
  assert.match(statusLine(atEnd), /day 20 of the window/);
  assert.equal(status(justAfter).state, "awaiting_sample");
  assert.ok(sample("x", justAfter).dir);
});

test("status: a window that has not started shows its start date and no negative day", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END }, s.env);
  const early = s.at("2026-09-28T00:00:00.000Z");
  const line = statusLine(early);
  assert.match(line, /window starts on 2026-10-01/);
  assert.doesNotMatch(line, /day -|TRIPWIRE/);
  const now = status(early);
  assert.equal(now.state, "not_started");
  assert.ok(!(now.day < 0), `day ${now.day}`);
});

test("status: the day count stops at the window length", (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END }, s.env);
  assert.equal(status(s.at("2026-10-11T00:00:00.000Z")).day, 10);
  assert.equal(status(s.at(END)).day, 20);
  assert.equal(status(s.at("2026-11-30T00:00:00.000Z")).day, 20);
  assert.equal(status(s.at("2026-11-30T00:00:00.000Z")).tripwire, false, "no tripwire after the end");
});

test("saveLabel writes labels privately and keeps earlier answers", (t) => {
  const s = setUp(t);
  const dir = path.join(s.dataDir, "labels", "x");
  saveLabel(dir, "a", "s");
  saveLabel(dir, "b", "c");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "labels.json"), "utf8")), { a: "s", b: "c" });
  assert.equal(fs.statSync(path.join(dir, "labels.json")).mode & 0o077, 0);
});

test("after a scored evaluation, a new window needs a changed version, and the old one is kept", async (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 1 }, s.env);
  assert.throws(() => register({ start: START, end: END }, s.env), /not scored yet/);
  for (const group of groupKeys("evaluation", 2)) addResult(s, { group });
  const drawn = sample("v1", s.at("2026-10-22T00:00:00.000Z"));
  for (const it of readItems(drawn.dir)) saveLabel(drawn.dir, it.id, it.kind === "report" ? { allFound: true, boundariesRight: true, missed: 0 } : "s");
  score(drawn.dir, s.env);
  // Same version: refused. Changed model: accepted, and the old window is in the history.
  assert.throws(() => register({ start: END, end: "2026-11-30T00:00:00.000Z" }, s.env), /scored already/);
  fs.writeFileSync(path.join(s.dataDir, "config.json"), JSON.stringify({ jevModel: "jev-1.14.0", triageMode: "log", triageProjects: [s.checkout] }));
  const second = register({ start: END, end: "2026-11-30T00:00:00.000Z" }, s.env);
  assert.equal(second.evalVersion.model, "jev-1.14.0");
  const pools = JSON.parse(fs.readFileSync(poolsFile(s.env), "utf8"));
  assert.equal(pools.history.length, 1);
  assert.equal(pools.history[0].evalVersion.model, "jev-1.13.0");
  assert.ok(pools.exposedGroups.length >= 1, "exposed groups survive the new registration");
});

test("the labelling screen shows every parsed finding in full", async (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 2 }, s.env);
  const group = groupKeys("evaluation", 1)[0];
  const id = addResult(s, { group });
  // Give the report a two-line finding.
  const doneDir = path.join(s.dataDir, "triage", "done");
  for (const name of fs.readdirSync(doneDir)) {
    const file = path.join(doneDir, name);
    const result = JSON.parse(fs.readFileSync(file, "utf8"));
    if (result.report_id === id) {
      result.findings[0].text = "first line of the finding\nsecond line with the reason";
      fs.writeFileSync(file, JSON.stringify(result));
    }
  }
  const drawn = sample("full", s.at("2026-10-22T00:00:00.000Z"));
  const env = cleanEnv(s.tempDir, { ORCH_DATA_DIR: s.dataDir });
  const result = await runNode("scripts/orch-label.mjs", { args: ["label", drawn.dir], stdin: "s\ny\ny\n", env });
  assert.match(result.stdout, /--- finding 1 \[P1\] ---\nfirst line of the finding\nsecond line with the reason/);
});

test("a Codex-only population keeps Claude and host reviews out of every sample", (t) => {
  const s = setUp(t, { reviewFormats: [{ agentTypes: ["acme:review-bot"], labels: ["MUST-FIX"] }] });
  reserve(s.env);
  assert.throws(() => register({ start: START, end: END, agentTypes: ["acme:unknown"] }, s.env), /Not a reviewer type/);
  const reg = register({ start: START, end: END, seed: 4, agentTypes: ["subagent-router:codex-reviewer"] }, s.env);
  assert.deepEqual(reg.population.agentTypes, ["subagent-router:codex-reviewer"]);
  const groups = groupKeys("evaluation", 9);
  for (const group of groups.slice(0, 3)) addResult(s, { group });
  for (const group of groups.slice(3, 6)) addResult(s, { group, agentType: "subagent-router:reviewer" });
  for (const group of groups.slice(6, 9)) addResult(s, { group, agentType: "acme:review-bot" });
  const drawn = sample("codex", s.at("2026-10-22T00:00:00.000Z"));
  const items = readItems(drawn.dir);
  assert.equal(drawn.findings, 3);
  for (const it of items) assert.equal(it.agent_type, "subagent-router:codex-reviewer", `${it.kind} ${it.id}`);
  // Positive control: without a chosen subset, all three kinds are in the population.
  const all = setUp(t, { reviewFormats: [{ agentTypes: ["acme:review-bot"], labels: ["MUST-FIX"] }] });
  reserve(all.env);
  assert.ok(register({ start: START, end: END }, all.env).population.agentTypes.includes("acme:review-bot"));
});

test("label asks how many were missed only after a no, and asks again on an answer it cannot use", async (t) => {
  const s = setUp(t);
  reserve(s.env);
  register({ start: START, end: END, seed: 2 }, s.env);
  for (const group of groupKeys("evaluation", 2)) addResult(s, { group });
  const drawn = sample("reports", s.at("2026-10-22T00:00:00.000Z"));
  const reports = readItems(drawn.dir).filter((i) => i.kind === "report");
  assert.equal(reports.length, 2);
  // Findings first: skip them, so only the report answers matter.
  const findings = readItems(drawn.dir).filter((i) => i.kind !== "report");
  for (const it of findings) saveLabel(drawn.dir, it.id, "skip");
  const env = cleanEnv(s.tempDir, { ORCH_DATA_DIR: s.dataDir });
  // Report 1: "y", "y" and no third question. Report 2: a bad answer, "n", a bad answer,
  // "y", then 0 (refused after a no) and 2.
  const result = await runNode("scripts/orch-label.mjs", { args: ["label", drawn.dir], stdin: "y\ny\nmaybe\nn\nx\ny\n0\n2\n", env });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.match(/How many findings did it miss/g)?.length, 2, "asked once for report 2, then again after the 0");
  const labels = readLabels(drawn.dir);
  assert.deepEqual(labels[reports[0].id], { allFound: true, boundariesRight: true, missed: 0 });
  assert.deepEqual(labels[reports[1].id], { allFound: false, boundariesRight: true, missed: 2 });
});
