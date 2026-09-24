// How a task reaches a Codex worker.
//
// The task text is not trusted: it can quote a web page or an issue. If the thin
// worker pasted it into a shell command, a crafted line could end the quoting and
// run as a command. So the routing hook stores the task in a request file, and
// the worker receives only a request id with a fixed shape. The worker runs
//   orch-codex.mjs run <request id>
// and never handles the task text.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { BRANCH_PATTERN, COMMIT_PATTERN, EFFORTS, MODEL_PATTERN } from "./codex-args.mjs";
import { dataDir } from "./config.mjs";
import { ensurePrivateDir } from "./log.mjs";

export const REQUEST_ID_PATTERN = /^req-[0-9a-f]{12}$/;
const REQUEST_LINE = /^[ \t]*codex-request:[ \t]*(req-[0-9a-f]{12})[ \t]*$/m;

const DIRECTIVE_LINES = {
  "codex-model": /^[ \t]*codex-model:[ \t]*(.*?)[ \t]*$/im,
  "codex-effort": /^[ \t]*codex-effort:[ \t]*(.*?)[ \t]*$/im,
  "review-scope": /^[ \t]*review-scope:[ \t]*(.*?)[ \t]*$/im
};

export function requestsDir(env = process.env) {
  return path.join(dataDir(env), "codex-requests");
}

// Returns the text after "name:", or null when the brief has no such line.
// Spaces around a colon inside the value are dropped, so "base: main" works.
function directive(prompt, name) {
  const match = prompt.match(DIRECTIVE_LINES[name]);
  return match ? match[1].replace(/\s*:\s*/g, ":") : null;
}

// Reads the optional lines `codex-model:`, `codex-effort:` and `review-scope:`.
// A value with a wrong shape is never passed on. It is reported in `warnings`,
// and the request then fails at `run`. A silent fallback would, for example,
// review the uncommitted changes when the brief asked for a branch.
export function parseDirectives(prompt) {
  const text = typeof prompt === "string" ? prompt : "";
  const warnings = [];
  const result = { model: null, effort: null, scope: null };

  const model = directive(text, "codex-model");
  if (model !== null) {
    if (MODEL_PATTERN.test(model)) {
      result.model = model;
    } else {
      warnings.push("the line codex-model has characters that are not allowed");
    }
  }

  const effort = directive(text, "codex-effort");
  if (effort !== null) {
    if (EFFORTS.has(effort.toLowerCase())) {
      result.effort = effort.toLowerCase();
    } else {
      warnings.push(`the line codex-effort has "${effort}", which is not one of: ${[...EFFORTS].join(", ")}`);
    }
  }

  const scope = directive(text, "review-scope");
  if (scope !== null) {
    const [type, ...rest] = scope.split(":");
    const value = rest.join(":");
    if ((type === "uncommitted" || type === "custom") && !value) {
      result.scope = { type };
    } else if (type === "base" && BRANCH_PATTERN.test(value)) {
      result.scope = { type, value };
    } else if (type === "commit" && COMMIT_PATTERN.test(value)) {
      result.scope = { type, value };
    } else {
      warnings.push(`the line review-scope has "${scope}", which is not uncommitted, custom, base:<branch> or commit:<hash>`);
    }
  }

  return { ...result, warnings };
}

// The request id that a prompt already carries, or null. A prompt that is
// already a request must not be wrapped in a second request.
// A request is reused only by its own session, in its own folder, for the same
// kind of job. Otherwise a brief that names the id of another session's
// request could start that stored task, for example an implement task with
// write access in another project, from a call that asked for a review.
// Returns { id } for a request that may be reused, { refused } with the reason
// for one that exists but belongs elsewhere, and null when there is none.
export function existingRequestId(prompt, owner, env = process.env) {
  const match = typeof prompt === "string" ? prompt.match(REQUEST_LINE) : null;
  if (!match) {
    return null;
  }
  const id = match[1];
  const base = path.join(requestsDir(env), id);
  let stored = null;
  for (const suffix of [".json", ".claimed.json"]) {
    try {
      stored = JSON.parse(fs.readFileSync(`${base}${suffix}`, "utf8"));
      break;
    } catch {
      // Not in this state, or not readable.
    }
  }
  if (!stored) {
    return fs.existsSync(`${base}.job`) ? { refused: `${id} has no readable request record` } : null;
  }
  for (const field of ["session_id", "cwd", "kind"]) {
    if (stored[field] !== owner[field]) {
      return { refused: `${id} belongs to another ${field === "kind" ? "job kind" : field === "cwd" ? "folder" : "session"}` };
    }
  }
  return { id };
}

// Stores one task. Returns the request id, the review scope and the warnings
// from the directives. `defaultScope` is the scope of a review whose brief names
// none: the hook passes `custom` for a review that it moved from the Claude
// reviewer to Codex, so the brief travels as the review instructions. Without a
// default, such a review reviews the uncommitted changes and never sees the brief.
export function writeRequest({ kind, prompt, cwd, sessionId, toolUseId, defaultScope = null }, env = process.env) {
  const directives = parseDirectives(prompt);
  const id = `req-${crypto.randomBytes(6).toString("hex")}`;
  let scope = null;
  let scopeSource = null;
  if (kind === "review") {
    if (directives.scope) {
      [scope, scopeSource] = [directives.scope, "brief"];
    } else if (defaultScope) {
      [scope, scopeSource] = [defaultScope, "routing"];
    } else {
      [scope, scopeSource] = [{ type: "uncommitted" }, "default"];
    }
  }
  const request = {
    id,
    kind,
    model: directives.model,
    effort: directives.effort,
    scope,
    scope_source: scopeSource,
    cwd: cwd ?? null,
    session_id: sessionId ?? null,
    tool_use_id: toolUseId ?? null,
    created_at: new Date().toISOString(),
    directive_errors: directives.warnings,
    brief: typeof prompt === "string" ? prompt : ""
  };
  // The request holds the brief, so only this user may enter the folder.
  ensurePrivateDir(requestsDir(env));
  // Write under a temporary name first, so `run` never reads half a file.
  const file = path.join(requestsDir(env), `${id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(request, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return { id, scope, warnings: directives.warnings };
}

export function workerPrompt(id) {
  return [
    `codex-request: ${id}`,
    "",
    "The routing hook stored the task for this worker in a request file.",
    "Run the command from your instructions with this request id."
  ].join("\n");
}

// Claims a request so that it starts only one Codex job, even when `run` is
// called twice. Returns { request } for the first caller and { jobId } for a
// later caller. The rename is the claim: only one process can win it.
export function claimRequest(id, env = process.env) {
  const base = path.join(requestsDir(env), id);
  try {
    fs.renameSync(`${base}.json`, `${base}.claimed.json`);
    return { request: JSON.parse(fs.readFileSync(`${base}.claimed.json`, "utf8")), jobId: null };
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
  if (fs.existsSync(`${base}.job`)) {
    try {
      return { request: null, jobId: fs.readFileSync(`${base}.job`, "utf8").trim() };
    } catch (error) {
      // The record exists but cannot be read. The job may run, so nothing new starts.
      return { request: null, jobId: null, unreadableJob: error.message };
    }
  }
  if (fs.existsSync(`${base}.claimed.json`)) {
    return { request: null, jobId: null, pending: true };
  }
  return { request: null, jobId: null, missing: true };
}

export function recordJobOfRequest(id, jobId, env = process.env) {
  fs.writeFileSync(path.join(requestsDir(env), `${id}.job`), jobId, { mode: 0o600 });
}

// Gives a claimed request back, so that a later `run` can claim it again. For a
// request whose start failed before any runner existed. Does nothing when a job
// was recorded, because that job must not get a twin.
export function restoreRequest(id, env = process.env) {
  const base = path.join(requestsDir(env), id);
  if (fs.existsSync(`${base}.job`)) {
    return false;
  }
  try {
    fs.renameSync(`${base}.claimed.json`, `${base}.json`);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return false;
  }
}
