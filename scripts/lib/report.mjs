// The numbers of the measurement store: what the hook changed, what Jev
// answered, the labels for a wrong route that the log gives for free, the
// durations, the review findings by author family, and Claude usage over time.
// The command scripts/orch-report.mjs prints them; the tests import them.
//
// Everything here returns counts. No brief, no description and no worker
// result is part of a report, so the output can be shown or shared.

import fs from "node:fs";
import path from "node:path";

import { DEFAULTS, DEFAULT_MODEL, REVIEWER_SET, WRITER_FAMILY, currentAgentName, dataDir } from "./config.mjs";
import { countFindings, reportsNoWrite, verificationText } from "./findings.mjs";
import { logFile, rotatedLogFile } from "./log.mjs";
import { FIVE_HOURS_MS, SEVEN_DAYS_MS, windowVerdict } from "./provider-state.mjs";

const MODEL_RANK = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };
const CHANGED_ACTIONS = new Set(["rewrite", "redirect", "fallback"]);
const FAILED_VERIFICATION = /\b(fail|failed|failing|error|errors|exit code [1-9][0-9]*|exit [1-9][0-9]*)\b/i;
const NOT_RUN = /\bnot run\b/i;

// ---- Reading ----

function readJsonLines(file) {
  if (!fs.existsSync(file)) {
    return { exists: false, records: [], broken: 0 };
  }
  const records = [];
  let broken = 0;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record && typeof record === "object" && !Array.isArray(record)) {
        records.push(record);
      } else {
        broken += 1;
      }
    } catch {
      broken += 1;
    }
  }
  return { exists: true, records, broken };
}

export function loadStore(env = process.env) {
  const dir = dataDir(env);
  const files = [
    { name: "dispatch-log.1.jsonl", file: rotatedLogFile(env), kind: "log" },
    { name: "dispatch-log.jsonl", file: logFile(env), kind: "log" },
    { name: "limits.jsonl", file: path.join(dir, "limits.jsonl"), kind: "limits" }
  ];
  const store = { dataDir: dir, files: [], log: [], limits: [] };
  for (const entry of files) {
    const read = readJsonLines(entry.file);
    store.files.push({ name: entry.name, exists: read.exists, lines: read.records.length, broken: read.broken });
    if (entry.kind === "log") {
      store.log.push(...read.records);
    } else {
      store.limits.push(...read.records);
    }
  }
  return store;
}

// ---- Small helpers ----

// The reason word of a CODEX_FAILED answer. scripts/orch-codex.mjs writes the
// job id first when a job exists ("CODEX_FAILED <id> exit=1 scope=uncommitted",
// "CODEX_FAILED <id> runner_died"), so the reason is the word after the id.
// Without a job it writes "CODEX_FAILED usage error: ..." or "CODEX_FAILED error: ...",
// and the Codex workers write "CODEX_FAILED no codex-request line ..." themselves.
const JOB_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/;

export function codexFailureCode(result) {
  const words = result.split("\n")[0].trim().split(/\s+/).slice(1);
  if (JOB_ID.test(words[0] ?? "")) {
    return words[1]?.replace(/:$/, "") || "unknown";
  }
  const rest = words.join(" ");
  if (rest.startsWith("usage error:")) {
    return "usage_error";
  }
  if (rest.startsWith("error:")) {
    return "error";
  }
  if (rest.startsWith("no codex-request line")) {
    return "no_request";
  }
  return "unknown";
}

function count(map, key) {
  const name = key ?? "unknown";
  map[name] = (map[name] ?? 0) + 1;
}

function share(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

function stats(values) {
  if (values.length === 0) {
    return { count: 0, medianMs: null, meanMs: null, maxMs: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return { count: sorted.length, medianMs: Math.round(median), meanMs: Math.round(mean), maxMs: sorted[sorted.length - 1] };
}

function timeOf(record) {
  const ms = Date.parse(record.ts);
  return Number.isFinite(ms) ? ms : null;
}

function modelRank(final) {
  if (!final) {
    return 0;
  }
  const model = final.model ?? DEFAULT_MODEL[final.agent] ?? null;
  return MODEL_RANK[model] ?? 0;
}

function noticeKind(text) {
  if (typeof text !== "string") {
    return null;
  }
  if (/run on Sonnet/.test(text)) {
    return "claude_capped";
  }
  if (/^Claude usage/.test(text)) {
    return "claude_tight";
  }
  return "codex";
}

// ---- The report ----

// Records from before the rename to subagent-router name the workers
// "orchestrator:<worker>". Every field that holds a worker name is mapped to
// the current name, so old records keep their author, reviewer and model.
function withCurrentAgentNames(record) {
  const copy = { ...record };
  if ("agent_type" in copy) {
    copy.agent_type = currentAgentName(copy.agent_type);
  }
  for (const key of ["requested", "final", "route", "would_route"]) {
    if (copy[key] && typeof copy[key] === "object" && "agent" in copy[key]) {
      copy[key] = { ...copy[key], agent: currentAgentName(copy[key].agent) };
    }
  }
  return copy;
}

export function buildReport(store, options = {}) {
  const sinceMs = options.since ?? null;
  const project = options.project ?? null;

  const keepRecord = (record) => {
    if (sinceMs !== null) {
      const ms = typeof record.ts === "number" ? record.ts * 1000 : timeOf(record);
      if (ms === null || ms < sinceMs) {
        return false;
      }
    }
    if (project !== null && !(typeof record.cwd === "string" && record.cwd.includes(project))) {
      return false;
    }
    return true;
  };

  const log = store.log.filter((record) => record.event !== undefined && keepRecord(record)).map(withCurrentAgentNames);
  const limits = store.limits.filter((record) => sinceMs === null || (typeof record.ts === "number" && record.ts * 1000 >= sinceMs));

  const dispatches = log.filter((record) => record.event === "dispatch");
  const sessionsSeen = new Set();
  const projects = {};
  let recordsWithoutCwd = 0;
  let firstTs = null;
  let lastTs = null;
  for (const record of log) {
    if (record.session_id) {
      sessionsSeen.add(record.session_id);
    }
    if (typeof record.cwd !== "string") {
      recordsWithoutCwd += 1;
    }
    const ms = timeOf(record);
    if (ms !== null) {
      firstTs = firstTs === null ? ms : Math.min(firstTs, ms);
      lastTs = lastTs === null ? ms : Math.max(lastTs, ms);
    }
  }
  for (const record of dispatches) {
    count(projects, typeof record.cwd === "string" ? record.cwd : "(no cwd)");
  }

  // The configuration in force, from the newest session record. The gates of
  // Jev and the pace settings come from there; the defaults cover older logs.
  const sessionRecords = log.filter((record) => record.event === "session" && record.config && typeof record.config === "object");
  const config = { ...DEFAULTS, ...(sessionRecords.length > 0 ? sessionRecords[sessionRecords.length - 1].config : {}) };

  // -- Dispatches --
  const byMode = {};
  const byAction = {};
  const changedByReason = {};
  const wouldChangeByReason = {};
  const unchangedByReason = {};
  const noticesByKind = {};
  const claudeTightAtDispatch = { gate: 0, pace: 0, no: 0, unknown: 0 };
  let changed = 0;
  let wouldChange = 0;
  let unchanged = 0;
  let denied = 0;
  let modelOnly = 0;
  let notices = 0;
  let ruleWouldFire = 0;
  const ruleWouldFireByReason = {};
  for (const record of dispatches) {
    count(byMode, record.mode);
    count(byAction, record.action);
    if (CHANGED_ACTIONS.has(record.action)) {
      changed += 1;
      count(changedByReason, record.reason);
    } else if (record.action === "shadow") {
      wouldChange += 1;
      count(wouldChangeByReason, record.reason);
    } else if (record.action === "deny") {
      denied += 1;
    } else {
      unchanged += 1;
      count(unchangedByReason, record.reason);
    }
    if (record.model_only === true) {
      modelOnly += 1;
    }
    // A rule that only watches. `would_route` is what it would have changed, so
    // these counts say what turning it on would cost before anyone turns it on.
    if (record.would_route && typeof record.would_route === "object") {
      ruleWouldFire += 1;
      count(ruleWouldFireByReason, record.would_route.reason ?? "unknown");
    }
    if (typeof record.notice === "string") {
      notices += 1;
      count(noticesByKind, noticeKind(record.notice));
    }
    const claude = record.claude;
    if (!claude || typeof claude !== "object") {
      claudeTightAtDispatch.unknown += 1;
    } else if (claude.tight === true) {
      claudeTightAtDispatch[claude.reason === "pace" ? "pace" : "gate"] += 1;
    } else {
      claudeTightAtDispatch.no += 1;
    }
  }

  // -- Jev --
  const jevErrors = {};
  const kinds = {};
  const latencies = [];
  let asked = 0;
  let answered = 0;
  let kindConfident = 0;
  let difficultyKnown = 0;
  const againstRequest = { agreed: 0, differed: 0, abstained: 0 };
  for (const record of dispatches) {
    const jev = record.jev;
    if (!jev || typeof jev !== "object") {
      continue;
    }
    asked += 1;
    if (jev.error !== undefined) {
      count(jevErrors, jev.error);
      continue;
    }
    answered += 1;
    count(kinds, jev.kind);
    if (typeof jev.latency_ms === "number") {
      latencies.push(jev.latency_ms);
    }
    if (typeof jev.kindConfidence === "number" && jev.kindConfidence >= config.kindGate) {
      kindConfident += 1;
    }
    if (typeof jev.difficultyConfidence === "number" && jev.difficultyConfidence >= config.difficultyGate) {
      difficultyKnown += 1;
    }
    if (record.action === "agree") {
      againstRequest.agreed += 1;
    } else if (record.route && record.route.model) {
      againstRequest.differed += 1;
    } else {
      againstRequest.abstained += 1;
    }
  }

  // -- Links between the records of one worker run --
  const agentOfToolUse = new Map();
  const toolUseOfAgent = new Map();
  const startOfAgent = new Map();
  const stopOfAgent = new Map();
  for (const record of log) {
    if (record.event === "launched" && record.tool_use_id && record.agent_id) {
      agentOfToolUse.set(record.tool_use_id, record.agent_id);
      toolUseOfAgent.set(record.agent_id, record.tool_use_id);
    } else if (record.event === "start" && record.agent_id) {
      startOfAgent.set(record.agent_id, record);
    } else if (record.event === "stop" && record.agent_id) {
      stopOfAgent.set(record.agent_id, record);
    }
  }
  const dispatchOfToolUse = new Map();
  for (const record of dispatches) {
    if (record.tool_use_id) {
      dispatchOfToolUse.set(record.tool_use_id, record);
    }
  }

  // -- Labels for a wrong route --
  const underRouting = {
    retriesBigger: 0,
    retriesOther: 0,
    verificationFailed: 0,
    verificationNotRun: 0,
    verificationJudgedByJev: 0,
    codexFailed: { count: 0, byCode: {} },
    stillRunning: 0
  };
  // Jev's label for the checks of each finished worker, written by the log hook.
  const outcomeOfAgent = new Map();
  for (const record of log) {
    if (record.event === "verification" && record.agent_id && typeof record.outcome === "string") {
      outcomeOfAgent.set(record.agent_id, record.outcome);
    }
  }
  const firstBySessionAndPrompt = new Map();
  const ordered = [...dispatches].sort((a, b) => (timeOf(a) ?? 0) - (timeOf(b) ?? 0));
  for (const record of ordered) {
    if (!record.session_id || typeof record.prompt !== "string") {
      continue;
    }
    const key = `${record.session_id}\n${record.prompt}`;
    const earlier = firstBySessionAndPrompt.get(key);
    if (!earlier) {
      firstBySessionAndPrompt.set(key, record);
      continue;
    }
    if (modelRank(record.final) > modelRank(earlier.final)) {
      underRouting.retriesBigger += 1;
    } else if (record.final?.agent !== earlier.final?.agent || record.final?.model !== earlier.final?.model) {
      underRouting.retriesOther += 1;
    }
  }
  for (const record of log) {
    if (record.event !== "stop" || typeof record.result !== "string") {
      continue;
    }
    if (record.result.startsWith("CODEX_FAILED")) {
      underRouting.codexFailed.count += 1;
      count(underRouting.codexFailed.byCode, codexFailureCode(record.result));
      continue;
    }
    if (record.result.startsWith("STILL_RUNNING")) {
      underRouting.stillRunning += 1;
      continue;
    }
    // Jev's label wins when the log hook got one. The hook judged the full
    // answer, so the label counts also when the logged result was cut before
    // its Verification line. The word search below stays for older records and
    // for stops without a label, and it can only read the logged text.
    const outcome = outcomeOfAgent.get(record.agent_id);
    if (outcome !== undefined) {
      underRouting.verificationJudgedByJev += 1;
      if (outcome === "not_run") {
        underRouting.verificationNotRun += 1;
      } else if (outcome === "failed") {
        underRouting.verificationFailed += 1;
      }
      continue;
    }
    const verification = verificationText(record.result);
    if (verification === null) {
      continue;
    }
    if (NOT_RUN.test(verification)) {
      underRouting.verificationNotRun += 1;
    } else if (FAILED_VERIFICATION.test(verification)) {
      underRouting.verificationFailed += 1;
    }
  }

  // -- Durations per worker, from start to stop --
  const durationsByAgent = {};
  for (const [agentId, stop] of stopOfAgent) {
    const start = startOfAgent.get(agentId);
    const startMs = start ? timeOf(start) : null;
    const stopMs = timeOf(stop);
    if (startMs === null || stopMs === null || stopMs < startMs) {
      continue;
    }
    const agentType = stop.agent_type ?? "unknown";
    durationsByAgent[agentType] = durationsByAgent[agentType] ?? [];
    durationsByAgent[agentType].push(stopMs - startMs);
  }
  const durations = {};
  for (const [agentType, values] of Object.entries(durationsByAgent)) {
    durations[agentType] = stats(values);
  }

  // -- Review findings by the family of the author --
  // The author is the last worker of the same session that really changed files
  // before the review was dispatched. A worker that failed, or that reported
  // "Changed files: none", is not an author. This is the rule of the cross-review.
  const authorsBySession = new Map();
  for (const record of ordered) {
    const family = WRITER_FAMILY[record.final?.agent];
    if (!family || !record.session_id) {
      continue;
    }
    const agentId = agentOfToolUse.get(record.tool_use_id);
    const stop = agentId ? stopOfAgent.get(agentId) : null;
    if (stop && reportsNoWrite(stop.result)) {
      continue;
    }
    const list = authorsBySession.get(record.session_id) ?? [];
    list.push({ ts: timeOf(record) ?? 0, family });
    authorsBySession.set(record.session_id, list);
  }
  const findings = {};
  for (const [agentId, stop] of stopOfAgent) {
    if (!REVIEWER_SET.has(stop.agent_type)) {
      continue;
    }
    const counts = stop.findings && typeof stop.findings === "object" ? stop.findings : countFindings(stop.result);
    const dispatch = dispatchOfToolUse.get(toolUseOfAgent.get(agentId));
    const reviewMs = dispatch ? timeOf(dispatch) : timeOf(stop);
    let family = "unknown";
    for (const author of authorsBySession.get(stop.session_id) ?? []) {
      if (reviewMs !== null && author.ts < reviewMs) {
        family = author.family;
      }
    }
    const bucket = findings[family] ?? (findings[family] = { reviews: 0, P0: 0, P1: 0, P2: 0, P3: 0 });
    bucket.reviews += 1;
    for (const priority of ["P0", "P1", "P2", "P3"]) {
      bucket[priority] += Number(counts[priority]) || 0;
    }
  }

  // -- Claude usage over time --
  const usage = {
    samples: 0,
    withResetTimes: 0,
    firstTs: null,
    lastTs: null,
    fiveHour: { min: null, max: null, last: null, windowsSeen: 0 },
    sevenDay: { min: null, max: null, last: null, windowsSeen: 0 },
    verdicts: { gate: 0, pace: 0, calm: 0, unknown: 0 }
  };
  const resetsSeen = { fiveHour: new Set(), sevenDay: new Set() };
  const sorted = [...limits].filter((record) => typeof record.ts === "number").sort((a, b) => a.ts - b.ts);
  for (const record of sorted) {
    usage.samples += 1;
    const ms = record.ts * 1000;
    usage.firstTs = usage.firstTs ?? ms;
    usage.lastTs = ms;
    const windows = [
      ["fiveHour", record.five_hour, record.five_hour_resets_at, FIVE_HOURS_MS],
      ["sevenDay", record.seven_day, record.seven_day_resets_at, SEVEN_DAYS_MS]
    ];
    let hasReset = false;
    let verdict = "unknown";
    for (const [name, used, resetsAt, lengthMs] of windows) {
      const bucket = usage[name];
      if (typeof used === "number") {
        bucket.min = bucket.min === null ? used : Math.min(bucket.min, used);
        bucket.max = bucket.max === null ? used : Math.max(bucket.max, used);
        bucket.last = used;
        if (verdict === "unknown") {
          verdict = "calm";
        }
      }
      const resetMs = typeof resetsAt === "number" && resetsAt > 0 ? resetsAt * 1000 : null;
      if (resetMs !== null) {
        hasReset = true;
        resetsSeen[name].add(resetsAt);
      }
      const answer = windowVerdict({ used: typeof used === "number" ? used : null, resetsAt: resetMs, sampledAt: ms, lengthMs }, config);
      if (answer.reason === "gate") {
        verdict = "gate";
      } else if (answer.reason === "pace" && verdict !== "gate") {
        verdict = "pace";
      }
    }
    if (hasReset) {
      usage.withResetTimes += 1;
    }
    usage.verdicts[verdict] += 1;
  }
  usage.fiveHour.windowsSeen = resetsSeen.fiveHour.size;
  usage.sevenDay.windowsSeen = resetsSeen.sevenDay.size;

  return {
    store: {
      dataDir: store.dataDir,
      files: store.files,
      records: log.length,
      firstTs: firstTs === null ? null : new Date(firstTs).toISOString(),
      lastTs: lastTs === null ? null : new Date(lastTs).toISOString(),
      sessions: sessionsSeen.size,
      projects,
      recordsWithoutCwd,
      hookErrors: log.filter((record) => record.event === "hook_error").length
    },
    filters: { since: sinceMs === null ? null : new Date(sinceMs).toISOString(), project },
    config: { kindGate: config.kindGate, difficultyGate: config.difficultyGate, limitGate: config.limitGate, pacing: config.pacing, paceAfter: config.paceAfter },
    dispatches: {
      total: dispatches.length,
      byMode,
      byAction,
      changed: { count: changed, share: share(changed, dispatches.length), byReason: changedByReason },
      wouldChange: { count: wouldChange, byReason: wouldChangeByReason },
      unchanged: { count: unchanged, byReason: unchangedByReason },
      denied,
      modelOnly,
      ruleWouldFire,
      ruleWouldFireByReason,
      notices: { count: notices, byKind: noticesByKind },
      claudeTightAtDispatch
    },
    jev: {
      asked,
      answered,
      errors: jevErrors,
      latency: stats(latencies),
      kinds,
      kindConfident: { count: kindConfident, share: share(kindConfident, answered) },
      difficultyKnown: { count: difficultyKnown, share: share(difficultyKnown, answered) },
      againstRequest
    },
    underRouting,
    durations,
    findings,
    claudeUsage: usage
  };
}

// ---- Text ----

function pairs(map) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return entries.length === 0 ? "none" : entries.map(([key, value]) => `${key} ${value}`).join(", ");
}

function percent(value) {
  return value === null ? "?" : `${value}%`;
}

function seconds(ms) {
  return ms === null ? "?" : `${Math.round(ms / 1000)} s`;
}

export function renderText(report) {
  const lines = [];
  const { store, dispatches, jev, underRouting, durations, findings, claudeUsage } = report;
  lines.push(`Store: ${store.dataDir}`);
  for (const file of store.files) {
    lines.push(`  ${file.name}: ${file.exists ? `records ${file.lines}${file.broken > 0 ? `, broken lines skipped ${file.broken}` : ""}` : "not there"}`);
  }
  if (store.records === 0 && claudeUsage.samples === 0) {
    lines.push("No records.");
    return `${lines.join("\n")}\n`;
  }
  if (report.filters.since || report.filters.project) {
    lines.push(`  Filters: ${[report.filters.since ? `since ${report.filters.since}` : null, report.filters.project ? `project contains "${report.filters.project}"` : null].filter(Boolean).join(", ")}`);
  }
  lines.push(`  ${store.records} log records from ${store.firstTs ?? "?"} to ${store.lastTs ?? "?"}, ${store.sessions} sessions, ${store.hookErrors} hook errors, ${store.recordsWithoutCwd} records without a project`);
  lines.push(`  Gates in force: kind ${report.config.kindGate}, difficulty ${report.config.difficultyGate}, limit ${report.config.limitGate}%, pace rule ${report.config.pacing ? `on after ${Math.round(report.config.paceAfter * 100)}% of a window` : "off"}`);
  lines.push("");
  lines.push(`Dispatches: ${dispatches.total} (${pairs(dispatches.byMode)})`);
  lines.push(`  Per project: ${pairs(store.projects)}`);
  lines.push(`  Actions: ${pairs(dispatches.byAction)}`);
  lines.push(`  Changed by the hook: ${dispatches.changed.count} of ${dispatches.total} (${percent(dispatches.changed.share)}): ${pairs(dispatches.changed.byReason)}`);
  lines.push(`  Would have changed in shadow mode: ${dispatches.wouldChange.count}: ${pairs(dispatches.wouldChange.byReason)}`);
  lines.push(`  Unchanged: ${dispatches.unchanged.count}: ${pairs(dispatches.unchanged.byReason)}`);
  lines.push(`  Denied by the writer lock: ${dispatches.denied}. Model-only dispatches to other agent types: ${dispatches.modelOnly}`);
  lines.push(`  A rule that only watched would have changed: ${dispatches.ruleWouldFire} of ${dispatches.total}: ${pairs(dispatches.ruleWouldFireByReason)}`);
  lines.push(`  Notices shown: ${dispatches.notices.count}: ${pairs(dispatches.notices.byKind)}`);
  lines.push(`  Claude tight at dispatch time: gate ${dispatches.claudeTightAtDispatch.gate}, pace ${dispatches.claudeTightAtDispatch.pace}, no ${dispatches.claudeTightAtDispatch.no}, unknown ${dispatches.claudeTightAtDispatch.unknown}`);
  lines.push("");
  lines.push(`Jev: asked ${jev.asked}, answered ${jev.answered}, errors: ${pairs(jev.errors)}`);
  lines.push(`  Latency: median ${jev.latency.medianMs ?? "?"} ms, mean ${jev.latency.meanMs ?? "?"} ms, max ${jev.latency.maxMs ?? "?"} ms`);
  lines.push(`  Kinds: ${pairs(jev.kinds)}`);
  lines.push(`  Kind confident: ${jev.kindConfident.count} of ${jev.answered} (${percent(jev.kindConfident.share)}). Difficulty known: ${jev.difficultyKnown.count} of ${jev.answered} (${percent(jev.difficultyKnown.share)})`);
  lines.push(`  Against the request: agreed ${jev.againstRequest.agreed}, differed ${jev.againstRequest.differed}, abstained ${jev.againstRequest.abstained}`);
  lines.push("");
  lines.push("Labels for a route that was too small (from the log; the other direction needs the offline task set):");
  lines.push(`  Retries of the same brief in one session: ${underRouting.retriesBigger} on a bigger model, ${underRouting.retriesOther} on another route`);
  lines.push(
    `  Worker results whose verification failed: ${underRouting.verificationFailed}. Verification not run: ${underRouting.verificationNotRun}. Judged by Jev: ${underRouting.verificationJudgedByJev}, the rest by a word search`
  );
  lines.push(`  Codex jobs that failed: ${underRouting.codexFailed.count}: ${pairs(underRouting.codexFailed.byCode)}. Still running when the worker answered: ${underRouting.stillRunning}`);
  lines.push("");
  lines.push("Durations from start to stop:");
  const agents = Object.keys(durations).sort();
  if (agents.length === 0) {
    lines.push("  none");
  }
  for (const agent of agents) {
    const d = durations[agent];
    lines.push(`  ${agent}: ${d.count} runs, median ${seconds(d.medianMs)}, mean ${seconds(d.meanMs)}, max ${seconds(d.maxMs)}`);
  }
  lines.push("");
  lines.push("Review findings by the family of the author:");
  const families = Object.keys(findings).sort();
  if (families.length === 0) {
    lines.push("  none");
  }
  for (const family of families) {
    const f = findings[family];
    lines.push(`  ${family}: ${f.reviews} reviews, P0 ${f.P0}, P1 ${f.P1}, P2 ${f.P2}, P3 ${f.P3}`);
  }
  lines.push("");
  lines.push(`Claude usage: ${claudeUsage.samples} samples${claudeUsage.samples > 0 ? ` from ${new Date(claudeUsage.firstTs).toISOString()} to ${new Date(claudeUsage.lastTs).toISOString()}` : ""}, ${claudeUsage.withResetTimes} with reset times`);
  for (const [name, label] of [["fiveHour", "5-hour"], ["sevenDay", "7-day"]]) {
    const w = claudeUsage[name];
    lines.push(`  ${label} window: min ${w.min ?? "?"}%, max ${w.max ?? "?"}%, last ${w.last ?? "?"}%, ${w.windowsSeen} windows seen`);
  }
  lines.push(`  Verdicts per sample: at the gate ${claudeUsage.verdicts.gate}, tight by pace only ${claudeUsage.verdicts.pace}, calm ${claudeUsage.verdicts.calm}, unknown ${claudeUsage.verdicts.unknown}`);
  return `${lines.join("\n")}\n`;
}
