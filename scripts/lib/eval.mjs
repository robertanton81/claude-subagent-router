// The offline evaluation: the same task runs in several arms (configurations)
// through `claude -p`, and the numbers of each run are saved. gradeRecord()
// checks results; checkPassRule() applies the pass rule to a summary. The
// runner is scripts/orch-eval.mjs.
//
// Arms:
//   off     Claude Code as it is, without the plugin.
//   sonnet  Without the plugin, every subagent forced to Sonnet. This is the
//           baseline to beat.
//   shadow  With the plugin in shadow mode: its workers and skills exist, the
//           hook logs what it would do and changes nothing.
//   jev     With the plugin in enforce mode: the routing in force.
//   low     Without the plugin, the whole session at effort low. The
//   medium  same at effort medium. These two are the single-model baselines:
//           Anthropic measured that one model at lower effort often beats a
//           multi-model setup. They run only when --arms names them.
//
// Every run gets its own data folder (ORCH_DATA_DIR), so the real store stays
// clean and the dispatch records of the run can be read back.

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gradeVerification, loadVerification } from "./executable-grade.mjs";

export const ARMS = {
  off: { plugin: false, env: {}, note: "Claude Code as it is, no plugin" },
  sonnet: {
    plugin: false,
    env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1" },
    note: "no plugin, every subagent on Sonnet: the baseline to beat"
  },
  shadow: { plugin: true, env: { ORCH_MODE: "shadow", ORCH_JEV_ENABLED: "1" }, note: "the plugin in shadow mode: workers and skills, no routing" },
  jev: { plugin: true, env: { ORCH_MODE: "enforce", ORCH_JEV_ENABLED: "1" }, note: "the plugin in enforce mode: Jev routing in force" },
  low: { plugin: false, env: {}, args: ["--effort", "low"], note: "no plugin, the whole session at effort low: a single-model baseline" },
  medium: { plugin: false, env: {}, args: ["--effort", "medium"], note: "no plugin, the whole session at effort medium: a single-model baseline" }
};
// The arms of a run without --arms. The effort baselines stay out, so a plain
// run costs what it cost before they existed.
export const DEFAULT_ARMS = ["off", "sonnet", "shadow", "jev"];
// The arms that the informational comparison sets against the jev arm.
export const EFFORT_ARMS = ["low", "medium"];

const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_FIELDS = ["model", "budgetUsd", "timeoutS", "allowedTools", "export", "history", "expect", "expectRoute", "verify", "trace"];
const DEFAULTS = { model: "sonnet", budgetUsd: 1, timeoutS: 600, allowedTools: ["Read", "Glob", "Grep", "Agent"], export: false, history: false, trace: false };
// The switches that an arm sets. They are removed from the parent environment
// first, so a value from the shell never reaches the wrong arm. The forced
// subagent model must stay off in the plugin arms: with it the hook cannot set a model.
// The effort variables go too: CLAUDE_CODE_EFFORT_LEVEL overrides every effort
// setting, the agent files included, so a value from the shell would give every
// arm the same effort. CLAUDE_EFFORT is set by the desktop app; what reads it is
// not documented, so it is removed as well.
const ARM_SWITCHES = [
  "ORCH_MODE",
  "ORCH_JEV_ENABLED",
  "ORCH_DATA_DIR",
  "ORCH_LIMITS_FILE",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_EFFORT"
];
const STDERR_TAIL = 2000;

// The arm order of one run. The first run keeps the given order, the next one
// starts at the second arm, and so on. Cost depends on how warm the prompt cache
// is, and the cache warms as the runs go, so a fixed order makes the last arm
// look cheaper than the first. Over as many runs as there are arms, each arm
// stands in each position once, and that bias cancels out.
export function rotateArms(arms, run) {
  if (arms.length === 0) {
    return [];
  }
  const start = (run - 1) % arms.length;
  return [...arms.slice(start), ...arms.slice(0, start)];
}

function pick(source, keys) {
  const out = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * The cost cap of one run in dollars, rounded to the whole cents that
 * `--max-budget-usd` is sent with. The total limit must charge this amount
 * for a run with no reported cost, or the runs can pass the limit together.
 */
export function runCapUsd(task) {
  return Number(task.budgetUsd.toFixed(2));
}

function positiveNumber(value, field, task) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`task "${task}": ${field} must be a number above 0`);
  }
  return value;
}

function stringList(value, field, task) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`task "${task}": ${field} must be a list of non-empty strings`);
  }
  return value;
}

// `expect` says what the answer must and must not contain. Every arm is graded
// by it, because a route that changes the answer is the failure to catch.
function checkExpect(expect, task) {
  if (expect === undefined) {
    return;
  }
  if (!expect || typeof expect !== "object" || Array.isArray(expect)) {
    throw new Error(`task "${task}": "expect" must be an object with "contains" or "notContains"`);
  }
  const contains = stringList(expect.contains, '"expect.contains"', task);
  const notContains = stringList(expect.notContains, '"expect.notContains"', task);
  if (contains.length === 0 && notContains.length === 0) {
    throw new Error(`task "${task}": "expect" needs at least one entry in "contains" or "notContains"`);
  }
}

// `expectRoute` says which worker and model the routing should end at. Only the
// arms that run the hook in enforce mode can be graded by it.
function checkExpectRoute(route, task) {
  if (route === undefined) {
    return;
  }
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    throw new Error(`task "${task}": "expectRoute" must be an object with "agent" or "model"`);
  }
  for (const field of ["agent", "model"]) {
    if (route[field] !== undefined && (typeof route[field] !== "string" || route[field] === "")) {
      throw new Error(`task "${task}": "expectRoute.${field}" must be a non-empty string`);
    }
  }
  if (route.agent === undefined && route.model === undefined) {
    throw new Error(`task "${task}": "expectRoute" needs "agent" or "model"`);
  }
  if (route.min !== undefined && (!Number.isInteger(route.min) || route.min < 1)) {
    throw new Error(`task "${task}": "expectRoute.min" must be a whole number of at least 1`);
  }
}

// A task with `history` runs in a clone of its repository, and a clone starts at
// the top folder. A cwd below it fails only at run time, after earlier tasks may
// have run and cost money, so the loader refuses it first. `--show-prefix`
// prints the path from the top folder to cwd. It is empty at the top folder and
// in a bare repository.
function checkHistoryRoot(cwd, task) {
  let prefix;
  try {
    prefix = execFileSync("git", ["-C", cwd, "rev-parse", "--show-prefix"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const said = String(error.stderr ?? "").trim().split("\n")[0];
    throw new Error(`task "${task}": history needs cwd to be a git repository${said ? ` (git says: ${said})` : ""}`);
  }
  if (prefix !== "") {
    throw new Error(`task "${task}": history needs cwd to be the top folder of its git repository (it is inside ${prefix})`);
  }
}

// Reads a task set file: { model?, budgetUsd?, timeoutS?, allowedTools?, export?,
// tasks: [{ name, prompt, cwd, ...the same fields }] }. Task fields win over the
// file's defaults, and the file's defaults over the built-in ones. A relative
// cwd counts from the task set file's folder.
export function loadTaskSet(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read the task set ${file}: ${error.message}`);
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`the task set ${file} needs a non-empty "tasks" array`);
  }
  const base = { ...DEFAULTS, ...pick(raw, TASK_FIELDS) };
  const names = new Set();
  const tasks = raw.tasks.map((task, index) => {
    if (!task || typeof task !== "object") {
      throw new Error(`task ${index + 1} is not an object`);
    }
    const name = task.name;
    if (typeof name !== "string" || !TASK_NAME.test(name)) {
      throw new Error(`task ${index + 1}: "name" must be letters, digits, dots, dashes or underscores, at most 64 characters`);
    }
    if (names.has(name)) {
      throw new Error(`task "${name}" appears twice`);
    }
    names.add(name);
    if (typeof task.prompt !== "string" || task.prompt.trim() === "") {
      throw new Error(`task "${name}": "prompt" must be a non-empty string`);
    }
    if (typeof task.cwd !== "string" || task.cwd === "") {
      throw new Error(`task "${name}": "cwd" must be a folder path`);
    }
    const cwd = path.resolve(path.dirname(file), task.cwd);
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`task "${name}": the folder ${cwd} does not exist`);
    }
    const merged = { ...base, ...pick(task, TASK_FIELDS), name, prompt: task.prompt, cwd };
    positiveNumber(merged.budgetUsd, "budgetUsd", name);
    if (runCapUsd(merged) <= 0) {
      throw new Error(`task "${name}": budgetUsd must be at least 0.01, because the cap of a run is sent in whole cents`);
    }
    positiveNumber(merged.timeoutS, "timeoutS", name);
    if (typeof merged.model !== "string" || merged.model === "") {
      throw new Error(`task "${name}": "model" must be a model name`);
    }
    if (!Array.isArray(merged.allowedTools) || merged.allowedTools.some((tool) => typeof tool !== "string" || tool === "")) {
      throw new Error(`task "${name}": "allowedTools" must be a list of tool names`);
    }
    if (typeof merged.export !== "boolean") {
      throw new Error(`task "${name}": "export" must be true or false`);
    }
    if (typeof merged.history !== "boolean") {
      throw new Error(`task "${name}": "history" must be true or false`);
    }
    if (typeof merged.trace !== "boolean") {
      throw new Error(`task "${name}": "trace" must be true or false`);
    }
    if (merged.history && !merged.export) throw new Error(`task "${name}": history requires export: true`);
    if (merged.history) checkHistoryRoot(cwd, name);
    checkExpect(merged.expect, name);
    checkExpectRoute(merged.expectRoute, name);
    merged.verify = loadVerification(merged.verify, path.dirname(file), cwd);
    if (merged.verify && !merged.export) throw new Error(`task "${name}": executable verification requires export: true`);
    return merged;
  });
  return { tasks };
}

// The command line and the environment of one run.
export function buildInvocation(task, armName, { claudeBin = "claude", pluginDir, dataDir, cwd = task.cwd, baseEnv = process.env }) {
  const arm = ARMS[armName];
  if (!arm) {
    throw new Error(`unknown arm "${armName}"; the arms are ${Object.keys(ARMS).join(", ")}`);
  }
  if (arm.plugin && !pluginDir) {
    throw new Error(`the arm "${armName}" needs a plugin folder`);
  }
  const argv = [
    claudeBin,
    "-p",
    task.prompt,
    "--output-format",
    // With "trace" the run prints one JSON line per message, so the record can
    // say which skills and agents the session called. That format needs --verbose.
    ...(task.trace ? ["stream-json", "--verbose"] : ["json"]),
    "--model",
    task.model,
    "--setting-sources",
    "project",
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    "--max-budget-usd",
    runCapUsd(task).toFixed(2),
    "--allowedTools",
    task.allowedTools.join(",")
  ];
  if (arm.plugin) {
    argv.push("--plugin-dir", pluginDir);
  }
  argv.push(...(arm.args ?? []));
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!ARM_SWITCHES.includes(key)) {
      env[key] = value;
    }
  }
  // A limits file that does not exist: the limit rule and the pace rule stay
  // off, so a run does not depend on the usage of the day.
  Object.assign(env, { ORCH_DATA_DIR: dataDir, ORCH_LIMITS_FILE: path.join(dataDir, "limits-latest.json") }, arm.env);
  return { argv, env, cwd };
}

// Makes the data folder of a run. With a config file, its copy becomes the
// run's config.json, so the run sees the same settings as a real session.
export function prepareDataDir(dataDir, configFile = null) {
  // This folder belongs to one run alone. An earlier run at the same task, arm
  // and number leaves its dispatch log here, and reading that back would count
  // another run's routes as this one's. The folder starts empty every time.
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (configFile) {
    fs.copyFileSync(configFile, path.join(dataDir, "config.json"));
  }
}

// The folders in which Claude Code never lets a session write in dontAsk mode,
// whatever the allow rules say (its permission-modes page, section "Protected
// paths", read 2026-10-02). An editing task whose workspace lies inside one can
// never write a file, so the runner refuses such a folder before any run.
const PROTECTED_SEGMENTS = new Set([".git", ".vscode", ".idea", ".husky", ".cargo", ".devcontainer", ".yarn", ".mvn"]);

// The real location of a folder that may not exist yet: its nearest existing
// parent, resolved through symbolic links, with the rest of the path appended.
export function realLocation(dir) {
  let current = path.resolve(dir);
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...rest);
}

// Why Claude Code would refuse writes in this folder in dontAsk mode, or null.
// `.claude/worktrees` is the one exception, and it does not cover a protected
// folder nested deeper inside it.
export function protectedReason(dir, { pluginDir = null } = {}) {
  const resolved = realLocation(dir);
  if (pluginDir) {
    const plugin = realLocation(pluginDir);
    if (resolved === plugin || resolved.startsWith(`${plugin}${path.sep}`)) return `it lies inside the plugin folder ${plugin}, which --plugin-dir loads`;
  }
  const parts = resolved.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    if (PROTECTED_SEGMENTS.has(parts[index])) return `it lies inside a ${parts[index]} folder`;
    if (parts[index] === ".config" && parts[index + 1] === "git") return "it lies inside .config/git";
    if (parts[index] === ".claude" && parts[index + 1] !== "worktrees") return "it lies inside a .claude folder";
  }
  return null;
}

// A fresh copy of the committed tree of a git repository, for a task that
// writes files. The copy has no git history, unless `history` is set: a review
// task needs the base and change commits, so it gets a clone pinned to the
// revision, without a remote that points back at the fixture.
export function exportWorkspace(repoDir, dest, revision = "HEAD", { history = false } = {}) {
  // This copy belongs to one run alone. An earlier run at the same task, arm and
  // number left its whole working tree here, including anything it wrote, and
  // `tar` would unpack over it rather than replace it. A file the earlier run
  // created and this commit no longer has would survive into the new run.
  fs.rmSync(dest, { recursive: true, force: true });
  if (history) {
    // --no-local copies objects through git's transport, so the copy has no hard
    // links (the grader's snapshot refuses them) and no alternates file.
    const opts = { stdio: ["ignore", "ignore", "pipe"] };
    execFileSync("git", ["clone", "--quiet", "--no-local", "--no-checkout", repoDir, dest], opts);
    execFileSync("git", ["-C", dest, "checkout", "--quiet", "-B", "review", revision], opts);
    execFileSync("git", ["-C", dest, "remote", "remove", "origin"], opts);
    // The clone also made a branch for the fixture's default branch, and copied
    // its tags. Commits after the pinned revision would stay reachable through
    // them, so only the "review" branch may remain. Deleting the refs is not
    // enough. The HEAD reflog still names the later tip and the fixture's path,
    // and the copied objects still hold every later commit, which a worker can
    // read by its id. So the reflogs are emptied and the objects that no ref
    // reaches are removed. The repack writes new pack files, not hard links.
    const refs = execFileSync("git", ["-C", dest, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"], { encoding: "utf8" })
      .split("\n").filter((ref) => ref && ref !== "refs/heads/review");
    for (const ref of refs) execFileSync("git", ["-C", dest, "update-ref", "-d", ref], opts);
    execFileSync("git", ["-C", dest, "reflog", "expire", "--expire=now", "--all"], opts);
    execFileSync("git", ["-C", dest, "gc", "--prune=now", "--quiet"], opts);
    return dest;
  }
  fs.mkdirSync(dest, { recursive: true });
  const tarFile = path.join(path.dirname(dest), `${path.basename(dest)}.tar`);
  execFileSync("git", ["-C", repoDir, "archive", "--format=tar", "-o", tarFile, revision], { stdio: ["ignore", "ignore", "pipe"] });
  execFileSync("tar", ["-xf", tarFile, "-C", dest], { stdio: ["ignore", "ignore", "pipe"] });
  fs.rmSync(tarFile, { force: true });
  return dest;
}

// Runs one invocation with a time limit. The child gets its own process group,
// so the kill reaches the subagents and the commands it started.
export function runOne(invocation, { timeoutMs, maxOutputBytes = 8 * 1024 * 1024 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let done = false;
    let outputBytes = 0;
    let outputLimit = false;
    const finish = (outcome) => {
      if (!done) {
        done = true;
        resolve({ stdout, stderr, timedOut, outputLimit, durationMs: Date.now() - startedAt, ...outcome });
      }
    };
    let child;
    try {
      child = spawn(invocation.argv[0], invocation.argv.slice(1), {
        cwd: invocation.cwd,
        env: invocation.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
    } catch (error) {
      finish({ code: null, signal: null, spawnError: error.message });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is gone already.
      }
      child.stdout.destroy();
      child.stderr.destroy();
      finish({ code: null, signal: "SIGKILL" });
    }, timeoutMs);
    // Decode as one stream, so a character that spans two chunks stays whole.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (chunk, isError) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        outputLimit = true;
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* The group already ended. */ }
        return;
      }
      if (isError) stderr += chunk;
      else stdout += chunk;
    };
    child.stdout.on("data", (chunk) => collect(chunk, false));
    child.stderr.on("data", (chunk) => collect(chunk, true));
    child.on("exit", () => {
      // Stop descendants even when the parent exits successfully. A retained
      // output pipe must not keep an evaluation alive after its worker ends.
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* No descendants remain in the group. */ }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: null, signal: null, spawnError: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({ code, signal });
    });
  });
}

// The one JSON object that `--output-format json` prints. Falls back to the
// last JSON line when something else was printed before it. In the stream
// format every line has a "type", and only the line of type "result" counts:
// a run that was stopped before its result line has no result.
export function parseResult(stdout) {
  const text = stdout.trim();
  if (text === "") {
    return null;
  }
  const isResult = (parsed) => parsed && typeof parsed === "object" && (parsed.type === undefined || parsed.type === "result");
  try {
    const parsed = JSON.parse(text);
    return isResult(parsed) ? parsed : null;
  } catch {
    const lines = text.split("\n").filter((line) => line.startsWith("{"));
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]);
        if (isResult(parsed)) {
          return parsed;
        }
      } catch {
        // Not this line.
      }
    }
    return null;
  }
}

// The tool calls of a run that printed the stream format: how often each tool
// was called, which skills were loaded and which agents were started. `main`
// is false for a call that a subagent made. Returns null when the output holds
// no message line, so "no trace" and "no tool call" stay different answers.
export function readTrace(stdout) {
  const trace = { tools: {}, skills: [], agents: [] };
  let messages = 0;
  for (const line of String(stdout ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    messages += 1;
    const main = event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;
    for (const block of event.message.content) {
      if (!block || block.type !== "tool_use" || typeof block.name !== "string") continue;
      trace.tools[block.name] = (trace.tools[block.name] ?? 0) + 1;
      const input = block.input && typeof block.input === "object" ? block.input : {};
      if (block.name === "Skill") {
        trace.skills.push({ skill: typeof input.skill === "string" ? input.skill : null, main });
      } else if (block.name === "Agent" || block.name === "Task") {
        trace.agents.push({ agent: typeof input.subagent_type === "string" ? input.subagent_type : null, model: typeof input.model === "string" ? input.model : null, main });
      }
    }
  }
  return messages === 0 ? null : trace;
}

// The dispatches that the plugin's hook logged during one run, with the model
// that Claude Code then resolved for each.
export function readDispatches(dataDir) {
  const file = path.join(dataDir, "dispatch-log.jsonl");
  if (!fs.existsSync(file)) {
    return [];
  }
  const records = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const resolved = new Map();
  for (const record of records) {
    if (record.event === "launched" && record.tool_use_id) {
      resolved.set(record.tool_use_id, record.resolved_model ?? null);
    }
  }
  return records
    .filter((record) => record.event === "dispatch")
    .map((record) => ({
      requested: record.requested ?? null,
      final: record.final ?? null,
      action: record.action ?? null,
      reason: record.reason ?? null,
      model_only: record.model_only === true,
      kind: record.jev?.kind ?? null,
      kind_confidence: record.jev?.kindConfidence ?? null,
      difficulty: record.jev?.difficulty ?? null,
      resolved_model: resolved.get(record.tool_use_id) ?? null
    }));
}

// Only an arm whose hook runs in enforce mode can be graded on its route. The
// other arms never reach the routing table, so a route grader there says nothing.
export function armEnforces(arm) {
  return ARMS[arm]?.env?.ORCH_MODE === "enforce";
}

// When the hook agrees with a worker's own model, it sets no model, and
// `final.model` stays null. The model that ran is then only in the `launched`
// record, as a full id such as `claude-haiku-4-5-20251001`.
function modelMatches(dispatch, expected) {
  const model = dispatch.final?.model;
  if (model !== null && model !== undefined) {
    return model === expected;
  }
  return typeof dispatch.resolved_model === "string" && dispatch.resolved_model.includes(expected);
}

// Grades one saved record against its task. It reads the record only, so a
// changed grader can be run again over saved runs without spending anything.
// In a task without `verify`, a run that errored or timed out is not scored: it
// has no answer to grade. A task with `verify` checks the workspace, which
// exists either way, so it scores every run, and an errored or timed-out run
// fails there.
export function gradeRecord(record, task) {
  const graders = [];
  const answer = typeof record.result === "string" ? record.result : "";
  // The saved answer is cut to `--result-chars`. Grading a cut answer reads both
  // ways wrong: a string that was expected may sit past the cut and look
  // missing, and a string that must not appear may sit past the cut and look
  // absent. Such a run is not scored, rather than scored wrongly.
  const cutOff = typeof record.result_chars === "number" && record.result_chars > answer.length;
  const scored = task?.verify ? true : !record.is_error && !record.timed_out && !cutOff;
  const contains = task?.expect?.contains ?? [];
  const notContains = task?.expect?.notContains ?? [];
  if (contains.length > 0) {
    const found = contains.filter((needle) => answer.includes(needle)).length;
    graders.push({ name: "answer.contains", pass: found === contains.length, detail: `${found} of ${contains.length}` });
  }
  if (notContains.length > 0) {
    const found = notContains.filter((needle) => answer.includes(needle)).length;
    graders.push({ name: "answer.notContains", pass: found === 0, detail: `${found} of ${notContains.length} present` });
  }
  if (task?.expectRoute && armEnforces(record.arm)) {
    // Every dispatch of the run must take the expected route, and there must be
    // at least `min` of them. A session that dispatches five times and routes
    // three of them wrongly is a failure, not a pass with a note.
    const dispatches = record.dispatches ?? [];
    const min = task.expectRoute.min ?? 1;
    const matching = dispatches.filter(
      (dispatch) =>
        (task.expectRoute.agent === undefined || dispatch.final?.agent === task.expectRoute.agent) &&
        (task.expectRoute.model === undefined || modelMatches(dispatch, task.expectRoute.model))
    ).length;
    graders.push({
      name: "route",
      pass: dispatches.length >= min && matching === dispatches.length,
      detail: `${matching} of ${dispatches.length} dispatches as expected, at least ${min} wanted`
    });
  }
  if (task?.verify) {
    const executable = gradeVerification(record, task);
    graders.push({ name: "executable", ...executable });
    graders.push({ name: "worker.completed", pass: !record.is_error && !record.timed_out, detail: record.is_error || record.timed_out ? "worker did not complete" : "completed" });
    if (task.expect && cutOff) graders.push({ name: "answer.complete", pass: false, detail: "answer was truncated" });
  }
  // A record with no grader is not a pass and not a failure. It is ungraded,
  // and the pass rate leaves it out.
  const pass = graders.length === 0 ? null : graders.every((grader) => grader.pass);
  return { scored, cutOff, graders, pass: scored ? pass : null };
}

function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Cache tokens over all models of a run. A token written into the prompt cache
// costs more than one read from it, so these two numbers say how much of a run's
// cost came from a cold cache rather than from the route. Read them before any
// cost comparison.
function cacheTokens(modelUsage) {
  let cache_read = 0;
  let cache_created = 0;
  for (const usage of Object.values(modelUsage ?? {})) {
    cache_read += number(usage?.cacheReadInputTokens) ?? 0;
    cache_created += number(usage?.cacheCreationInputTokens) ?? 0;
  }
  return { cache_read, cache_created };
}

// The tokens of a run, or null when it reported none: input, output and cache
// writes, over all models and with no price weight. Cache reads stay out, because
// they count the same context again on each turn and would hide the rest.
function runTokens(modelUsage) {
  let total = null;
  for (const usage of Object.values(modelUsage ?? {})) {
    for (const field of ["inputTokens", "outputTokens", "cacheCreationInputTokens"]) {
      const value = number(usage?.[field]);
      if (value !== null) {
        total = (total ?? 0) + value;
      }
    }
  }
  return total;
}

// One line of runs.jsonl. The answer is kept, cut to `resultChars`, because a
// later grader needs it. The summary never prints it.
export function makeRecord({ task, arm, run, invocation, outcome, dataDir, resultChars = 4000 }) {
  const result = parseResult(outcome.stdout);
  const failed = Boolean(outcome.spawnError) || outcome.outputLimit || result === null || result.is_error === true || (outcome.code !== 0 && !outcome.timedOut);
  const isError = !outcome.timedOut && failed;
  const answer = typeof result?.result === "string" ? result.result : null;
  return {
    ts: new Date().toISOString(),
    task: task.name,
    arm,
    run,
    cwd: invocation.cwd,
    exit_code: outcome.code ?? null,
    signal: outcome.signal ?? null,
    timed_out: outcome.timedOut,
    is_error: isError,
    spawn_error: outcome.spawnError ?? null,
    cost_usd: number(result?.total_cost_usd),
    num_turns: number(result?.num_turns),
    duration_ms: number(result?.duration_ms),
    duration_api_ms: number(result?.duration_api_ms),
    wall_ms: outcome.durationMs,
    model_usage: result?.modelUsage && typeof result.modelUsage === "object" ? result.modelUsage : {},
    ...cacheTokens(result?.modelUsage),
    permission_denials: Array.isArray(result?.permission_denials) ? result.permission_denials.length : 0,
    dispatches: readDispatches(dataDir),
    ...(task.trace ? { trace: readTrace(outcome.stdout) } : {}),
    result_chars: answer === null ? 0 : answer.length,
    result: answer === null ? null : answer.slice(0, resultChars),
    stderr_tail: isError || outcome.timedOut ? outcome.stderr.slice(-STDERR_TAIL) : ""
  };
}

function countKnown(values) {
  return values.filter((value) => typeof value === "number").length;
}

function mean(values) {
  const known = values.filter((value) => typeof value === "number");
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
}

// How uncertain an arm's mean is, as the standard error of that mean. It is the
// yardstick for a difference between two arms. The distance from the cheapest to
// the dearest run would be the simpler measure, but it grows as runs are added,
// so more evidence would make a verdict harder instead of easier. This shrinks
// with the square root of the number of runs, as it should.
function standardError(values) {
  const known = values.filter((value) => typeof value === "number");
  if (known.length < 2) {
    return null;
  }
  const average = known.reduce((sum, value) => sum + value, 0) / known.length;
  const variance = known.reduce((sum, value) => sum + (value - average) ** 2, 0) / (known.length - 1);
  return Math.sqrt(variance) / Math.sqrt(known.length);
}

function routeLabel(dispatch) {
  const from = dispatch.requested?.agent ?? "?";
  const to = dispatch.final?.agent ?? from;
  const model = dispatch.final?.model ?? "default";
  return `${from} -> ${to}/${model} (${dispatch.action ?? "?"}: ${dispatch.reason ?? "?"})`;
}

// Counts per task and arm. No prompt, no answer and no path reaches the summary.
// With the task list it also grades every record and counts the passes.
export function summarize(records, taskList = []) {
  const byName = new Map(taskList.map((task) => [task.name, task]));
  // A task name is free text from the task file, so a plain object would find
  // an inherited key such as `constructor` instead of making a new entry.
  const tasks = new Map();
  let cost = 0;
  let errors = 0;
  let timeouts = 0;
  for (const record of records) {
    if (!tasks.has(record.task)) {
      tasks.set(record.task, new Map());
    }
    const task = tasks.get(record.task);
    if (!task.has(record.arm)) {
      task.set(record.arm, { runs: 0, errors: 0, timeouts: 0, costs: [], walls: [], turns: [], created: [], models: new Set(), routes: {}, graded: 0, passed: 0, failedGraders: {}, accuracyGraded: 0, accuracyPassed: 0, routeFailed: 0, tokens: [] });
    }
    const arm = task.get(record.arm);
    const grade = gradeRecord(record, byName.get(record.task));
    if (grade.pass !== null) {
      arm.graded += 1;
      arm.passed += grade.pass ? 1 : 0;
      for (const grader of grade.graders) {
        if (!grader.pass) {
          arm.failedGraders[grader.name] = (arm.failedGraders[grader.name] ?? 0) + 1;
        }
      }
    }
    // Accuracy comes from every grader except the route grader, which only one arm
    // gets. A wrong route counts on its own, also when the answer was not graded.
    const answerGraders = grade.graders.filter((grader) => grader.name !== "route");
    if (grade.pass !== null && answerGraders.length > 0) {
      arm.accuracyGraded += 1;
      arm.accuracyPassed += answerGraders.every((grader) => grader.pass) ? 1 : 0;
    }
    arm.routeFailed += grade.graders.some((grader) => grader.name === "route" && !grader.pass) ? 1 : 0;
    arm.tokens.push(runTokens(record.model_usage));
    arm.runs += 1;
    arm.errors += record.is_error ? 1 : 0;
    arm.timeouts += record.timed_out ? 1 : 0;
    arm.costs.push(record.cost_usd);
    arm.walls.push(record.wall_ms);
    arm.turns.push(record.num_turns);
    arm.created.push(record.cache_created ?? null);
    for (const model of Object.keys(record.model_usage ?? {})) {
      arm.models.add(model);
    }
    for (const dispatch of record.dispatches ?? []) {
      const label = routeLabel(dispatch);
      arm.routes[label] = (arm.routes[label] ?? 0) + 1;
    }
    cost += record.cost_usd ?? 0;
    errors += record.is_error ? 1 : 0;
    timeouts += record.timed_out ? 1 : 0;
  }
  const out = { runs: records.length, cost_usd: cost, errors, timeouts, tasks: {} };
  for (const [name, arms] of tasks) {
    out.tasks[name] = {};
    for (const [arm, data] of arms) {
      out.tasks[name][arm] = {
        runs: data.runs,
        errors: data.errors,
        timeouts: data.timeouts,
        cost_total_usd: data.costs.reduce((sum, value) => sum + (value ?? 0), 0),
        cost_mean_usd: mean(data.costs),
        cost_stderr_usd: standardError(data.costs),
        wall_mean_ms: mean(data.walls),
        wall_stderr_ms: standardError(data.walls),
        wall_known: countKnown(data.walls),
        tokens_mean: mean(data.tokens),
        tokens_stderr: standardError(data.tokens),
        tokens_known: countKnown(data.tokens),
        accuracy_graded: data.accuracyGraded,
        accuracy_passed: data.accuracyPassed,
        accuracy: data.accuracyGraded === 0 ? null : data.accuracyPassed / data.accuracyGraded,
        route_failed: data.routeFailed,
        turns_mean: mean(data.turns),
        cache_created_mean: mean(data.created),
        graded: data.graded,
        passed: data.passed,
        pass_rate: data.graded === 0 ? null : data.passed / data.graded,
        failed_graders: data.failedGraders,
        models: [...data.models].sort(),
        routes: data.routes
      };
    }
  }
  return out;
}

// The pass rule: accuracy first, then tokens, then time. Each later step only
// counts when the earlier one did not decide. Too few runs make a difference
// meaningless, and arms that wrote very different amounts into the prompt cache
// cannot be compared on tokens.
export const MIN_RUNS_PER_ARM = 3;
export const MAX_CACHE_RATIO = 2;
// Tokens or time count as the same when the whole gap, with its uncertainty, stays
// inside this share of the baseline. Fixed in advance, so a result cannot move it.
export const SAME_SHARE = 0.1;

// How many times more one arm wrote into the prompt cache than the other, or
// null when that is unknown. One arm at zero against a positive one is the
// largest gap there is, so it counts as endless. Both at zero is no gap.
function cacheRatio(a, b) {
  if (a === null || b === null) {
    return null;
  }
  if (Math.min(a, b) === 0) {
    return Math.max(a, b) === 0 ? 1 : Infinity;
  }
  return Math.max(a, b) / Math.min(a, b);
}

function cacheReason(ratio) {
  return ratio === Infinity ? "one arm wrote nothing" : `a factor of ${ratio.toFixed(1)}`;
}

// The gap between two arms' mean costs, and twice the standard error of that
// gap. A gap narrower than the margin cannot be told apart from noise.
function costGap(a, b) {
  return {
    gap: Math.abs(a.cost_mean_usd - b.cost_mean_usd),
    margin: 2 * Math.sqrt((a.cost_stderr_usd ?? 0) ** 2 + (b.cost_stderr_usd ?? 0) ** 2)
  };
}

// The jev arm against each effort baseline that ran. This is information, not
// the pass rule, and it judges cost where the rule judges tokens. It answers one
// question: does a plain session at lower effort reach the same pass rate for
// less than the routing does? A guard that fires means "not compared".
export function compareEffortBaselines(summary, { minRuns = MIN_RUNS_PER_ARM, maxCacheRatio = MAX_CACHE_RATIO } = {}) {
  const out = {};
  for (const [taskName, arms] of Object.entries(summary.tasks)) {
    const jev = arms.jev;
    for (const name of EFFORT_ARMS) {
      const baseline = arms[name];
      if (!jev || !baseline) {
        continue;
      }
      const rows = (out[taskName] ??= {});
      const blockers = [];
      if (jev.graded < minRuns || baseline.graded < minRuns) {
        blockers.push(`fewer than ${minRuns} graded runs per arm (jev ${jev.graded}, ${name} ${baseline.graded})`);
      }
      if (jev.pass_rate === null || baseline.pass_rate === null || jev.cost_mean_usd === null || baseline.cost_mean_usd === null) {
        blockers.push("a pass rate or a cost is missing");
      }
      const ratio = cacheRatio(jev.cache_created_mean, baseline.cache_created_mean);
      if (ratio !== null && ratio > maxCacheRatio) {
        blockers.push(`the arms wrote very different amounts into the prompt cache (${cacheReason(ratio)})`);
      }
      if (blockers.length > 0) {
        rows[name] = { outcome: "not compared", reasons: blockers };
        continue;
      }
      const { gap, margin } = costGap(jev, baseline);
      const passes = `pass ${(jev.pass_rate * 100).toFixed(0)}% for jev against ${(baseline.pass_rate * 100).toFixed(0)}% for ${name}`;
      const costs = `${money(jev.cost_mean_usd)} against ${money(baseline.cost_mean_usd)}, a gap of ${money(gap)} against an uncertainty of ${money(margin)}`;
      let outcome;
      if (baseline.pass_rate < jev.pass_rate) {
        outcome = `${name} answers worse`;
      } else if (gap < margin) {
        outcome = "cost cannot be told apart";
      } else if (baseline.cost_mean_usd < jev.cost_mean_usd) {
        outcome = `${name} is cheaper at the same pass rate or better`;
      } else {
        outcome = "jev is cheaper";
      }
      rows[name] = { outcome, reasons: [passes, costs] };
    }
  }
  return out;
}

// The 95 percent Wilson range of a pass rate. It stays honest at few runs: 3 of 3
// still reaches down to about 44 percent.
function wilsonRange(passed, total) {
  const z = 1.96;
  const rate = passed / total;
  const divisor = 1 + (z * z) / total;
  const centre = rate + (z * z) / (2 * total);
  const spread = z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, (centre - spread) / divisor), high: Math.min(1, (centre + spread) / divisor) };
}

// One number of the jev arm against the same number of the baseline. "same" needs
// the whole uncertainty inside the margin: a gap that is only small is "unclear",
// because few noisy runs cannot show that two arms are equal.
function compareMetric(arm, baseline, minRuns) {
  if (arm.mean === null || baseline.mean === null || arm.known < minRuns || baseline.known < minRuns) {
    return "unknown";
  }
  const gap = arm.mean - baseline.mean;
  const noise = 2 * Math.sqrt((arm.stderr ?? 0) ** 2 + (baseline.stderr ?? 0) ** 2);
  const margin = SAME_SHARE * baseline.mean;
  if (Math.abs(gap) > Math.max(noise, margin)) {
    return gap < 0 ? "lower" : "higher";
  }
  return Math.abs(gap) + noise <= margin ? "same" : "unclear";
}

export function checkPassRule(summary, { minRuns = MIN_RUNS_PER_ARM, maxCacheRatio = MAX_CACHE_RATIO } = {}) {
  const out = {};
  for (const [taskName, arms] of Object.entries(summary.tasks)) {
    const jev = arms.jev;
    const baseline = arms.sonnet;
    if (!jev || !baseline) {
      out[taskName] = { verdict: "NOT DECIDED", reasons: ["the run needs both the jev arm and the sonnet arm"] };
      continue;
    }
    // A run only counts once a grader could read it. In a task without `verify`,
    // a run that errored, timed out or came back cut off is not graded, so
    // counting it as evidence would let an arm that mostly failed look like an
    // arm that mostly worked. A task with `verify` grades every run, and an
    // errored or timed-out run fails there. The summary does not say which kind
    // of task it holds, so the reason names both.
    const blockers = [];
    // A summary saved before the accuracy fields existed would compare as
    // `undefined`, which passes both guards below and prints NaN ranges.
    const counted = (arm) => Number.isInteger(arm.accuracy_graded) && Number.isInteger(arm.accuracy_passed) && arm.accuracy_passed >= 0 && arm.accuracy_passed <= arm.accuracy_graded;
    if (!counted(jev) || !counted(baseline)) {
      out[taskName] = { verdict: "NOT DECIDED", reasons: ["the summary has no usable accuracy counts; build it again from the saved runs with --regrade"] };
      continue;
    }
    if (jev.accuracy_graded < minRuns || baseline.accuracy_graded < minRuns) {
      blockers.push(
        `fewer than ${minRuns} graded runs per arm (jev ${jev.accuracy_graded} of ${jev.runs}, sonnet ${baseline.accuracy_graded} of ${baseline.runs}); a task without \`verify\` does not grade a run that errored, timed out or was cut off; a task with \`verify\` grades every run, and an errored or timed-out run fails`
      );
    }
    if (jev.accuracy === null || baseline.accuracy === null) {
      blockers.push("no answer grader ran, so there is no accuracy");
    }
    if (blockers.length > 0) {
      out[taskName] = { verdict: "NOT DECIDED", reasons: blockers };
      continue;
    }

    // Step 1, accuracy. Few runs cannot show that two arms are equal, so this step
    // is one-sided: a loss that was seen fails, and no loss seen goes on with the
    // ranges printed. A wrong route or more broken runs fail here too.
    const reasons = [];
    if (jev.accuracy < baseline.accuracy) {
      reasons.push(`the jev arm answers worse than the baseline (${(jev.accuracy * 100).toFixed(0)}% against ${(baseline.accuracy * 100).toFixed(0)}%)`);
    }
    if (jev.route_failed > 0) {
      reasons.push(`the route was not the expected one in ${jev.route_failed} of ${jev.runs} runs`);
    }
    // An arm that falls over more often than the baseline is worse, whatever else
    // it does. Compared as shares, not as counts. The arms need not have the same
    // number of runs: one that stopped early, or a rerun of a single arm, gives
    // them different totals, and 1 failure in 3 is worse than 2 in 20 although the
    // count is smaller.
    const broke = (arm) => arm.errors + arm.timeouts;
    const brokeShare = (arm) => (arm.runs === 0 ? 0 : broke(arm) / arm.runs);
    if (brokeShare(jev) > brokeShare(baseline)) {
      reasons.push(
        `the jev arm failed in a larger share of its runs than the baseline (${broke(jev)} of ${jev.runs}, ${(brokeShare(jev) * 100).toFixed(0)}%, against ${broke(baseline)} of ${baseline.runs}, ${(brokeShare(baseline) * 100).toFixed(0)}%)`
      );
    }
    if (reasons.length > 0) {
      out[taskName] = { verdict: "FAIL", reasons };
      continue;
    }
    const jevRange = wilsonRange(jev.accuracy_passed, jev.accuracy_graded);
    const baseRange = wilsonRange(baseline.accuracy_passed, baseline.accuracy_graded);
    const percent = (value) => `${(value * 100).toFixed(0)}%`;
    const accuracyLine = `accuracy: jev ${jev.accuracy_passed} of ${jev.accuracy_graded} (range ${percent(jevRange.low)} to ${percent(jevRange.high)}), sonnet ${baseline.accuracy_passed} of ${baseline.accuracy_graded} (range ${percent(baseRange.low)} to ${percent(baseRange.high)})`;
    if (jev.accuracy === 0 && baseline.accuracy === 0) {
      out[taskName] = { verdict: "NOT DECIDED", reasons: ["neither arm answered right, so nothing here can favour one of them", accuracyLine] };
      continue;
    }
    // Only ranges that do not overlap count as a win, and a win passes whatever the
    // tokens do. This is how a correct move to a larger model can pass.
    if (jevRange.low > baseRange.high) {
      out[taskName] = { verdict: "PASS", reasons: ["the jev arm is clearly more accurate", accuracyLine] };
      continue;
    }
    // A higher rate that is no clear win cannot fail on tokens or time, and cannot
    // pass on them either when they went the wrong way.
    const higher = jev.accuracy > baseline.accuracy;
    const seen = higher ? `higher accuracy, not a clear win; ${accuracyLine}` : `no accuracy loss seen; ${accuracyLine}`;
    const worse = (what, line) =>
      higher
        ? { verdict: "NOT DECIDED", reasons: [`the jev arm is more accurate, not clearly, and uses more ${what} (${line})`, seen] }
        : { verdict: "FAIL", reasons: [`the jev arm uses more ${what} than the baseline (${line})`, seen] };

    // Step 2, tokens.
    const ratio = cacheRatio(jev.cache_created_mean, baseline.cache_created_mean);
    if (ratio !== null && ratio > maxCacheRatio) {
      out[taskName] = { verdict: "NOT DECIDED", reasons: [`the arms wrote very different amounts into the prompt cache (${cacheReason(ratio)}), so the tokens cannot be compared`, seen] };
      continue;
    }
    const metric = (arm, kind) =>
      kind === "tokens"
        ? { mean: arm.tokens_mean ?? null, stderr: arm.tokens_stderr ?? null, known: arm.tokens_known ?? 0 }
        : { mean: arm.wall_mean_ms ?? null, stderr: arm.wall_stderr_ms ?? null, known: arm.wall_known ?? 0 };
    const tokenLine = `jev ${count(jev.tokens_mean)}, sonnet ${count(baseline.tokens_mean)} tokens`;
    const tokens = compareMetric(metric(jev, "tokens"), metric(baseline, "tokens"), minRuns);
    if (tokens === "unknown") {
      out[taskName] = { verdict: "NOT DECIDED", reasons: [`too few runs reported tokens (jev ${jev.tokens_known ?? 0}, sonnet ${baseline.tokens_known ?? 0})`, seen] };
    } else if (tokens === "unclear") {
      out[taskName] = { verdict: "NOT DECIDED", reasons: [`the tokens cannot be told apart from noise (${tokenLine})`, seen] };
    } else if (tokens === "lower") {
      out[taskName] = { verdict: "PASS", reasons: [`the jev arm uses fewer tokens (${tokenLine})`, seen] };
    } else if (tokens === "higher") {
      out[taskName] = worse("tokens", tokenLine);
    } else {
      // Step 3, time, only when the tokens are the same.
      const timeLine = `jev ${seconds(jev.wall_mean_ms ?? null)}, sonnet ${seconds(baseline.wall_mean_ms ?? null)}`;
      const time = compareMetric(metric(jev, "time"), metric(baseline, "time"), minRuns);
      if (time === "lower") {
        out[taskName] = { verdict: "PASS", reasons: [`the same tokens, and the jev arm is faster (${timeLine})`, seen] };
      } else if (time === "higher") {
        out[taskName] = worse("time", timeLine);
      } else {
        const why = {
          same: "the arms show no difference in tokens or time",
          unclear: "the tokens are the same, and the time cannot be told apart from noise",
          unknown: `the tokens are the same, and too few runs reported a time (jev ${jev.wall_known ?? 0}, sonnet ${baseline.wall_known ?? 0})`
        }[time];
        out[taskName] = { verdict: "NOT DECIDED", reasons: [`${why} (${tokenLine}; ${timeLine})`, seen] };
      }
    }
  }
  return out;
}

function count(value) {
  return value === null || value === undefined ? "-" : Math.round(value).toLocaleString("en-US");
}

function money(value) {
  return value === null ? "-" : `$${value.toFixed(3)}`;
}

function seconds(ms) {
  return ms === null ? "-" : `${(ms / 1000).toFixed(1)} s`;
}

export function renderSummary(summary) {
  const lines = [
    `Offline evaluation: ${summary.runs} runs, ${money(summary.cost_usd)} in total, ${summary.errors} errors, ${summary.timeouts} timeouts`,
    "Read \"cache new\" before the cost: a run that wrote many tokens into the prompt cache costs more for that reason alone."
  ];
  for (const [task, arms] of Object.entries(summary.tasks)) {
    lines.push("", `Task ${task}`);
    lines.push("  arm      runs  errors  timeouts  pass      cost mean  wall mean  turns  cache new  models");
    for (const [arm, data] of Object.entries(arms)) {
      const turns = data.turns_mean === null ? "-" : data.turns_mean.toFixed(1);
      const created = data.cache_created_mean === null ? "-" : Math.round(data.cache_created_mean).toLocaleString("en-US");
      const pass = data.pass_rate === null ? "-" : `${data.passed}/${data.graded}`;
      lines.push(
        `  ${arm.padEnd(8)} ${String(data.runs).padEnd(5)} ${String(data.errors).padEnd(7)} ${String(data.timeouts).padEnd(9)} ${pass.padEnd(9)} ${money(data.cost_mean_usd).padEnd(10)} ${seconds(data.wall_mean_ms).padEnd(10)} ${turns.padEnd(6)} ${created.padEnd(10)} ${data.models.join(", ") || "-"}`
      );
    }
    lines.push(`  tokens mean (input, output, cache writes): ${Object.entries(arms).map(([arm, data]) => `${arm} ${count(data.tokens_mean)}`).join(", ")}`);
    for (const [arm, data] of Object.entries(arms)) {
      const failed = Object.entries(data.failed_graders);
      if (failed.length > 0) {
        lines.push(`  graders that failed (${arm}): ${failed.map(([name, count]) => `${name} x${count}`).join(", ")}`);
      }
    }
    for (const [arm, data] of Object.entries(arms)) {
      const routes = Object.entries(data.routes);
      if (routes.length > 0) {
        lines.push(`  routes (${arm}):`);
        for (const [label, count] of routes) {
          lines.push(`    ${label} x${count}`);
        }
      }
    }
  }
  const effort = Object.entries(compareEffortBaselines(summary));
  if (effort.length > 0) {
    lines.push("", "The effort baselines against jev (information only, not the pass rule):");
    for (const [task, rows] of effort) {
      for (const [arm, row] of Object.entries(rows)) {
        lines.push(`  ${task}, ${arm}: ${row.outcome}`);
        for (const reason of row.reasons) {
          lines.push(`    ${reason}`);
        }
      }
    }
  }
  const verdicts = Object.entries(checkPassRule(summary));
  if (verdicts.length > 0) {
    lines.push("", "The pass rule:");
    for (const [task, verdict] of verdicts) {
      lines.push(`  ${task}: ${verdict.verdict}`);
      for (const reason of verdict.reasons) {
        lines.push(`    ${reason}`);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

// The plan that the command prints before it spends anything.
export function renderPlan(taskSet, arms, runs, { outDir, maxTotalUsd }) {
  const total = taskSet.tasks.length * arms.length * runs;
  const cap = taskSet.tasks.reduce((sum, task) => sum + runCapUsd(task) * arms.length * runs, 0);
  const lines = [
    `Plan: ${taskSet.tasks.length} tasks x ${arms.length} arms x ${runs} runs = ${total} runs of claude -p, each capped by its own budget`,
    `Most that the run caps allow: ${money(cap)}${maxTotalUsd === null ? "" : `; the runner stops after ${money(maxTotalUsd)}`}`,
    `Every run counts against the Claude plan. Results go to ${outDir}`,
    "Arms:"
  ];
  for (const arm of arms) {
    lines.push(`  ${arm.padEnd(8)} ${ARMS[arm].note}`);
  }
  lines.push("Tasks:");
  for (const task of taskSet.tasks) {
    lines.push(`  ${task.name.padEnd(24)} model ${task.model}, budget ${money(task.budgetUsd)}, timeout ${task.timeoutS} s, ${task.export ? "in a fresh export of" : "in"} ${task.cwd}`);
  }
  return `${lines.join("\n")}\n`;
}
