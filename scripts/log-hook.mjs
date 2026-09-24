#!/usr/bin/env node
// Logging hook for three events: PostToolUse on Agent, SubagentStart and SubagentStop.
// It never returns a decision. A failure here must not disturb the session.
//
// This file always runs its main function. It has no "am I the entry script"
// check, because such a check breaks for plugin paths with spaces, and the hook
// would then skip its work without any sign.

import fs from "node:fs";

import { REVIEWER_SET, WORKER_SET, loadConfig } from "./lib/config.mjs";
import { recordWriterLaunch, recordWriterStop } from "./lib/context.mjs";
import { countFindings, reportsNoWrite } from "./lib/findings.mjs";
import { appendLog, truncate } from "./lib/log.mjs";

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

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const { config, warnings } = loadConfig();
  for (const warning of warnings) {
    process.stderr.write(`orchestrator config: ${warning}\n`);
  }
  const base = { ts: new Date().toISOString(), session_id: input.session_id ?? null, cwd: input.cwd ?? null };

  switch (input.hook_event_name) {
    case "PostToolUse": {
      const record = launchedRecord(input);
      appendLog({ ...base, ...record });
      recordWriterLaunch(base.session_id, record.tool_use_id, record.final.agent, record.agent_id);
      break;
    }
    case "SubagentStart":
      appendLog({ ...base, event: "start", agent_id: input.agent_id ?? null, agent_type: input.agent_type ?? null });
      break;
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
      recordWriterStop(base.session_id, input.agent_type, input.agent_id, reportsNoWrite(input.last_assistant_message));
      break;
    default:
      process.stderr.write(`orchestrator log hook: no handler for the event ${input.hook_event_name}\n`);
      break;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`orchestrator log hook failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "log", error: String(error?.message ?? error) });
}
process.exitCode = 0;
