#!/usr/bin/env node
// PreToolUse hook for the Agent tool. It has four jobs:
//   route     ask Jev, and rewrite the call when Jev is confident. For one of our
//             workers the hook can change the worker and the model. For every other
//             agent type it can change only the model, so the agent file keeps its
//             system prompt, its tools and its answer format.
//   enforce   redirect agent types that would bypass the routing
//   transport store the task of a Codex worker in a request file (see codex-request.mjs)
//   log       write every dispatch to the log
//
// Safety rule: this hook fails open. On every error it prints nothing and
// exits with 0, so the dispatch continues exactly as the orchestrator wrote it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CODEX_JOB_KIND, DEFAULT_MODEL, FIXED_MODEL_AGENTS, REDIRECTS, WORKER_SET, loadConfig } from "./lib/config.mjs";
import { existingRequestId, workerPrompt, writeRequest } from "./lib/codex-request.mjs";
import { lastWriterFamily, recordWriterDispatch } from "./lib/context.mjs";
import { appendLog, registerSecret, truncate } from "./lib/log.mjs";
import { CLAUDE_FALLBACK, claudeCapNotice, claudeNotice, claudeState, codexNotice, codexState, firstNotice } from "./lib/provider-state.mjs";
import { readRouteLine } from "./lib/route-line.mjs";
import { completenessShadow, decideModel, decideRoute, writerLockApplies } from "./lib/routing-table.mjs";
import { askJev, findApiKey } from "./lib/typesafe.mjs";
import { UNKNOWN_WRITER, activeCodexWriter, writerLockPath } from "./lib/writer-lock.mjs";

const AGENT_TOOL_NAMES = new Set(["Agent", "Task"]);
const ORCH_CODEX = path.join(path.dirname(fileURLToPath(import.meta.url)), "orch-codex.mjs");

// In enforce mode, a call that writerLockApplies() names must not start while a
// detached Codex job still changes files in the same folder.
function busyWriterDenial(input, finalAgent, config, jevAnswers) {
  if (config.mode !== "enforce" || !writerLockApplies(finalAgent, jevAnswers)) {
    return null;
  }
  const jobId = activeCodexWriter(input.cwd);
  if (!jobId) {
    return null;
  }
  if (jobId === UNKNOWN_WRITER) {
    return {
      jobId,
      reason:
        "A Codex writer lock holds this folder, but its job cannot be named, because the lock file cannot be read. Only one writer may run at a time. " +
        `Try again in a few minutes. Such a lock stops counting 15 minutes after it was written: ${writerLockPath(input.cwd)}`
    };
  }
  return {
    jobId,
    reason:
      `The Codex job ${jobId} is still changing files in this folder, and only one writer may run at a time. ` +
      `Wait for it with: node "${ORCH_CODEX}" wait ${jobId} . Or stop it with: node "${ORCH_CODEX}" cancel ${jobId}`
  };
}

// Decides which worker and model run. It changes `record` only to add details.
// Returns { action, reason, final }, where `final` is what will run.
async function decide(input, toolInput, requested, config, record, providers) {
  const unchanged = (action, reason) => ({ action, reason, final: { ...requested } });

  // Calls from inside a subagent are not routed. Our workers have no Agent tool,
  // so such a call comes from another plugin or a built-in agent.
  if (input.agent_id) {
    record.from_subagent = input.agent_type ?? true;
    return unchanged("pass", "from_subagent");
  }
  if (config.mode === "off") {
    return unchanged("pass", "mode_off");
  }

  const redirect = REDIRECTS[requested.agent];
  // While Codex is off, the plugin leaves other plugins' Codex agents alone.
  // A redirect would only move the call to a Claude worker the user did not ask for.
  if (redirect && providers.codex.reason === "codex_disabled") {
    return unchanged("pass", "codex_disabled");
  }
  if (redirect) {
    if (config.mode !== "enforce") {
      return unchanged("shadow", "would_redirect");
    }
    return { action: "redirect", reason: "bypass_agent", final: { agent: redirect, model: DEFAULT_MODEL[redirect] } };
  }
  // For one of our workers the table names a worker and a model. For every other
  // agent type it names only a model, and only when the configuration allows that.
  const ownWorker = WORKER_SET.has(requested.agent);
  if (!ownWorker && !config.routeOtherAgents) {
    return unchanged("pass", "other_agent_type");
  }
  if (!ownWorker && (FIXED_MODEL_AGENTS.has(requested.agent) || config.keepModelAgents.includes(requested.agent))) {
    return unchanged("pass", "keep_model_agent");
  }

  const routeLine = readRouteLine(toolInput.prompt);
  if (routeLine.warning) {
    record.brief_warnings = [routeLine.warning];
  }

  const { key, source, problems } = findApiKey();
  if (problems.length > 0) {
    // For example "env_file:EACCES": a place with a key exists but could not be read.
    record.key_problems = problems;
  }
  if (!key) {
    return unchanged("pass", problems.length > 0 ? "error_key_unreadable" : "error_no_key");
  }
  registerSecret(key);

  let jev;
  try {
    jev = await askJev({ description: toolInput.description, prompt: toolInput.prompt }, config, key);
  } catch (error) {
    record.jev = { error: error.code ?? "unknown", detail: error.message, key_source: source };
    return unchanged("pass", `error_${error.code ?? "unknown"}`);
  }
  record.jev = { ...jev.answers, latency_ms: jev.latencyMs, usage: jev.usage, model: jev.model, key_source: source };

  const context = {
    claudeTight: providers.claude.tight,
    lastWriterFamily: lastWriterFamily(input.session_id),
    codexAvailable: providers.codex.available,
    codexTight: providers.codex.tight,
    requestedAgent: requested.agent
  };
  let route;
  if (ownWorker) {
    route = decideRoute(jev.answers, context, config);
  } else {
    // The agent type of the call stays. Only the model can change.
    const picked = decideModel(jev.answers, context, config);
    route = { agent: picked.model ? requested.agent : null, model: picked.model, reason: picked.reason };
    record.model_only = true;
  }
  record.route = route;
  // The completeness rule, while it only watches. It changes nothing here; the
  // record says what it would have changed, so the report can count it.
  const wouldChange = completenessShadow(jev.answers, route, config);
  if (wouldChange) {
    record.would_route = wouldChange;
  }

  if (!route.model) {
    return unchanged("pass", route.reason);
  }
  // The brief asked for the call as written. Jev was still asked, so the log
  // shows what the table would have picked.
  if (routeLine.keep) {
    return unchanged("pass", "keep_requested");
  }
  const requestedModel = requested.model ?? DEFAULT_MODEL[requested.agent] ?? null;
  if (route.agent === requested.agent && route.model === requestedModel) {
    return unchanged("agree", route.reason);
  }
  if (config.mode === "shadow") {
    return unchanged("shadow", route.reason);
  }
  return { action: "rewrite", reason: route.reason, final: { agent: route.agent, model: route.model } };
}

// Stores the task of a Codex worker in a request file. Returns the new prompt
// for the worker, or null when the prompt stays as it is.
function prepareCodexTransport(input, toolInput, requested, decision, record) {
  const finalAgent = decision.final.agent;
  const kind = CODEX_JOB_KIND[finalAgent];
  if (!kind) {
    return null;
  }
  const already = existingRequestId(toolInput.prompt, { session_id: input.session_id ?? null, cwd: input.cwd ?? null, kind });
  if (already?.id) {
    // The worker gets only the id prompt, never other text next to the id.
    record.codex_request = already.id;
    const clean = workerPrompt(already.id);
    return toolInput.prompt === clean ? null : clean;
  }
  if (already?.refused) {
    // The whole brief becomes a new request of this call.
    record.codex_request_reuse_refused = already.refused;
  }
  // A review that the hook moved here from another reviewer keeps its brief.
  // Without a scope line it runs as a custom review, which reads the brief as
  // its instructions. A direct call to the Codex reviewer keeps the documented
  // default, the uncommitted changes. Before this, a moved review became a
  // review of the uncommitted changes, and its brief was lost.
  const moved = finalAgent !== requested.agent;
  const defaultScope = kind === "review" && moved ? { type: "custom" } : null;
  // A failed write is not caught here. Before, the rewrite to the Codex worker
  // went on with the raw brief, the text that this transport keeps away from the
  // worker. Now the error reaches the fail-open handler at the end of this file,
  // so the call runs as the orchestrator wrote it, and the log says why.
  const { id, scope, warnings } = writeRequest({
    kind,
    prompt: toolInput.prompt,
    cwd: input.cwd,
    sessionId: input.session_id,
    toolUseId: input.tool_use_id,
    defaultScope
  });
  record.codex_request = id;
  if (scope) {
    record.review_scope = scope.value ? `${scope.type}:${scope.value}` : scope.type;
  }
  if (warnings.length > 0) {
    record.codex_request_warnings = warnings;
  }
  return workerPrompt(id);
}

function emit(toolInput, requested, final, newPrompt, decision, systemMessage) {
  // updatedInput replaces the whole input object, so start from a full copy.
  const updatedInput = { ...toolInput };
  const routed = final.agent !== requested.agent || (final.model && final.model !== requested.model);
  if (final.agent !== requested.agent) {
    updatedInput.subagent_type = final.agent;
  }
  if (final.model && final.model !== requested.model) {
    updatedInput.model = final.model;
  }
  if (newPrompt) {
    updatedInput.prompt = newPrompt;
  }
  if (!routed && !newPrompt) {
    if (systemMessage) {
      process.stdout.write(JSON.stringify({ systemMessage }));
    }
    return;
  }

  // No permissionDecision here. The rewrite applies without one (tested), and
  // leaving it out keeps the normal permission checks of the user in place.
  const hookSpecificOutput = { hookEventName: "PreToolUse", updatedInput };
  if (routed) {
    hookSpecificOutput.additionalContext =
      final.agent === requested.agent
        ? `The orchestrator routing hook set the model ${final.model} for this task and kept the agent type. Reason: ${decision.reason}.`
        : `The orchestrator routing hook ran this task on ${final.agent} with the model ${final.model}. Reason: ${decision.reason}.`;
  }
  // systemMessage is the field that Claude Code shows to the user.
  process.stdout.write(JSON.stringify(systemMessage ? { systemMessage, hookSpecificOutput } : { hookSpecificOutput }));
}

// The record of the current dispatch. It lives outside main(), so a late error
// can still write what is known: the session, the request and the Jev answer.
let record = null;

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.hook_event_name !== "PreToolUse" || !AGENT_TOOL_NAMES.has(input.tool_name)) {
    return;
  }

  const { config, warnings } = loadConfig();
  const toolInput = input.tool_input ?? {};
  const requested = { agent: toolInput.subagent_type ?? null, model: toolInput.model ?? null };

  record = {
    ts: new Date().toISOString(),
    event: "dispatch",
    session_id: input.session_id ?? null,
    // The project folder. One global log serves every project, and this field tells them apart.
    cwd: input.cwd ?? null,
    tool_use_id: input.tool_use_id ?? null,
    mode: config.mode,
    requested,
    final: { ...requested },
    action: null,
    reason: null,
    jev: null,
    limits: null,
    description: toolInput.description ?? null,
    prompt: truncate(toolInput.prompt ?? null, config.promptLogChars)
  };
  if (warnings.length > 0) {
    record.config_warnings = warnings;
  }

  // The state of both subscriptions. The limits entry says why the limit rule had
  // no value: "missing", "damaged" or "old".
  const providers = { codex: codexState(config), claude: claudeState(config) };
  record.limits = providers.claude.limits;
  // Why Claude counts as tight, and the pace numbers behind it, so the log can
  // show how often the pace rule fires and how often it was wrong.
  record.claude = { tight: providers.claude.tight, reason: providers.claude.tightReason, windows: providers.claude.windows };
  record.codex = { available: providers.codex.available, reason: providers.codex.reason, used_percent: providers.codex.usedPercent };

  const decision = await decide(input, toolInput, requested, config, record, providers);

  // The project rule: when Codex has no room, the user is told once and the work
  // goes on with Claude. This also covers a direct call to a Codex worker.
  const fallback = CLAUDE_FALLBACK[decision.final.agent];
  if (config.mode === "enforce" && fallback && !providers.codex.available) {
    decision.action = "fallback";
    decision.reason = providers.codex.reason;
    decision.final = { ...fallback };
  }
  record.action = decision.action;
  record.reason = decision.reason;
  record.final = decision.final;

  // firstNotice() marks a notice as shown for the whole session.
  // A denied call shows no notice. So the lock check runs before the notice.
  const busy = busyWriterDenial(input, decision.final.agent, config, record.jev);
  if (busy) {
    // This is a deliberate "no", not an error, so it does not fall under the fail-open rule.
    record.action = "deny";
    record.reason = "codex_writer_busy";
    record.busy_job = busy.jobId;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: busy.reason } })
    );
    appendLog(record);
    return;
  }

  let systemMessage = null;
  if (config.mode === "enforce") {
    // A user who left Codex off hears about it only when a Codex worker was asked for,
    // not each time a review simply stays on the Claude reviewer. A direct call to the
    // Codex reviewer can reach the Claude reviewer through the table, not the fallback.
    const codexOff = providers.codex.reason === "codex_disabled";
    const askedForCodex = Boolean(CODEX_JOB_KIND[requested.agent]);
    const codexStepped = decision.action === "fallback" || (decision.reason === "codex_unavailable" && (!codexOff || askedForCodex));
    if (codexStepped && firstNotice(record.session_id, "codex_unavailable")) {
      systemMessage = codexNotice(providers.codex);
    } else if (decision.action === "rewrite" && decision.reason === "limit_rule" && firstNotice(record.session_id, "claude_tight")) {
      systemMessage = claudeNotice(providers.claude);
    } else if (decision.action === "rewrite" && decision.reason === "claude_tight" && firstNotice(record.session_id, "claude_capped")) {
      systemMessage = claudeCapNotice(providers.claude);
    }
  }
  if (systemMessage) {
    record.notice = systemMessage;
  }

  const newPrompt = prepareCodexTransport(input, toolInput, requested, decision, record);
  recordWriterDispatch(record.session_id, record.tool_use_id, decision.final.agent);
  appendLog(record);
  // Printing comes last. If anything above throws, nothing was printed, and the
  // error record that says "pass" is then true.
  emit(toolInput, requested, decision.final, newPrompt, decision, systemMessage);
}

main().catch((error) => {
  // Fail open: no output, exit code 0. The message goes to the debug log and to the dispatch log.
  process.stderr.write(`orchestrator route hook failed: ${error?.stack ?? error}\n`);
  const details = { name: error?.name ?? null, message: String(error?.message ?? error), stack: String(error?.stack ?? "").split("\n").slice(0, 6).join("\n") };
  if (record) {
    // Nothing was printed yet when main() failed, so the call runs as the orchestrator wrote it.
    appendLog({ ...record, final: { ...record.requested }, action: "pass", reason: "error_internal", error: details });
  } else {
    appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "route", error: details });
  }
  process.exitCode = 0;
});
