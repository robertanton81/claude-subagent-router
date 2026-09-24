import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRequest } from "./questions.mjs";

const KEYCHAIN_SERVICE = "orchestrator-typesafe";

// An error with a short code that is safe to log. It never holds the key.
export class JevError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

function keyFromEnvFile(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*(.*?)\s*$/m);
  if (!match) {
    return null;
  }
  let value = match[1];
  const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
  if (quoted) {
    value = value.slice(1, -1);
  }
  return value || null;
}

// Returns { key, problem }. The problem is a short code only. The message and the
// output of the failed call are never used, because they could hold the key.
// The route hook's timeout in hooks/hooks.json leaves room for this wait and the
// longest classifier wait (`jevTimeoutMs` at its maximum); a test checks that.
export const KEYCHAIN_TIMEOUT_MS = 2000;

function keyFromKeychain() {
  try {
    const value = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return { key: value || null, problem: null };
  } catch (error) {
    // Status 44 means "no such item". Everything else means that the Keychain could not be read.
    if (error?.status === 44) {
      return { key: null, problem: null };
    }
    return { key: null, problem: `keychain:${error?.code ?? (error?.signal ? `signal_${error.signal}` : `status_${error?.status ?? "unknown"}`)}` };
  }
}

// Looks for the key in four places and says where it was found.
// The value is returned to the caller only. It is never written anywhere.
// `problems` lists places that exist but could not be read, as short codes, so
// "the key file is not readable" does not look the same as "there is no key".
export function findApiKey(env = process.env) {
  if (env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY) {
    return { key: env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY, source: "plugin_option", problems: [] };
  }
  if (env.TYPESAFE_API_KEY) {
    return { key: env.TYPESAFE_API_KEY, source: "env", problems: [] };
  }
  const problems = [];
  const envFile = env.ORCH_TYPESAFE_ENV_FILE || path.join(os.homedir(), ".config", "typesafe", ".env");
  try {
    const fromFile = keyFromEnvFile(envFile);
    if (fromFile) {
      return { key: fromFile, source: "env_file", problems };
    }
  } catch (error) {
    // The file exists but cannot be read. Note the reason and try the next place.
    problems.push(`env_file:${error?.code ?? "unreadable"}`);
  }
  if (process.platform === "darwin" && env.ORCH_DISABLE_KEYCHAIN !== "1") {
    const fromKeychain = keyFromKeychain();
    if (fromKeychain.key) {
      return { key: fromKeychain.key, source: "keychain", problems };
    }
    if (fromKeychain.problem) {
      problems.push(fromKeychain.problem);
    }
  }
  return { key: null, source: null, problems };
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

// Turns the API answers into the flat shape that the routing table reads.
export function readAnswers(body) {
  const answers = body?.answers;
  const kind = answers?.kind;
  const writesFiles = answers?.writes_files;
  const selfContained = answers?.self_contained;
  const difficulty = answers?.difficulty;
  const valid =
    typeof kind?.choice === "string" &&
    isNumber(kind?.confidence) &&
    isNumber(writesFiles?.noul) &&
    isNumber(selfContained?.noul) &&
    isNumber(difficulty?.score);
  if (!valid) {
    throw new JevError("bad_response", "an expected answer field is missing");
  }
  // `needs_every_match` is read only when it is there. It was added after the
  // other four, and a missing answer must leave the routing exactly as it was
  // rather than fail the dispatch.
  const needsEveryMatch = answers?.needs_every_match;
  return {
    kind: kind.choice,
    kindConfidence: kind.confidence,
    kindProbabilities: kind.probabilities ?? null,
    writesFiles: writesFiles.noul,
    selfContained: selfContained.noul,
    difficulty: difficulty.score,
    difficultyConfidence: isNumber(difficulty.confidence) ? difficulty.confidence : null,
    needsEveryMatch: isNumber(needsEveryMatch?.noul) ? needsEveryMatch.noul : null
  };
}

// Sends one request with all four questions. Throws a JevError on every failure.
export async function askJev(brief, config, key) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(config.jevUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildRequest(brief, config)),
      signal: AbortSignal.timeout(config.jevTimeoutMs)
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new JevError(timedOut ? "timeout" : "network", timedOut ? `${config.jevTimeoutMs} ms` : error?.cause?.code ?? error?.name);
  }
  if (!response.ok) {
    // The start of the error body often says which field of the request was wrong.
    let detail = "";
    try {
      // Hide the key before the cut. A cut first could split a key that the
      // body echoes, and the first half would no longer match the key.
      detail = (await response.text()).split(key).join("<hidden>").slice(0, 300);
    } catch {
      // The body could not be read. The status code alone must do.
    }
    throw new JevError(`http_${response.status}`, detail || undefined);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    // The time limit also covers the body, so a stalled body ends here as a timeout.
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new JevError(timedOut ? "timeout" : "bad_response", timedOut ? `${config.jevTimeoutMs} ms while reading the body` : "the body is not JSON");
  }
  return {
    answers: readAnswers(body),
    latencyMs: Date.now() - started,
    usage: body.usage ?? null,
    model: body.model ?? null
  };
}
