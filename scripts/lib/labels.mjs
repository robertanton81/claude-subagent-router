// The evaluation of the finding triage: a registered window, blind samples, the
// user's labels and one scored look against a frozen bar.
//
// The bar and the rules below were fixed before any data was seen, so the score
// cannot be tuned to the data. Changing one of them means a new evaluation, not
// a new score.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { REVIEWER_SET, loadConfig } from "./config.mjs";
import { repoIdentity } from "./evidence.mjs";
import { ensurePrivateDir } from "./log.mjs";
import { labelsDir, poolOf, poolsFile } from "./pools.mjs";
import { evalVersion } from "./questions.mjs";
import { clopperPearsonLower, clopperPearsonUpper } from "./stats.mjs";
import { loadDoneResults } from "./triage-state.mjs";

// Frozen constants of the bar.
export const HARM_BOUND = 0.1;
export const HARM_MIN_SUPPORTED = 29;
export const USE_MIN = 8;
export const USE_RATE = 0.5;
export const COVERAGE_RATE = 0.5;
export const PARSE_COMPLETE_RATE = 0.8;
export const SAMPLE_GROUPS = 60;
export const REPORT_SAMPLE = 20;
export const PRECISION_SAMPLE = 20;
export const TRIPWIRE_DAY = 7;
export const TRIPWIRE_GROUPS = 15;

// Outcomes where no excerpt went to Jev: never an answer to label.
const NOT_ANSWERS = new Set(["error", "skipped_budget", "withheld_secret", "no_citation", "stale_evidence", "missing_provenance", "unverifiable_scope", "outside_checkout"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export function nowMs(env = process.env) {
  return env.ORCH_LABEL_NOW ? Date.parse(env.ORCH_LABEL_NOW) : Date.now();
}

function writePrivate(file, value) {
  ensurePrivateDir(path.dirname(file));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readPools(env = process.env) {
  const file = poolsFile(env);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A small seeded random source (mulberry32), so a sample can be drawn again.
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, next) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function reserve(env = process.env) {
  if (readPools(env)) {
    throw new Error("The pools are already reserved. They never change, so tuning and evaluation stay apart.");
  }
  const pools = { rule: { split: 0.7, unit: "change_group" }, reservedAt: new Date(nowMs(env)).toISOString(), registration: null, exposedGroups: [], scoredVersions: [] };
  writePrivate(poolsFile(env), pools);
  return pools;
}

export function register({ start, end, seed, agentTypes: chosen }, env = process.env) {
  const pools = readPools(env);
  if (!pools) throw new Error('Run "reserve" first.');
  const { config } = loadConfig(env);
  if (/-latest$/.test(config.jevModel)) throw new Error(`jevModel is "${config.jevModel}". Pin an exact version before registering.`);
  if (pools.registration) {
    // A finished evaluation is kept in the history; a new one needs a changed
    // version, because a version is scored once.
    if (!pools.scoredVersions.some((v) => sameJson(v, pools.registration.evalVersion))) {
      throw new Error("A window is already registered and not scored yet. Score it first.");
    }
    pools.history = [...(pools.history ?? []), pools.registration];
    pools.registration = null;
  }
  if (pools.scoredVersions.some((v) => sameJson(v, evalVersion(config)))) {
    throw new Error("This evaluation version was scored already. Change the questions, the parser, the evidence rules or the model first, and record why.");
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("--start and --end must be dates, and the end must come after the start.");
  // The population's reviewer types: all known reviewers, or a chosen subset
  // (for example the Codex reviewer alone), frozen with the window.
  const known = [...REVIEWER_SET, ...config.reviewFormats.flatMap((f) => f.agentTypes)];
  const agentTypes = (chosen && chosen.length ? [...new Set(chosen)] : known).sort();
  const unknown = agentTypes.filter((type) => !known.includes(type));
  if (unknown.length > 0) throw new Error(`Not a reviewer type the triage knows: ${unknown.join(", ")}. Known: ${known.join(", ")}.`);
  const projects = projectsOf(config);
  if (projects.missing.length > 0) {
    throw new Error(`triageWorktrees is on, but git names no repository for: ${projects.missing.join(", ")}. Fix or remove the entry before registering.`);
  }
  pools.registration = {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    registeredAt: new Date(nowMs(env)).toISOString(),
    evalVersion: evalVersion(config),
    population: { triageProjects: projects.triageProjects, triageWorktrees: projects.triageWorktrees, commonDirs: projects.commonDirs, agentTypes },
    eligibility: "evaluation pool; known change group; at least one cited finding with a usable excerpt",
    seed: Number.isInteger(seed) ? seed : Math.floor(nowMs(env) % 2147483647),
    choice: "one seeded random eligible finding per change group; a seeded random 60 groups when more qualify"
  };
  writePrivate(poolsFile(env), pools);
  return pools.registration;
}

function inWindow(result, registration) {
  const ts = Date.parse(result.ts ?? "");
  return Number.isFinite(ts) && ts >= Date.parse(registration.start) && ts <= Date.parse(registration.end);
}

// A stored root may be gone by now (a deleted worktree); the stored path is
// then compared as it is.
function realOrSame(root) {
  try {
    return fs.realpathSync(root);
  } catch {
    return root;
  }
}

// The checkout part of the population, frozen at registration. With
// triageWorktrees, the repositories (git common directories) of the listed
// checkouts are frozen too, so a worktree that existed later still counts.
// A listed checkout whose repository git cannot name is in `missing`; register
// refuses then, so a population is never frozen without it in silence.
function projectsOf(config) {
  const triageProjects = config.triageProjects.map(realOrSame).sort();
  const missing = [];
  const commonDirs = new Set();
  if (config.triageWorktrees) {
    for (const root of triageProjects) {
      const identity = repoIdentity(root);
      if (identity.commonDir) commonDirs.add(identity.commonDir);
      else missing.push(`${root} (${identity.error})`);
    }
  }
  return { triageProjects, triageWorktrees: config.triageWorktrees === true, commonDirs: [...commonDirs].sort(), missing };
}

function inPopulation(result, registration) {
  const population = registration.population;
  if (!population.agentTypes.includes(result.agent_type)) return false;
  const root = result.repo?.root ? realOrSame(result.repo.root) : null;
  if (population.triageProjects.includes(root)) return true;
  return population.triageWorktrees === true && typeof result.repo?.common_dir === "string" && (population.commonDirs ?? []).includes(result.repo.common_dir);
}

const usable = (finding) => finding.citation && typeof finding.excerpt === "string";

// Every result of the registered window and population, in the evaluation pool.
export function windowResults(pools, env = process.env) {
  const reg = pools.registration;
  return loadDoneResults(env).filter((r) => r.event === "triage" && sameJson(r.eval_version, reg.evalVersion) && inWindow(r, reg) && inPopulation(r, reg) && poolOf(r.change_group) === "evaluation");
}

export function eligibleGroups(results, exposed = []) {
  const groups = new Map();
  for (const result of results) {
    if (!result.group_eligible || exposed.includes(result.change_group)) continue;
    for (const finding of result.findings ?? []) {
      if (!usable(finding)) continue;
      const list = groups.get(result.change_group) ?? [];
      list.push({ result, finding });
      groups.set(result.change_group, list);
    }
  }
  return groups;
}

// The window is open up to and including its end. sample() and status() both
// use this one check, so they never disagree about whether the window ended.
function windowEnded(reg, now) {
  return now > Date.parse(reg.end);
}

export function sample(name, env = process.env) {
  const pools = readPools(env);
  const reg = pools?.registration;
  if (!reg) throw new Error('No window is registered. Run "register --start <date> --end <date>".');
  if (!windowEnded(reg, nowMs(env))) throw new Error(`The window ends ${reg.end}. The sample is drawn after that, never before.`);
  const { config } = loadConfig(env);
  const now = projectsOf(config);
  if (!sameJson(now.triageProjects, reg.population.triageProjects) || now.triageWorktrees !== (reg.population.triageWorktrees === true)) {
    throw new Error("triageProjects or triageWorktrees changed since the window was registered. A changed population needs a new registration after this one is scored.");
  }
  if (pools.scoredVersions.some((v) => sameJson(v, reg.evalVersion))) throw new Error("This evaluation version was scored already. A version is scored once.");
  const next = random(reg.seed);
  const results = windowResults(pools, env);
  const groups = eligibleGroups(results, pools.exposedGroups);
  const groupKeys = shuffle([...groups.keys()].sort(), next).slice(0, SAMPLE_GROUPS);
  const items = [];
  const answers = {};
  for (const key of groupKeys) {
    const choices = groups.get(key);
    const { result, finding } = choices[Math.floor(next() * choices.length)];
    items.push(findingItem("finding", result, finding));
    answers[finding.finding_id] = finding.outcome;
  }
  const picked = new Set(groupKeys);
  const precision = shuffle(
    [...groups.entries()].filter(([key]) => !picked.has(key)).flatMap(([, list]) => list.filter(({ finding }) => finding.outcome === "contradicts")),
    next
  ).slice(0, PRECISION_SAMPLE);
  for (const { result, finding } of precision) {
    items.push(findingItem("precision", result, finding));
    answers[finding.finding_id] = finding.outcome;
  }
  for (const result of shuffle(results, next).slice(0, REPORT_SAMPLE)) {
    items.push({ kind: "report", id: result.report_id, agent_type: result.agent_type, parse_state: result.parse?.state, snapshot: result.snapshot ?? null, items: (result.findings ?? []).map((f) => ({ label: f.label, text: f.text })) });
  }
  const dir = path.join(labelsDir(env), new Date(nowMs(env)).toISOString().slice(0, 10), name);
  if (fs.existsSync(dir)) throw new Error(`${dir} exists already.`);
  writePrivate(path.join(dir, "items.json"), items);
  writePrivate(path.join(dir, "answers.json"), answers);
  writePrivate(path.join(dir, "meta.json"), { drawnAt: new Date(nowMs(env)).toISOString(), evalVersion: reg.evalVersion, seed: reg.seed, groups: groupKeys, counts: { findings: groupKeys.length, precision: precision.length, reports: Math.min(REPORT_SAMPLE, results.length) }, scored: false });
  return { dir, findings: groupKeys.length, precision: precision.length, reports: Math.min(REPORT_SAMPLE, results.length) };
}

// A Codex job's excerpt is proven equal to the reviewed commit's file, so the
// screen shows that commit as clean, not the checkout's HEAD at triage time.
function findingItem(kind, result, finding) {
  const job = typeof result.job_id === "string";
  return {
    kind,
    id: finding.finding_id,
    agent_type: result.agent_type,
    label: finding.label,
    text: finding.text,
    path: finding.citation.path,
    lines: `${finding.citation.start}-${finding.citation.end}`,
    excerpt: finding.excerpt,
    head: job ? (result.reviewed_commit ?? null) : (result.repo?.head ?? null),
    dirty: job ? false : (result.repo?.dirty ?? null)
  };
}

export function readItems(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "items.json"), "utf8"));
}

export function readLabels(dir) {
  const file = path.join(dir, "labels.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

export function saveLabel(dir, id, label) {
  const labels = readLabels(dir);
  labels[id] = label;
  writePrivate(path.join(dir, "labels.json"), labels);
}

// One verdict per rule and one overall. NOT DECIDABLE means only "too few labels".
export function evaluate(items, labels, answers) {
  const findings = items.filter((i) => i.kind === "finding");
  const labelled = findings.filter((i) => labels[i.id] && labels[i.id] !== "skip");
  const valid = (i) => !NOT_ANSWERS.has(answers[i.id]);

  const supported = labelled.filter((i) => labels[i.id] === "s" && valid(i));
  const harms = supported.filter((i) => answers[i.id] === "contradicts").length;
  const harmBound = clopperPearsonUpper(harms, supported.length);
  const harm = { n: supported.length, k: harms, bound: harmBound, verdict: supported.length < HARM_MIN_SUPPORTED ? "NOT DECIDABLE" : harmBound <= HARM_BOUND ? "PASS" : "FAIL" };

  const contradicted = labelled.filter((i) => labels[i.id] === "c" && valid(i));
  const found = contradicted.filter((i) => answers[i.id] === "contradicts").length;
  const use = { n: contradicted.length, k: found, lower: clopperPearsonLower(found, contradicted.length), verdict: contradicted.length < USE_MIN ? "NOT DECIDABLE" : found / contradicted.length >= USE_RATE ? "PASS" : "FAIL", pilot: contradicted.length < 16 };

  const covered = labelled.filter((i) => answers[i.id] === "supports" || answers[i.id] === "contradicts").length;
  const coverage = { n: labelled.length, k: covered, verdict: labelled.length === 0 ? "NOT DECIDABLE" : covered / labelled.length >= COVERAGE_RATE ? "PASS" : "FAIL" };

  const reports = items.filter((i) => i.kind === "report" && labels[i.id] && labels[i.id] !== "skip");
  const complete = reports.filter((i) => labels[i.id].allFound && labels[i.id].boundariesRight).length;
  const failedParse = items.filter((i) => i.kind === "report" && ["unparsed", "unavailable"].includes(i.parse_state)).length;
  const parsing = { n: reports.length, k: complete, unparsedOrUnavailable: failedParse, verdict: reports.length === 0 ? "NOT DECIDABLE" : complete / reports.length >= PARSE_COMPLETE_RATE ? "PASS" : "FAIL" };

  const precisionItems = items.filter((i) => i.kind === "precision" && labels[i.id] && labels[i.id] !== "skip");
  const precision = { n: precisionItems.length, k: precisionItems.filter((i) => labels[i.id] === "c").length };

  const verdicts = [harm, use, coverage, parsing].map((r) => r.verdict);
  const overall = verdicts.every((v) => v === "PASS") ? "PASS" : verdicts.includes("FAIL") ? "FAIL" : "NOT DECIDABLE";
  const skipped = items.filter((i) => labels[i.id] === "skip").length;
  const distinctReports = new Set(labelled.map((i) => i.id.split("#")[0])).size;
  return { harm, use, coverage, parsing, precision, overall, skipped, distinctReports };
}

export function score(dir, env = process.env) {
  const items = readItems(dir);
  const labels = readLabels(dir);
  const open = items.filter((i) => !(i.id in labels));
  if (open.length > 0) throw new Error(`${open.length} items are not labelled or skipped yet. Run "label ${dir}".`);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const pools = readPools(env);
  if (meta.scored || pools.scoredVersions.some((v) => sameJson(v, meta.evalVersion))) throw new Error("This evaluation version was scored already. A version is scored once.");
  const answers = JSON.parse(fs.readFileSync(path.join(dir, "answers.json"), "utf8"));
  const result = evaluate(items, labels, answers);
  meta.scored = true;
  meta.scoredAt = new Date(nowMs(env)).toISOString();
  writePrivate(path.join(dir, "meta.json"), meta);
  pools.scoredVersions.push(meta.evalVersion);
  pools.exposedGroups = [...new Set([...pools.exposedGroups, ...meta.groups])];
  writePrivate(poolsFile(env), pools);
  return result;
}

// The newest sample drawn for this registration, or null. sample() writes
// labels/<date>/<name>/meta.json with the version and the seed it drew with.
function drawnSample(reg, env) {
  const root = labelsDir(env);
  if (!fs.existsSync(root)) return null;
  const found = [];
  for (const day of fs.readdirSync(root, { withFileTypes: true })) {
    if (!day.isDirectory()) continue;
    for (const entry of fs.readdirSync(path.join(root, day.name), { withFileTypes: true })) {
      const file = path.join(root, day.name, entry.name, "meta.json");
      if (!entry.isDirectory() || !fs.existsSync(file)) continue;
      // One damaged file stops the status with its name. It is never skipped in
      // silence, because a skipped file could hide the sample of this window.
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`${file} could not be read: ${error.message}`);
      }
      // A meta that is not a plain object (null, a list, a number) is no sample.
      if (meta === null || typeof meta !== "object" || Array.isArray(meta)) continue;
      if (sameJson(meta.evalVersion, reg.evalVersion) && meta.seed === reg.seed) found.push({ dir: path.dirname(file), drawnAt: String(meta.drawnAt ?? "") });
    }
  }
  found.sort((a, b) => a.drawnAt.localeCompare(b.drawnAt) || a.dir.localeCompare(b.dir));
  return found.at(-1)?.dir ?? null;
}

// The state of the registered window: not_started, collecting, awaiting_sample
// (ended, no sample drawn), awaiting_score (ended, a sample drawn) or scored.
// null means no window is registered.
export function status(env = process.env) {
  const pools = readPools(env);
  const reg = pools?.registration;
  if (!reg) return null;
  // A version is scored once, so a scored window has nothing left to count.
  if (pools.scoredVersions.some((v) => sameJson(v, reg.evalVersion))) {
    return { state: "scored", start: reg.start, end: reg.end, evalVersion: reg.evalVersion };
  }
  const now = nowMs(env);
  const startMs = Date.parse(reg.start);
  const endMs = Date.parse(reg.end);
  const ended = windowEnded(reg, now);
  const sampleDir = ended ? drawnSample(reg, env) : null;
  const state = now < startMs ? "not_started" : !ended ? "collecting" : sampleDir ? "awaiting_score" : "awaiting_sample";
  const results = windowResults(pools, env);
  const groups = eligibleGroups(results, pools.exposedGroups);
  const findings = results.flatMap((r) => r.findings ?? []);
  const auto = results.filter((r) => r.handback_checked);
  // Full days since the start, never below 0 and never past the window's length.
  const day = state === "not_started" ? null : Math.floor((Math.min(now, endMs) - startMs) / DAY_MS);
  // The tripwire says to stop waiting, so it fires only while the window is open.
  const tripwire = state === "collecting" && day >= TRIPWIRE_DAY && groups.size < TRIPWIRE_GROUPS;
  return {
    state,
    start: reg.start,
    end: reg.end,
    day,
    windowDays: Math.floor((endMs - startMs) / DAY_MS),
    sample: sampleDir,
    eligibleGroups: groups.size,
    parsedFindings: findings.length,
    citedFindings: findings.filter((f) => f.citation).length,
    usableExcerpts: findings.filter(usable).length,
    errors: findings.filter((f) => f.outcome === "error").length,
    handbackMissing: auto.filter((r) => r.handback_missing).length,
    handbackChecked: auto.length,
    tripwire
  };
}

// What to do when the window fills too slowly. It names only what a user of the
// plugin has: the measured counts and this command, no development files.
export function tripwireAction(s) {
  return (
    `Stop waiting: at this pace the window will not reach ${SAMPLE_GROUPS} change groups. ` +
    `${s.usableExcerpts} of ${s.parsedFindings} parsed findings have a usable code excerpt. ` +
    "If that share is low, the reviewers rarely cite a repository-relative path:line. Then either make them cite one in every finding, " +
    "or register the next window only for reviewers that do (register --agent-types). If the share is high, few reviews ran. " +
    "This window stays frozen; record the choice."
  );
}

// A time at midnight UTC shows as the date alone, the way register takes it.
const shownTime = (iso) => (iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso);

// One line for the session start, or null when there is nothing to show: no
// window, or a window that was scored. A caller that has the status passes it.
export function statusLine(env = process.env, s = status(env)) {
  if (!s || s.state === "scored") return null;
  if (s.state === "not_started") return `Finding triage: the evaluation window starts on ${shownTime(s.start)}.`;
  if (s.state === "awaiting_sample") {
    return `Finding triage: the evaluation window ended on ${shownTime(s.end)}, with ${s.eligibleGroups} eligible change groups. Draw the blind sample: run "orch-label.mjs sample --name <name>".`;
  }
  if (s.state === "awaiting_score") {
    return `Finding triage: the evaluation window ended on ${shownTime(s.end)}, and the sample is drawn. Label it, then score it: run "orch-label.mjs label ${s.sample}", then "orch-label.mjs score ${s.sample}".`;
  }
  const base = `Finding triage, day ${s.day} of the window: ${s.eligibleGroups} eligible change groups of ${SAMPLE_GROUPS}, ${s.usableExcerpts} usable excerpts, ${s.errors} errors, hand-back missing ${s.handbackMissing} of ${s.handbackChecked}.`;
  return s.tripwire ? `TRIPWIRE: ${base} ${tripwireAction(s)}` : base;
}

export function describe(result) {
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  return [
    `Harm: ${result.harm.k} of ${result.harm.n} supported findings called "contradicts"; 95% upper bound ${pct(result.harm.bound)} (bar ${pct(HARM_BOUND)}, needs ${HARM_MIN_SUPPORTED}): ${result.harm.verdict}`,
    `Use: ${result.use.k} of ${result.use.n} contradicted findings found; lower bound ${pct(result.use.lower)} (bar ${pct(USE_RATE)}, needs ${USE_MIN})${result.use.pilot ? ", pilot evidence" : ""}: ${result.use.verdict}`,
    `Coverage: ${result.coverage.k} of ${result.coverage.n} answered supports or contradicts (bar ${pct(COVERAGE_RATE)}): ${result.coverage.verdict}`,
    `Parsing: ${result.parsing.k} of ${result.parsing.n} reports extracted completely (bar ${pct(PARSE_COMPLETE_RATE)}); unparsed or unavailable in the sample: ${result.parsing.unparsedOrUnavailable}: ${result.parsing.verdict}`,
    `Precision (information only): ${result.precision.k} of ${result.precision.n} "contradicts" answers were right`,
    `Skipped: ${result.skipped}. Distinct reports behind the finding rates: ${result.distinctReports}.`,
    `Overall: ${result.overall}`
  ].join("\n");
}

export function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}
