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
// `messages` holds the text of every agent message, in the order of the stream.
export function readEvents(dir) {
  const found = { usage: null, error: null, threadId: null, messages: [] };
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
    if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
      found.messages.push(event.item.text);
    }
  }
  found.messages.reverse();
  return found;
}

// A short note before the work ("I will read the diff first") is shorter than
// this. An answer is not.
const ANSWER_MIN_CHARS = 1000;

// The agent messages before the final one that may hold the answer: each is
// longer than the final message and long enough to be an answer. A model can
// write its answer in an earlier message and end with a short line, and the
// result file keeps only that last line. `codex exec --json` prints every agent
// message, so the text is not lost.
export function earlierLongMessages(messages, finalText) {
  const final = finalText.trim();
  const earlier = messages.map((text) => text.trim());
  if (earlier.length > 0 && earlier[earlier.length - 1] === final) {
    earlier.pop();
  }
  return earlier.filter((text) => text.length >= ANSWER_MIN_CHARS && text.length > final.length);
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
