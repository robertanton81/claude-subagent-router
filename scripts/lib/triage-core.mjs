// The parts of the finding triage that the SubagentStop hook and the Codex job
// worker share: the switches, the consent check, the preparation of one
// finding and the request to Jev.

import fs from "node:fs";

import { REVIEWER_SET, loadConfig } from "./config.mjs";
import { findCitations, registeredWorktrees, repoIdentity, repoState } from "./evidence.mjs";
import { registerSecret } from "./log.mjs";
import { buildTriageRequest } from "./questions.mjs";
import { redactSecrets } from "./secret-patterns.mjs";
import { askTriage, findApiKey } from "./typesafe.mjs";

export const TEXT_MAX = 1500;
export const EXCERPT_MAX = 6000;
export const JEV_TIMEOUT_MS = 20000;

export function triageOn(config) {
  return config.jevEnabled && config.mode !== "off" && config.triageMode !== "off";
}

export function formatFor(agentType, config) {
  if (REVIEWER_SET.has(agentType)) {
    return { parser: "p_tags" };
  }
  const entry = config.reviewFormats.find((format) => format.agentTypes.includes(agentType));
  return entry ? { parser: "labelled", labels: entry.labels, emptyPhrases: entry.emptyPhrases ?? [] } : null;
}

// Exact real paths only: a prefix match would also allow a sibling folder.
// With triageWorktrees, a worktree of a listed checkout's repository is allowed
// too: the listed path must still be a top folder, the two git common
// directories (the shared .git folder of all worktrees of one repository) must
// be the same real path, and git must list the folder as one of the
// repository's worktrees.
//
// The answer is "allowed", "refused" when every lookup worked and no listed
// checkout covers the folder, or "unknown" when a lookup failed (a git
// timeout, a folder that is gone): an unknown answer must never become a
// permanent refusal.
export function consentDecision(repo, config) {
  if (!repo?.root) {
    // A folder that exists but is not in git is a definite answer; a folder
    // that is gone, or a git that failed, is not.
    return repo?.error === "not_a_repo" ? "refused" : "unknown";
  }
  let real;
  try {
    real = fs.realpathSync(repo.root);
  } catch {
    return "unknown";
  }
  let uncertain = false;
  for (const entry of config.triageProjects) {
    let listed;
    try {
      listed = fs.realpathSync(entry);
    } catch {
      uncertain = true;
      continue;
    }
    if (listed === real) {
      return "allowed";
    }
    if (!config.triageWorktrees) {
      continue;
    }
    const other = repoIdentity(listed);
    if (!repo.commonDir || !other.root) {
      uncertain = true;
      continue;
    }
    if (other.root !== listed || other.commonDir !== repo.commonDir) {
      continue;
    }
    // git lists at least the main worktree; an empty list means git failed.
    const worktrees = registeredWorktrees(listed);
    if (worktrees.length === 0) {
      uncertain = true;
      continue;
    }
    if (worktrees.includes(real)) {
      return "allowed";
    }
  }
  return uncertain ? "unknown" : "refused";
}

export function allowed(repo, config) {
  return consentDecision(repo, config) === "allowed";
}

// One finding, ready to send or with the outcome that keeps it back.
// readEvidence(citation) returns { excerpt, redactions }, { outcome } when a
// check refused the code, or null when the file cannot be read; the first
// citation with an excerpt wins. The excerpt must come from a reader that
// masked the whole file before it cut the numbered window (readExcerpt and
// readCheckedExcerpt do).
// The text is checked for a private key first. Then the citations are found
// in the finding's own text, not in the masked one: a mask after a secret word
// ("api token: src/a.mjs:10") would hide the citation. Only the masked text is
// sent. A citation of a credential file (marked by findCitations) holds the
// whole finding back at once, before any file is read. Every other citation
// is read, also after the first excerpt: when any cited file holds a private
// key ("withheld_secret"), the whole finding is held back at once, since its
// text may describe that key. Redacts first and cuts after, so a secret is
// never split at a limit.
export function prepareFinding(item, repo, secrets, readEvidence) {
  const finding = { finding_id: null, index: item.index, label: item.label, text: "", citation: null, excerpt: null, outcome: null, confidence: null, probabilities: null };
  const text = redactSecrets(item.text, secrets);
  let redactions = text.count;
  if (text.withheld) {
    return { finding: { ...finding, outcome: "withheld_secret" }, redactions };
  }
  finding.text = text.text.slice(0, TEXT_MAX);
  const candidates = findCitations(String(item.text ?? ""), repo.root);
  const named = candidates.find((candidate) => candidate.refused);
  if (named) {
    return { finding: { ...finding, citation: { path: named.path, start: named.start, end: named.end }, outcome: "withheld_secret" }, redactions };
  }
  let excerpt = null;
  let excerptRedactions = 0;
  let citation = null;
  let refused = null;
  for (const candidate of candidates) {
    const read = readEvidence(candidate);
    if (read?.outcome === "withheld_secret") {
      return { finding: { ...finding, citation: { path: candidate.path, start: candidate.start, end: candidate.end }, outcome: "withheld_secret" }, redactions };
    }
    if (citation) {
      continue;
    }
    if (read?.excerpt !== undefined && read.excerpt !== null) {
      excerpt = read.excerpt;
      excerptRedactions = Number.isInteger(read.redactions) ? read.redactions : 0;
      citation = candidate;
      continue;
    }
    if (read?.outcome && !refused) {
      refused = { outcome: read.outcome, citation: candidate };
    }
  }
  if (!citation) {
    if (refused) {
      const at = refused.citation;
      return { finding: { ...finding, citation: { path: at.path, start: at.start, end: at.end }, outcome: refused.outcome }, redactions };
    }
    return { finding: { ...finding, outcome: "no_citation" }, redactions };
  }
  // The second pass adds the registered secret values and the token shapes,
  // and checks for a private key again. It skips the name rule: the reader ran
  // it on the whole file, and on numbered lines it could take the next line's
  // number for the value.
  const masked = redactSecrets(excerpt, secrets, { assignments: false });
  redactions += excerptRedactions + masked.count;
  finding.citation = { path: citation.path, start: citation.start, end: citation.end };
  if (masked.withheld) {
    return { finding: { ...finding, outcome: "withheld_secret" }, redactions };
  }
  finding.excerpt = masked.text.slice(0, EXCERPT_MAX);
  return { finding, redactions };
}

// Asks Jev about every finding with an excerpt. Consent is read again right
// before sending, from the settings file and for the checkout at cwd: a long
// wait may lie behind us. beforeSend() is the last check (the job worker uses
// it to confirm it still owns its claim); when it says no, nothing is sent.
// apiKey: the key when the caller holds it outside the environment (the job
// worker gets it through a pipe); else the environment is read.
export async function askJev(findings, cwd, config, { beforeSend = () => true, env = process.env, apiKey = null } = {}) {
  const sendable = findings.filter((f) => f.excerpt !== null && f.outcome === null);
  if (sendable.length === 0) {
    return { latency_ms: null, usage: null, model: null, error: null };
  }
  const { config: fresh } = loadConfig(env);
  const consent = triageOn(fresh) ? consentDecision(repoState(cwd), fresh) : "refused";
  if (consent !== "allowed") {
    for (const f of sendable) f.outcome = "error";
    // "consent_unknown" (git could not decide) is tried again later.
    return { latency_ms: null, usage: null, model: null, error: consent === "unknown" ? "consent_unknown" : "consent_withdrawn" };
  }
  const key = apiKey || findApiKey(env).key;
  if (!key) {
    for (const f of sendable) f.outcome = "error";
    return { latency_ms: null, usage: null, model: null, error: "no_key" };
  }
  registerSecret(key);
  const { request, skipped } = buildTriageRequest(
    sendable.map((f) => ({ index: f.index, text: f.text, label: f.label, path: f.citation.path, start: f.citation.start, end: f.citation.end, excerpt: f.excerpt })),
    config
  );
  for (const f of sendable) {
    if (skipped.includes(f.index)) f.outcome = "skipped_budget";
  }
  const sent = sendable.filter((f) => f.outcome === null);
  if (!beforeSend()) {
    for (const f of sent) f.outcome = "error";
    return { latency_ms: null, usage: null, model: null, error: "not_owner" };
  }
  try {
    const answer = await askTriage(request, config, key, JEV_TIMEOUT_MS);
    // A pinned model must answer as itself. "jev-latest" is not a version: the
    // answer names the real one, which is kept (an evaluation refuses it anyway).
    if (!/-latest$/.test(config.jevModel) && answer.model !== config.jevModel) {
      for (const f of sent) f.outcome = "error";
      return { latency_ms: answer.latencyMs, usage: answer.usage, model: answer.model, error: "model_mismatch" };
    }
    sent.forEach((f, n) => {
      const a = answer.answers[`finding_${n}`];
      if (a?.choice) {
        f.outcome = a.choice;
        f.confidence = a.confidence;
        f.probabilities = a.probabilities;
      } else {
        f.outcome = "error";
      }
    });
    return { latency_ms: answer.latencyMs, usage: answer.usage, model: answer.model, error: null };
  } catch (error) {
    for (const f of sent) f.outcome = "error";
    return { latency_ms: null, usage: null, model: null, error: error.code ?? "unknown" };
  }
}
