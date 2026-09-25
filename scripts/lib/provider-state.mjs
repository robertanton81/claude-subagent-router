// One place that answers: can each provider take work right now?
//
// The rule of the project is: when one subscription has no room left, the user
// is told once, and the work goes on with the other provider.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { codexUnavailableUntil } from "./codex-availability.mjs";
import { codexPlanIsUsedUp, readCodexLimits } from "./codex-limits.mjs";
import { WORKERS, dataDir, table } from "./config.mjs";
import { readLimitsState } from "./context.mjs";
import { ensurePrivateDir } from "./log.mjs";

// The Claude worker that takes over when Codex cannot run. The hook looks up every
// agent type here, also one from another owner, so the table has no inherited keys.
export const CLAUDE_FALLBACK = table({
  [WORKERS.codexImplementer]: { agent: WORKERS.implementer, model: "sonnet" },
  [WORKERS.codexReviewer]: { agent: WORKERS.reviewer, model: "sonnet" }
});

// The Codex jobs need `ps` and POSIX process groups to know when a job and the
// commands it started have ended. Windows has neither, so there Codex counts
// as off, whatever the config says. ORCH_TEST_PLATFORM lets tests pick a platform.
export function codexPlatformSupported(env = process.env) {
  return (env.ORCH_TEST_PLATFORM || process.platform) !== "win32";
}

export function codexState(config, env = process.env, now = Date.now()) {
  // Codex is opt-in. Off comes first, so no limit file can turn it back on.
  if (!config.codexEnabled || !codexPlatformSupported(env)) {
    return { available: false, until: null, reason: "codex_disabled", usedPercent: null, creditsBalance: null, tight: false };
  }
  const limits = readCodexLimits(env, now);
  const state = {
    available: true,
    until: null,
    reason: null,
    usedPercent: limits?.usedPercent ?? null,
    creditsBalance: limits?.creditsBalance ?? null,
    tight: typeof limits?.usedPercent === "number" && limits.usedPercent >= config.limitGate
  };
  const pausedUntil = codexUnavailableUntil(env, now);
  if (pausedUntil) {
    return { ...state, available: false, until: pausedUntil, reason: "codex_reported_usage_limit" };
  }
  // At 100 percent Codex does not stop. It pays from bought credits instead.
  // "Subscriptions only" means that this needs a clear yes from the user.
  if (codexPlanIsUsedUp(limits) && !config.codexSpendCredits) {
    return { ...state, available: false, until: limits.resetsAt ?? null, reason: "codex_plan_used_up" };
  }
  return state;
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// The verdict of one window: is Claude tight because of it, and why?
//   used       the percentage of the sample
//   resetsAt   when the window resets, in milliseconds
//   sampledAt  when the status line took the sample, in milliseconds
//   lengthMs   the length of the window
// Returns { tight, reason, projected, elapsedShare }.
//   reason        "gate" when the percentage is at the gate, "pace" when the
//                 projection reaches 100 percent before the reset, else null
//   projected     the percentage that the window reaches at its reset when the
//                 usage goes on at the same speed, or null when it cannot be known
//   elapsedShare  the part of the window that has passed, 0 to 1, or null
// Unknown stays unknown: without a valid reset time, or before `paceAfter` of the
// window has passed, only the gate counts. The projection aims at 100, not at the
// gate: a window that ends below 100 never runs out, so there is nothing to save.
export function windowVerdict({ used, resetsAt, sampledAt, lengthMs }, config) {
  if (typeof used !== "number") {
    return { tight: false, reason: null, projected: null, elapsedShare: null };
  }
  if (used >= config.limitGate) {
    return { tight: true, reason: "gate", projected: null, elapsedShare: null };
  }
  const timesAreValid = typeof resetsAt === "number" && typeof sampledAt === "number" && Number.isFinite(resetsAt) && Number.isFinite(sampledAt);
  const elapsedMs = timesAreValid ? lengthMs - (resetsAt - sampledAt) : NaN;
  if (!config.pacing || !(elapsedMs > 0) || elapsedMs > lengthMs) {
    return { tight: false, reason: null, projected: null, elapsedShare: null };
  }
  const elapsedShare = elapsedMs / lengthMs;
  const projected = Math.round((used * lengthMs) / elapsedMs);
  const tight = elapsedShare >= config.paceAfter && projected >= 100;
  return { tight, reason: tight ? "pace" : null, projected, elapsedShare: Math.round(elapsedShare * 1000) / 1000 };
}

// Is Claude tight right now? One place decides, and the routing table reads the
// answer. `tightReason` is "gate" or "pace" for the notices and the log, and
// `windows` holds the verdict of each window for the log.
export function claudeState(config, env = process.env, now = Date.now()) {
  const limits = readLimitsState(config, env, now);
  const known = limits.state === "ok";
  const fiveHour = known ? limits.fiveHour : null;
  const sevenDay = known ? limits.sevenDay : null;
  const windows = {
    fiveHour: windowVerdict({ used: fiveHour, resetsAt: known ? limits.fiveHourResetsAt : null, sampledAt: known ? limits.sampledAt : null, lengthMs: FIVE_HOURS_MS }, config),
    sevenDay: windowVerdict({ used: sevenDay, resetsAt: known ? limits.sevenDayResetsAt : null, sampledAt: known ? limits.sampledAt : null, lengthMs: SEVEN_DAYS_MS }, config)
  };
  const tight = windows.fiveHour.tight || windows.sevenDay.tight;
  // At the gate in either window comes first: it is the older rule and the surer one.
  const tightReason = !tight ? null : windows.fiveHour.reason === "gate" || windows.sevenDay.reason === "gate" ? "gate" : "pace";
  return {
    limits,
    fiveHour,
    sevenDay,
    fiveHourResetsAt: known ? limits.fiveHourResetsAt : null,
    sevenDayResetsAt: known ? limits.sevenDayResetsAt : null,
    tight,
    tightReason,
    windows
  };
}

export function describeTime(ms) {
  return ms ? new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "an unknown time";
}

export function codexNotice(codex) {
  if (codex.reason === "codex_disabled") {
    return 'Codex is off, because "codexEnabled" is not true in ~/.claude/orchestrator/config.json. Tasks for Codex run on Claude workers instead.';
  }
  const why = codex.reason === "codex_plan_used_up" ? "The weekly Codex allowance of the ChatGPT plan is used up" : "Codex reported that the ChatGPT plan has no capacity left";
  return `${why}. Until ${describeTime(codex.until)}, tasks for Codex run on Claude workers instead.`;
}

// "Claude usage is at 86% of the 5-hour window and 54% of the 7-day window." When
// the pace rule made Claude tight, the sentence says so, with the reset time, so
// the user knows why a window below the gate counts.
function claudeUsageText(claude) {
  const parts = [];
  if (typeof claude.fiveHour === "number") {
    parts.push(`${Math.round(claude.fiveHour)}% of the 5-hour window`);
  }
  if (typeof claude.sevenDay === "number") {
    parts.push(`${Math.round(claude.sevenDay)}% of the 7-day window`);
  }
  const usage = `Claude usage is at ${parts.join(" and ")}.`;
  if (claude.tightReason !== "pace") {
    return usage;
  }
  const window = claude.windows?.fiveHour?.reason === "pace" ? { name: "5-hour", verdict: claude.windows.fiveHour, resetsAt: claude.fiveHourResetsAt } : { name: "7-day", verdict: claude.windows?.sevenDay, resetsAt: claude.sevenDayResetsAt };
  return `${usage} At this pace the ${window.name} window runs out before it resets at ${describeTime(window.resetsAt)} (about ${window.verdict?.projected ?? "?"}% by then).`;
}

export function claudeNotice(claude) {
  return `${claudeUsageText(claude)} Tasks with a complete brief now run on Codex, to save the Claude limit.`;
}

// The notice for the limit rule for Claude alone: Codex cannot take work, so the
// hook lowers the biggest model instead of moving the task.
export function claudeCapNotice(claude) {
  return `${claudeUsageText(claude)} Codex cannot take work, so tasks that would run on Opus now run on Sonnet, to save the Claude limit.`;
}

// The notice for a limit rule that cannot see Claude usage, or null when it can.
// Only the status line receives the usage numbers, and the Claude Code desktop
// app runs no status line. Before this notice, the rule then stopped acting and
// nobody was told. A missing file gets no notice: the user never set the status
// line up, and the README says that the rule is then off.
export function limitsBlindNotice(claude, config) {
  const limits = claude.limits ?? {};
  const effect = "Until a fresh sample arrives, the hook does not lower Opus or move work to Codex when Claude usage is high.";
  if (limits.state === "old") {
    const minutes = Math.round(limits.ageMs / 60000);
    const maxMinutes = Math.round(config.limitsMaxAgeMs / 60000);
    return (
      `The limit rule is off: the last Claude usage sample is ${minutes} minutes old, and a sample counts for ${maxMinutes} minutes. ` +
      `The status line writes the sample; the Claude Code desktop app runs no status line, a terminal session does. ${effect}`
    );
  }
  if (limits.state === "damaged") {
    return `The limit rule is off: the Claude usage sample cannot be read (${limits.detail}). ${effect}`;
  }
  return null;
}

// Marks of notices that were shown are kept this long. A session that resumes
// after that sees its notice once more.
const NOTICE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function noticesDir(env = process.env) {
  return path.join(dataDir(env), "notices");
}

// True the first time that a session asks for a notice, false after that.
// The user wants to know about a switch, not to read about it on every dispatch.
//
// Each shown notice is one empty file, named by a hash of the session id and the
// notice key. The file is created with the flag "wx", which fails when the file
// exists. That is one step of the file system, so when hooks of parallel
// dispatches ask at the same moment, exactly one of them wins and shows the
// notice, and no hook can undo another's mark. (Until 2026-09-23 one JSON file
// held all marks; two hooks could both read it before either wrote, and both
// showed the notice.)
export function firstNotice(sessionId, key, env = process.env) {
  if (!sessionId) {
    return true;
  }
  const dir = noticesDir(env);
  const session = createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32);
  const mark = path.join(dir, `${session}.${String(key).replace(/[^A-Za-z0-9_-]/g, "_")}`);
  try {
    ensurePrivateDir(dir);
    try {
      fs.closeSync(fs.openSync(mark, "wx", 0o600));
    } catch (error) {
      // Only this "exists" means "shown already". The folder step can fail with
      // the same code, for a file where the folder should be.
      if (error.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } catch (error) {
    // A notice too many is better than a switch the user never hears about.
    process.stderr.write(`subagent-router: cannot save the notice state: ${error.message}\n`);
    return true;
  }
  pruneOldNotices(dir);
  return true;
}

// Runs only when a notice is shown, which is rare, so the hook pays for the
// look at the folder only then.
function pruneOldNotices(dir) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (now - fs.statSync(file).mtimeMs > NOTICE_MAX_AGE_MS) {
          fs.unlinkSync(file);
        }
      } catch {
        // Another hook removed it first.
      }
    }
  } catch (error) {
    process.stderr.write(`subagent-router: cannot clean up old notice marks: ${error.message}\n`);
  }
}
