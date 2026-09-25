#!/usr/bin/env node
// PostToolUse hook for the Claude file tools. It records that Claude changed a
// file, so the cross-review rule knows the real author of the current change.
// The main session's own edits count too, not only those of the plugin's workers.
// It never returns a decision and prints nothing. On any error it exits with 0.

import fs from "node:fs";

import { recordClaudeEdit } from "./lib/context.mjs";

// The same names as the matcher in hooks/hooks.json. The check here keeps the
// hook correct when someone widens the matcher.
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  if (input.hook_event_name === "PostToolUse" && FILE_TOOLS.has(input.tool_name)) {
    recordClaudeEdit(input.session_id ?? null);
  }
} catch (error) {
  process.stderr.write(`subagent-router edit hook failed: ${error?.message ?? error}\n`);
}
process.exitCode = 0;
