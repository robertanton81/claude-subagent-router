#!/usr/bin/env node
// Triage hook: SubagentStop, registered with "async": true, so the session
// never waits for it. For a finished review it picks the delivered report,
// splits it into findings, reads the code each finding cites, masks secrets,
// asks Jev whether the excerpt supports each finding, and saves the result.
// Nothing reaches the session: this is phase 1, which only logs.
//
// Order of sources for the report: the captured hand-back, then the last
// assistant message. Codex review jobs are not triaged here: the job worker
// (scripts/triage-sweep.mjs) takes every finished job, whoever started it. For a
// Codex reviewer stop this hook only writes the local count and starts that
// worker.

import { createHash } from "node:crypto";
import fs from "node:fs";

import { WORKERS, loadConfig } from "./lib/config.mjs";
import { findCodexResult } from "./lib/codex-result.mjs";
import { changeGroup, readExcerpt, repoState } from "./lib/evidence.mjs";
import { parseFindings } from "./lib/findings.mjs";
import { appendLog, registerSecret, registeredSecrets, truncate } from "./lib/log.mjs";
import { poolOf, poolsReserved } from "./lib/pools.mjs";
import { evalVersion } from "./lib/questions.mjs";
import { redactSecrets } from "./lib/secret-patterns.mjs";
import { startSweepWorker } from "./lib/sweep.mjs";
import { allowed, askJev, formatFor, prepareFinding, triageOn } from "./lib/triage-core.mjs";
import {
  abandonedKeys,
  claim,
  cleanup,
  deleteCapture,
  ownsClaim,
  publishDoneOnce,
  readCapture,
  readStop,
  release,
  releaseIfOwner,
  stateKey,
  writeDoneOnce,
  writeStop
} from "./lib/triage-state.mjs";
import { findApiKey } from "./lib/typesafe.mjs";

const POLL_MS = 200;

const handbackWaitMs = () => Number(process.env.ORCH_TRIAGE_HANDBACK_WAIT_MS ?? 30000);
const linkWaitMs = () => Number(process.env.ORCH_TRIAGE_LINK_WAIT_MS ?? 120000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countOf(items) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const item of items) {
    if (item.label in counts) counts[item.label] += 1;
  }
  return counts;
}

async function waitForCapture(key) {
  const started = Date.now();
  for (;;) {
    const captured = readCapture(key);
    if (captured !== null || Date.now() - started >= handbackWaitMs()) {
      return { captured, waitedMs: Date.now() - started };
    }
    await sleep(POLL_MS);
  }
}

async function pickReport(key, stop) {
  const auto = stop.permission_mode === "auto";
  let captured = readCapture(key);
  let waitedMs = 0;
  if (captured === null && auto) {
    ({ captured, waitedMs } = await waitForCapture(key));
  }
  if (captured !== null) {
    return { report: captured, source: "handback", handbackWaitMs: waitedMs };
  }
  return { report: stop.last_assistant_message ?? null, source: "final_message", handbackWaitMs: waitedMs, handbackMissing: auto };
}

async function processKey(key, stop, config) {
  const claimed = claim(key);
  if (!claimed.claimed) {
    if (claimed.reason === "done") {
      release(key);
    }
    if (claimed.reason === "abandoned") {
      // Published once: a result of an earlier attempt is never replaced.
      publishDoneOnce(key, { event: "triage", gate: "triage", agent_id: stop.agent_id, agent_type: stop.agent_type, error: "abandoned" });
      release(key);
    }
    return;
  }
  const { token } = claimed;
  const repo = repoState(stop.cwd);
  if (!allowed(repo, config)) {
    releaseIfOwner(key, token);
    return;
  }
  const picked = await pickReport(key, stop);
  const format = formatFor(stop.agent_type, config);
  const parse = parseFindings(picked.report, format);
  const secrets = registeredSecrets();
  const reportId = createHash("sha256").update(`${stop.session_id}\n${stop.agent_id}\n${picked.source}`).digest("hex").slice(0, 16);
  let redactions = 0;
  const findings = parse.items.map((item) => {
    // readExcerpt gives { excerpt }, { outcome: "withheld_secret" } or null,
    // the shape prepareFinding takes, so a key file holds the finding back.
    const prepared = prepareFinding(item, repo, secrets, (citation) => readExcerpt(repo.root, citation));
    redactions += prepared.redactions;
    return { ...prepared.finding, finding_id: `${reportId}#${item.index}` };
  });
  const jev = await askJev(findings, stop.cwd, config, { beforeSend: () => ownsClaim(key, token) });
  for (const f of findings) {
    if (f.outcome === null) f.outcome = "error";
  }
  const snapshot = picked.report === null ? null : redactSecrets(picked.report, registeredSecrets());
  const group = changeGroup(repo, stop.session_id, stop.agent_id);
  const version = evalVersion(config);
  const record = {
    ts: new Date().toISOString(),
    session_id: stop.session_id ?? null,
    cwd: stop.cwd ?? null,
    event: "triage",
    gate: "triage",
    mode: config.triageMode,
    report_id: reportId,
    agent_id: stop.agent_id,
    agent_type: stop.agent_type,
    source: picked.source,
    handback_checked: stop.permission_mode === "auto",
    handback_wait_ms: picked.handbackWaitMs ?? null,
    handback_missing: picked.handbackMissing ?? false,
    report_chars: picked.report?.length ?? 0,
    triage_version: version,
    eval_version: version,
    change_group: group.key,
    group_eligible: group.eligible,
    repo: { root: repo.root, common_dir: repo.commonDir, head: repo.head, dirty: repo.dirty, error: repo.error },
    parse: { state: parse.state, parser: parse.parser, count: parse.count },
    redactions: redactions + (snapshot?.count ?? 0),
    findings,
    jev
  };
  // Only the first result is kept; a hook that lost its claim while it was
  // suspended writes no log record either.
  if (!writeDoneOnce(key, token, { ...record, snapshot: snapshot?.withheld ? null : (snapshot?.text ?? null) })) {
    return;
  }
  appendLog({ ...record, findings: findings.map((f) => ({ ...f, excerpt: truncate(f.excerpt, config.resultLogChars) })) });
  releaseIfOwner(key, token);
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.hook_event_name !== "SubagentStop" || !input.agent_type || !input.agent_id) {
    return;
  }
  const { config, warnings } = loadConfig();
  for (const warning of warnings) {
    process.stderr.write(`subagent-router config: ${warning}\n`);
  }
  const key = stateKey(input.session_id, input.agent_id);
  // Register the key before any text is read, so every redaction masks it.
  const { key: apiKey } = findApiKey();
  if (apiKey) {
    registerSecret(apiKey);
  }

  // Save the stop input first, before any wait: a crash during the Codex lookup
  // or the retries must leave something that a later run can redo.
  const eligible = input.agent_type !== WORKERS.codexReviewer && Boolean(formatFor(input.agent_type, config)) && triageOn(config);
  if (eligible) {
    writeStop(key, input);
  }

  // The corrected Codex count is local and sends nothing, so it runs whatever
  // the triage switches say.
  // A count is kept only for a report that the parser understood, and it is
  // taken from the parser's items, so a tag written as [**P1**] counts. An unparsed
  // report or a missing one is unknown, never a review with zero findings.
  if (input.agent_type === WORKERS.codexReviewer) {
    const codex = await findCodexResult(input.agent_id, { waitMs: linkWaitMs() });
    const parsed = typeof codex.text === "string" ? parseFindings(codex.text, { parser: "p_tags" }) : null;
    const known = parsed !== null && ["parsed", "partial", "empty"].includes(parsed.state);
    appendLog({
      ts: new Date().toISOString(),
      session_id: input.session_id ?? null,
      cwd: input.cwd ?? null,
      event: "review_findings",
      agent_id: input.agent_id,
      agent_type: input.agent_type,
      source: known ? "codex_result" : "unavailable",
      reason: known ? null : (codex.reason ?? "unparsed"),
      job_id: codex.jobId ?? null,
      counts: known ? countOf(parsed.items) : null
    });
    if (triageOn(config)) {
      startSweepWorker();
    }
  }

  if (!eligible) {
    deleteCapture(key);
    return;
  }

  for (const old of abandonedKeys().filter((k) => k !== key)) {
    try {
      await processKey(old, readStop(old), config);
    } catch (error) {
      process.stderr.write(`subagent-router triage: retry of ${old} failed: ${error?.message ?? error}\n`);
    }
  }
  await processKey(key, input, config);
  cleanup({ keepDone: (_key, result) => poolsReserved() && result.group_eligible === true && poolOf(result.change_group) === "evaluation" });
}

try {
  await main();
} catch (error) {
  process.stderr.write(`subagent-router triage hook failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "triage", error: String(error?.message ?? error) });
}
process.exitCode = 0;
