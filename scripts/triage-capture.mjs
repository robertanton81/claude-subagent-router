#!/usr/bin/env node
// Capture hook of the finding triage: PostToolUse on SubagentHandback. It runs
// synchronously, so the report is on disk before SubagentStop fires, and it only
// writes one private file. It sends nothing, prints nothing and decides nothing,
// so it can never delay or change the hand-back.

import fs from "node:fs";

import { loadConfig } from "./lib/config.mjs";
import { appendLog } from "./lib/log.mjs";
import { stateKey, writeCapture } from "./lib/triage-state.mjs";

function main() {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.tool_name !== "SubagentHandback" || !input.agent_id) {
    return;
  }
  // Only an accepted hand-back is the report the caller got. A second hand-back
  // after the first was delivered is refused with success false.
  if (input.tool_response?.success !== true || typeof input.tool_input?.message !== "string") {
    return;
  }
  const { config } = loadConfig();
  if (!config.jevEnabled || config.mode === "off" || config.triageMode === "off") {
    return;
  }
  writeCapture(stateKey(input.session_id, input.agent_id), input.tool_input.message);
}

try {
  main();
} catch (error) {
  process.stderr.write(`subagent-router triage capture failed: ${error?.message ?? error}\n`);
  appendLog({ ts: new Date().toISOString(), event: "hook_error", hook: "triage-capture", error: String(error?.message ?? error) });
}
process.exitCode = 0;
