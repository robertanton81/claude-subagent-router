// Remembers that the ChatGPT plan has no Codex capacity left.
//
// `codex exec` prints no limit numbers. Instead, the plugin learns about a
// used-up plan from two signals. codexState() in provider-state.mjs checks both.
// The job runner, codex-job-runner.mjs, reads both itself.
//
// The first signal is a failed job with a message such as:
//   "You've hit your usage limit. ... try again at Sep 24th, 2026 1:25 PM."
// This module handles that signal. After such a failure the routing table stops
// sending tasks to Codex until the time in the message. Until then, the job
// runner also starts no Codex job, unless `codexSpendCredits` is true. When the
// time cannot be read, the pause is one hour.
//
// The second signal is the limit numbers that Codex writes into its own session
// file. When a Codex job ends, its runner saves these numbers, unless they may
// be out of date (see codex-limits.mjs), and starts the pause for the first
// signal (see codex-events.mjs).

import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";

const USAGE_LIMIT = /usage limit|rate limit|quota/i;
const ONE_HOUR_MS = 3600 * 1000;
const EIGHT_DAYS_MS = 8 * 24 * ONE_HOUR_MS;

function file(env) {
  return path.join(dataDir(env), "codex-unavailable.json");
}

export function isUsageLimitMessage(message) {
  return typeof message === "string" && USAGE_LIMIT.test(message);
}

export function retryTimeFromMessage(message, now = Date.now()) {
  const match = typeof message === "string" ? message.match(/try again at ([^.]+?(?:AM|PM)?)\s*\.?\s*$/i) : null;
  if (match) {
    // "Sep 24th, 2026 1:25 PM" parses only without the "th".
    const parsed = Date.parse(match[1].replace(/(\d+)(st|nd|rd|th)\b/gi, "$1"));
    if (Number.isFinite(parsed) && parsed > now && parsed - now < EIGHT_DAYS_MS) {
      return parsed;
    }
  }
  return now + ONE_HOUR_MS;
}

// Writes a temporary file first and then renames it. Half a file would read as
// "no pause", and the runner would then start a job that credits might pay for.
export function markCodexUnavailable(message, env = process.env, now = Date.now()) {
  const temporary = `${file(env)}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dataDir(env), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ until: retryTimeFromMessage(message, now), message: String(message).slice(0, 300), recorded_at: new Date(now).toISOString() }));
    fs.renameSync(temporary, file(env));
  } catch (error) {
    process.stderr.write(`subagent-router: cannot record that Codex is unavailable: ${error.message}\n`);
  }
}

// The time in milliseconds until which Codex has no capacity, or null.
export function codexUnavailableUntil(env = process.env, now = Date.now()) {
  try {
    const until = Number(JSON.parse(fs.readFileSync(file(env), "utf8")).until);
    return Number.isFinite(until) && until > now ? until : null;
  } catch {
    // No marker file, or a damaged one. Both mean "no known problem".
    return null;
  }
}
