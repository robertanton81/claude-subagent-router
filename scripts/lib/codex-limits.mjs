// How much of the ChatGPT plan Codex has used.
//
// `codex exec --json` prints no limit numbers. Codex writes them only into its
// own session file, as `rate_limits` objects:
//   { "limit_id": "codex",
//     "primary": { "used_percent": 100, "window_minutes": 10080, "resets_at": 1790249137 },
//     "credits": { "has_credits": true, "balance": "57.76" } }
// When `used_percent` reaches 100, Codex does not stop. It goes on and pays from
// the credits balance. Credits are bought, so they are not part of the plan.
//
// The session file is an internal format of Codex, not a public interface. So
// every read here is guarded, and "cannot read" always means "unknown".

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataDir } from "./config.mjs";

const THREAD_ID_PATTERN = /^[0-9a-f-]{20,64}$/i;

function limitsFile(env) {
  return path.join(dataDir(env), "codex-limits.json");
}

function sessionsDir(env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

function findRateLimits(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (value.rate_limits && typeof value.rate_limits === "object") {
    return value.rate_limits;
  }
  for (const child of Object.values(value)) {
    const found = findRateLimits(child);
    if (found) {
      return found;
    }
  }
  return null;
}

// Finds the session file of a thread. Codex sorts the files into year/month/day
// folders, and the file name ends with the thread id.
function sessionFileOfThread(threadId, env, now) {
  if (!THREAD_ID_PATTERN.test(threadId ?? "")) {
    return null;
  }
  // A job can run over midnight, so look at today and yesterday.
  for (const dayOffset of [0, -1]) {
    const day = new Date(now + dayOffset * 24 * 3600 * 1000);
    const dir = path.join(sessionsDir(env), String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0"));
    try {
      const name = fs.readdirSync(dir).find((entry) => entry.endsWith(`${threadId}.jsonl`));
      if (name) {
        return path.join(dir, name);
      }
    } catch {
      // No folder for that day.
    }
  }
  return null;
}

// Reads the last limit numbers that Codex wrote for the plan limit of a thread.
// Returns null when there are none.
export function readLimitsOfThread(threadId, env = process.env, now = Date.now()) {
  try {
    const file = sessionFileOfThread(threadId, env, now);
    if (!file) {
      return null;
    }
    let last = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.includes("rate_limits")) {
        continue;
      }
      try {
        const limits = findRateLimits(JSON.parse(line));
        // Only an entry with a window says how much of the plan is used.
        if (limits?.primary && typeof limits.primary.used_percent === "number") {
          last = limits;
        }
      } catch {
        // A line that is not complete JSON.
      }
    }
    if (!last) {
      return null;
    }
    const balance = Number(last.credits?.balance);
    const window = bindingWindow(last, now);
    return {
      usedPercent: window.used_percent,
      windowMinutes: window.window_minutes ?? null,
      resetsAt: typeof window.resets_at === "number" ? window.resets_at * 1000 : null,
      hasCredits: last.credits?.has_credits === true,
      creditsBalance: Number.isFinite(balance) ? balance : null
    };
  } catch {
    return null;
  }
}

// Codex reports up to two plan windows. On some plans `primary` is the 5-hour
// window and `secondary` the weekly one; on others `primary` is the week and
// `secondary` is null. Either window can stop the plan. So the numbers of the
// window that is used most count, and among equal ones the one that ends later.
// Before, only `primary` counted: a used-up week next to a fresh 5-hour window
// looked like room, and the next job could be paid from credits.
function bindingWindow(limits, now) {
  const open = [limits.primary, limits.secondary].filter(
    (window) =>
      window &&
      typeof window.used_percent === "number" &&
      !(typeof window.resets_at === "number" && window.resets_at * 1000 <= now)
  );
  if (open.length === 0) {
    return limits.primary;
  }
  return open.reduce((best, window) =>
    window.used_percent > best.used_percent ||
    (window.used_percent === best.used_percent && (window.resets_at ?? 0) > (best.resets_at ?? 0))
      ? window
      : best
  );
}

// Two reads of one plan window can report resets_at some seconds apart. Plan
// windows are 5 hours or 7 days long. So a reset time that is one hour later
// or more belongs to a later window.
const SAME_WINDOW_MS = 3600 * 1000;

// Decides whether the numbers of a finished job may replace the saved numbers.
// Two jobs can run side by side, and the one that read its numbers first can
// end last. A percentage that is too low lets the next job start, and Codex may
// then pay from credits.
function mayReplaceSaved(limits, saved, now) {
  // readCodexLimits() would read numbers without a percentage as "unknown".
  if (!Number.isFinite(limits?.usedPercent)) {
    return false;
  }
  // The window of these numbers has ended, so they say nothing about the plan now.
  if (typeof limits.resetsAt === "number" && limits.resetsAt <= now) {
    return false;
  }
  // No saved numbers, or saved numbers of a window that has ended.
  if (!saved) {
    return true;
  }
  // A later window of the same length is newer, even with a lower percentage.
  // A window of another length belongs to another limit, for example after a
  // change of the plan. So its reset time says nothing about which is newer.
  const laterWindow =
    typeof limits.windowMinutes === "number" &&
    limits.windowMinutes === saved.windowMinutes &&
    typeof limits.resetsAt === "number" &&
    typeof saved.resetsAt === "number" &&
    limits.resetsAt - saved.resetsAt >= SAME_WINDOW_MS;
  if (laterWindow) {
    return true;
  }
  // In all other cases a save may keep or raise the percentage, never lower it.
  // In one window the percentage only grows, so a lower number there comes from
  // a job that ended earlier. A lower number of an earlier window, or of a window
  // that cannot be compared, may be old as well.
  if (limits.usedPercent !== saved.usedPercent) {
    return limits.usedPercent > saved.usedPercent;
  }
  // At the same percentage, the block that ends later stays. Two windows of
  // different length can both be at 100 percent, and a 5-hour block must not
  // replace a weekly one: after the short reset Codex would count as free.
  return !(typeof limits.resetsAt === "number" && typeof saved.resetsAt === "number" && limits.resetsAt < saved.resetsAt);
}

// Saves the numbers of a finished job, unless they may be older than the saved ones.
// Writes a temporary file first and then renames it. A reader then sees the old
// numbers or the new ones, never half a file, which would count as "unknown".
export function saveCodexLimits(limits, env = process.env, now = Date.now()) {
  if (!mayReplaceSaved(limits, readCodexLimits(env, now), now)) {
    return;
  }
  const temporary = `${limitsFile(env)}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dataDir(env), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ ...limits, ts: now }));
    fs.renameSync(temporary, limitsFile(env));
  } catch (error) {
    process.stderr.write(`subagent-router: cannot save the Codex limits: ${error.message}\n`);
  }
}

// The last known numbers, or null. Numbers from before the reset time say
// nothing about the new window, so they count as unknown.
export function readCodexLimits(env = process.env, now = Date.now()) {
  try {
    const saved = JSON.parse(fs.readFileSync(limitsFile(env), "utf8"));
    if (typeof saved.usedPercent !== "number") {
      return null;
    }
    if (typeof saved.resetsAt === "number" && saved.resetsAt <= now) {
      return null;
    }
    return saved;
  } catch {
    return null;
  }
}

// True when the plan allowance is used up and the next Codex run would be paid
// from credits, or would fail because there are no credits.
export function codexPlanIsUsedUp(limits) {
  return Boolean(limits) && limits.usedPercent >= 100;
}
