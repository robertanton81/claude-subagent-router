#!/usr/bin/env node
// Logging hook for three events: PostToolUse on Agent, SubagentStart and SubagentStop.
// It never returns a decision. A failure here must not disturb the session.
//
// This file always runs its main function. It has no "am I the entry script"
// check, because such a check breaks for plugin paths with spaces, and the hook
// would then skip its work without any sign.

import fs from "node:fs";

import { REVIEWER_SET, WORKER_SET, WRITER_FAMILY, loadConfig } from "./lib/config.mjs";
import { recordWriterLaunch, recordWriterStop } from "./lib/context.mjs";
import { countFindings, reportsNoWrite, verificationText } from "./lib/findings.mjs";
import { appendLog, registerSecret, truncate } from "./lib/log.mjs";
import { askVerification, findApiKey } from "./lib/typesafe.mjs";
import { confirmClaudeWriterLock, releaseClaudeWriterLock } from "./lib/writer-lock.mjs";

// Claude Code stops this hook after 5 seconds (hooks/hooks.json). The Jev call
// must end well before that, whatever `jevTimeoutMs` says.
const VERIFICATION_TIMEOUT_MS = 3000;

function launchedRecord(input) {
  const response = input.tool_response ?? {};
  return {
    event: "launched",
    tool_use_id: input.tool_use_id ?? null,
    agent_id: response.agentId ?? null,
    status: response.status ?? null,
    final: {
      agent: input.tool_input?.subagent_type ?? null,
      model: input.tool_input?.model ?? null
    },
    resolved_model: response.resolvedModel ?? null,
    // Background launches carry no usage fields, so these two are often null.
    total_tokens: response.totalTokens ?? null,
    duration_ms: response.totalDurationMs ?? null
  };
}

function stopRecord(input, config) {
  const agentType = input.agent_type ?? null;
  const record = { event: "stop", agent_id: input.agent_id ?? null, agent_type: agentType };
  if (WORKER_SET.has(agentType)) {
    record.result = truncate(input.last_assistant_message ?? null, config.resultLogChars);
  }
  if (REVIEWER_SET.has(agentType)) {
    record.findings = countFindings(input.last_assistant_message);
  }
  return record;
}

// Asks Jev how the checks of a finished worker ended, and logs the answer as
// its own record. The stop record is already written, so a slow or killed call
// loses only this label, and the report then reads the words of the result.
// It runs only while Jev is on and the mode is not "off", like the routing,
// and sends only the verification part of the result.
async function logVerification(input, config, base) {
  if (!config.jevEnabled || config.mode === "off" || !WORKER_SET.has(input.agent_type)) {
    return;
  }
  const text = verificationText(input.last_assistant_message);
  if (!text) {
    return;
  }
  const { key, source } = findApiKey();
  if (!key) {
    return;
  }
  registerSecret(key);
  const record = { ...base, event: "verification", agent_id: input.agent_id ?? null, agent_type: input.agent_type };
  try {
    const answer = await askVerification(text, config, key, Math.min(config.jevTimeoutMs, VERIFICATION_TIMEOUT_MS));
    appendLog({
      ...record,
      outcome: answer.outcome,
      confidence: answer.confidence,
      latency_ms: answer.latencyMs,
      usage: answer.usage,
      model: answer.model,
      key_source: source
    });
  } catch (error) {
    appendLog({ ...record, error: error.code ?? "unknown", detail: error.message, key_source: source });
  }
}

async function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const { config, warnings } = loadConfig();
  for (const warning of warnings) {
    process.stderr.write(`subagent-router config: ${warning}\n`);
  }
  const base = { ts: new Date().toISOString(), session_id: input.session_id ?? null, cwd: input.cwd ?? null };

  switch (input.hook_event_name) {
    case "PostToolUse": {
      const record = launchedRecord(input);
      appendLog({ ...base, ...record });
      recordWriterLaunch(base.session_id, record.tool_use_id, record.final.agent, record.agent_id);
      break;
    }
    case "SubagentStart": {
      const record = { ...base, event: "start", agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null };
      // The route hook took the writer lock for this subagent in enforce mode.
      // "missing" in the log means that this writer runs without the lock.
      if (WRITER_FAMILY[record.agent_type] === "claude" && config.mode === "enforce") {
        record.writer_lock = confirmClaudeWriterLock({ cwd: base.cwd, sessionId: base.session_id, agentType: record.agent_type, agentId: record.agent_id }) ? "confirmed" : "missing";
      }
      appendLog(record);
      break;
    }
    case "SubagentStop":
      // Claude Code also fires this event for its own helper runs, such as the
      // short activity line it writes for a running subagent every half minute.
      // They come with an empty agent type, no SubagentStart, and no transcript
      // (seen on 2026-09-22 with Claude Code 2.1.278). They are not subagents
      // of the session, so the log keeps nothing about them.
      if (!input.agent_type) {
        break;
      }
      appendLog({ ...base, ...stopRecord(input, config) });
      // Before the Jev call below, which can take seconds: the next writer
      // should not wait for a label.
      if (WRITER_FAMILY[input.agent_type] === "claude" && !releaseClaudeWriterLock(input.agent_id)) {
        process.stderr.write("subagent-router: the writer lock of this subagent was not given back, because another process held its breaker; it counts until the session ends or for one hour\n");
      }
      recordWriterStop(base.session_id, input.agent_type, input.agent_id, reportsNoWrite(input.last_assistant_message));
      await logVerification(input, config, base);
      break;
    default:
      process.stderr.write(`subagent-router log hook: no handler for the event ${input.hook_event_name}\n`);
      break;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`subagent-router log hook failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "log", error: String(error?.message ?? error) });
}
process.exitCode = 0;
