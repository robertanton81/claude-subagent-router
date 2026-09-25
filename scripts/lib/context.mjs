import fs from "node:fs";
import path from "node:path";

import { WRITER_FAMILY, dataDir } from "./config.mjs";
import { ensurePrivateDir, makeFilePrivate } from "./log.mjs";

export function limitsFile(env = process.env) {
  return env.ORCH_LIMITS_FILE || path.join(dataDir(env), "limits-latest.json");
}

// Reads the rate limit values that the status line script wrote.
// Returns { state, ... }. The state says why there is no value, so the setup
// check can tell "missing" from "damaged" from "too old".
export function readLimitsState(config, env = process.env, now = Date.now()) {
  const file = limitsFile(env);
  if (!fs.existsSync(file)) {
    return { state: "missing" };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return { state: "damaged", detail: error.message };
  }
  const ageMs = now - Number(parsed?.ts) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0) {
    return { state: "damaged", detail: "the ts field is not a valid time" };
  }
  if (ageMs > config.limitsMaxAgeMs) {
    return { state: "old", ageMs };
  }
  return {
    state: "ok",
    fiveHour: typeof parsed.five_hour === "number" ? parsed.five_hour : null,
    sevenDay: typeof parsed.seven_day === "number" ? parsed.seven_day : null,
    // The reset times and the sample time in milliseconds, like Date.now().
    fiveHourResetsAt: epochToMs(parsed.five_hour_resets_at),
    sevenDayResetsAt: epochToMs(parsed.seven_day_resets_at),
    sampledAt: Number(parsed.ts) * 1000,
    // The session whose status line wrote the sample.
    sessionId: typeof parsed.session_id === "string" ? parsed.session_id : null,
    ageMs
  };
}

function epochToMs(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : null;
}

// The values for the routing table, or null when there is no fresh value.
export function readLimits(config, env = process.env, now = Date.now()) {
  const limits = readLimitsState(config, env, now);
  return limits.state === "ok" ? limits : null;
}

// ---- Who wrote the current change ----
//
// The cross-review rule needs the model family of the last worker that really
// changed files. The big dispatch log cannot answer that reliably: one record
// holds up to 20,000 characters of prompt, so a byte window over its tail can
// lose the writer after a few dispatches. This small index has short records
// without prompts, and it is read as a whole.
//
//   {"s": session, "t": tool_use_id, "f": "claude" | "codex"}   a writer was dispatched
//   {"s": session, "t": tool_use_id, "a": agent_id}             that dispatch became this agent
//   {"s": session, "a": agent_id, "nw": true | false}           the agent stopped; nw = it wrote nothing
//   {"s": session, "f": "claude", "e": true}                    a Claude file tool changed a file
//
// The last kind comes from the edit hook. Without it, only the plugin's workers
// counted as authors: after a Codex change, an edit by the main session left
// Codex as the author, and the table moved the review to the Claude reviewer,
// so Claude reviewed its own change.

const WRITERS_FILE = "writers.jsonl";
const WRITERS_MAX_BYTES = 4 * 1024 * 1024;

function appendWriterRecord(record, env) {
  try {
    ensurePrivateDir(dataDir(env));
    const file = path.join(dataDir(env), WRITERS_FILE);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    makeFilePrivate(file);
  } catch (error) {
    process.stderr.write(`subagent-router: cannot write the writers index: ${error.message}\n`);
  }
}

export function recordWriterDispatch(sessionId, toolUseId, agent, env = process.env) {
  const family = WRITER_FAMILY[agent];
  if (family && sessionId) {
    appendWriterRecord({ s: sessionId, t: toolUseId ?? null, f: family }, env);
  }
}

export function recordWriterLaunch(sessionId, toolUseId, agent, agentId, env = process.env) {
  if (WRITER_FAMILY[agent] && sessionId && toolUseId && agentId) {
    appendWriterRecord({ s: sessionId, t: toolUseId, a: agentId }, env);
  }
}

// A Claude file tool (Edit, Write, ...) changed a file, in the main session or in
// any subagent. Codex never uses these tools, so the family is always Claude.
export function recordClaudeEdit(sessionId, env = process.env) {
  if (sessionId) {
    appendWriterRecord({ s: sessionId, f: "claude", e: true }, env);
  }
}

export function recordWriterStop(sessionId, agentType, agentId, wroteNothing, env = process.env) {
  if (WRITER_FAMILY[agentType] && sessionId && agentId) {
    appendWriterRecord({ s: sessionId, a: agentId, nw: Boolean(wroteNothing) }, env);
  }
}

function readWriterRecords(sessionId, env) {
  const file = path.join(dataDir(env), WRITERS_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - WRITERS_MAX_BYTES);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const records = [];
    for (const line of buffer.toString("utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.s === sessionId) {
          records.push(record);
        }
      } catch {
        // An empty line, or the cut first line of a tail.
      }
    }
    return records;
  } finally {
    fs.closeSync(handle);
  }
}

// Returns "claude", "codex" or null when no worker of this session changed files.
// A worker that failed, or that reported "Changed files: none", is not an author.
// A worker without a stop record is still running, so it counts as the author.
export function lastWriterFamily(sessionId, env = process.env) {
  if (!sessionId) {
    return null;
  }
  const records = readWriterRecords(sessionId, env);
  const agentOfDispatch = new Map();
  const wroteNothing = new Map();
  for (const record of records) {
    if (record.t && record.a) {
      agentOfDispatch.set(record.t, record.a);
    } else if (record.a && typeof record.nw === "boolean") {
      wroteNothing.set(record.a, record.nw);
    }
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record.f) {
      continue;
    }
    if (wroteNothing.get(agentOfDispatch.get(record.t)) !== true) {
      return record.f;
    }
  }
  return null;
}
