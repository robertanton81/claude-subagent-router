// Finds the result of the Codex job behind a codex-reviewer subagent, from the
// plugin's own records: the launched record (agent id → tool use id), the
// dispatch record (tool use id → request id), the request's job file and the
// job's result.md. The wrapper's own answer is a paraphrase and is never used.
import fs from "node:fs";
import path from "node:path";

import { requestsDir } from "./codex-request.mjs";
import { readLogTail, rotatedLogFile } from "./log.mjs";
import { jobsDir } from "./writer-lock.mjs";

const TAIL_BYTES = 4 * 1024 * 1024;

// The last part of the older log file, which rotation leaves next to the new
// one. A review that ran across a rotation has its first records there.
function readRotatedTail(env) {
  const file = rotatedLogFile(env);
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  return text
    .slice(Math.max(0, text.length - TAIL_BYTES))
    .split("\n")
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
}

function lookup(agentId, env) {
  const records = [...readRotatedTail(env), ...readLogTail(env, TAIL_BYTES)];
  const launched = records.findLast((r) => r.event === "launched" && r.agent_id === agentId && r.tool_use_id);
  if (!launched) return { reason: "no_launched" };
  const dispatch = records.findLast((r) => r.event === "dispatch" && r.tool_use_id === launched.tool_use_id);
  const requestId = dispatch?.codex_request;
  if (typeof requestId !== "string" || !/^req-[A-Za-z0-9]+$/.test(requestId)) return { reason: "no_request" };
  const jobFile = path.join(requestsDir(env), `${requestId}.job`);
  if (!fs.existsSync(jobFile)) return { reason: "no_job" };
  const jobId = fs.readFileSync(jobFile, "utf8").trim();
  if (!/^[A-Za-z0-9-]+$/.test(jobId)) return { reason: "no_job" };
  return readJobResult(jobId, env);
}

// The report of a finished job, or why there is none. The runner writes
// exit-code last; cancel writes it without a rename, so an empty or partial
// file is "not finished", never exit code 0. A failed job, a missing result
// and an empty result each keep their reason: none of them is a review with
// zero findings.
export function readJobResult(jobId, env = process.env) {
  const dir = path.join(jobsDir(env), jobId);
  let marker;
  try {
    marker = fs.readFileSync(path.join(dir, "exit-code"), "utf8").trim();
  } catch {
    return { reason: "not_finished", jobId };
  }
  if (!/^\d+$/.test(marker)) return { reason: "not_finished", jobId };
  const exitCode = Number(marker);
  if (exitCode !== 0) return { reason: `exit_${exitCode}`, jobId, exitCode };
  let text;
  try {
    text = fs.readFileSync(path.join(dir, "result.md"), "utf8");
  } catch {
    return { reason: "no_result", jobId, exitCode };
  }
  if (text.trim() === "") return { reason: "empty_result", jobId, exitCode };
  return { text, jobId, exitCode };
}

// Only these reasons can change after SubagentStop: the launched record of a
// foreground subagent is written after the stop, and a job can still run. The
// dispatch record and the request's job file exist before the wrapper stops,
// and the runner writes exit-code last, so every other reason is final.
const MAY_CHANGE = new Set(["no_launched", "not_finished"]);

// Returns { text, jobId } or { reason }. For a foreground subagent, the launched
// record is written after SubagentStop, so this waits for it, checking every
// 2 seconds with the default wait (tests use a short wait). A final reason ends
// the wait at once: the hook runs at every Codex review stop, also while the
// triage is off.
export async function findCodexResult(agentId, { waitMs = 120000, env = process.env } = {}) {
  const interval = Math.max(50, Math.min(2000, waitMs / 5));
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = lookup(agentId, env);
    if (typeof found.text === "string" || !MAY_CHANGE.has(found.reason) || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
