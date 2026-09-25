// What a finished Codex job tells the plugin about the ChatGPT plan.
//
// The runner records these facts when Codex ends, so they are saved once per
// job, whether or not anybody waits for the result. Before, only the command
// that printed the result saved them. A job that ran past the worker's last
// wait was never printed, so a used-up plan went unnoticed, and the next job
// could be paid from credits.

import fs from "node:fs";
import path from "node:path";

import { isUsageLimitMessage, markCodexUnavailable } from "./codex-availability.mjs";
import { readLimitsOfThread, saveCodexLimits } from "./codex-limits.mjs";

// Reads events.jsonl from the end. With --json, Codex reports its own errors as
// events on stdout, for example a used-up plan, and not on stderr.
export function readEvents(dir) {
  const found = { usage: null, error: null, threadId: null };
  let lines = [];
  try {
    lines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").split("\n");
  } catch {
    return found;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") {
      found.threadId = event.thread_id;
    }
    if (!found.usage && event.type === "turn.completed" && event.usage) {
      found.usage = event.usage;
    }
    if (!found.error && (event.type === "turn.failed" || event.type === "error")) {
      found.error = event.error?.message ?? event.message ?? null;
    }
  }
  return found;
}

// True when the job ended well: exit code 0 and a final message.
export function jobSucceeded(dir, code) {
  try {
    return code === 0 && fs.readFileSync(path.join(dir, "result.md"), "utf8").trim() !== "";
  } catch {
    return false;
  }
}

// Saves the limit numbers of the job's thread, and starts the routing pause
// when the job failed with a usage limit. Each step guards itself, because the
// caller still has to write the exit code afterwards.
export function recordPlanState(dir, code) {
  const events = readEvents(dir);
  try {
    const limits = readLimitsOfThread(events.threadId);
    if (limits) {
      saveCodexLimits(limits);
    }
  } catch (error) {
    process.stderr.write(`subagent-router: cannot save the Codex limits of the job: ${error.message}\n`);
  }
  if (!jobSucceeded(dir, code) && isUsageLimitMessage(events.error)) {
    markCodexUnavailable(events.error);
  }
}
