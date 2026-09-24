import { buildRequest } from "./questions.mjs";

// An error with a short code that is safe to log. It never holds the key.
export class JevError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

// Looks for the key in the two places a plugin should use, and says which one.
//   1. The plugin option `typesafe_api_key`. This is the Claude Code standard:
//      Claude Code asks for it, keeps it in the Keychain or its credentials
//      file, and passes it to hooks as CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY.
//   2. The variable TYPESAFE_API_KEY, for scripts, CI and --plugin-dir sessions.
// Nothing else is read: no file in the home folder, no Keychain item of our own,
// and never a file in the project. A cloned repository could ship such a file,
// and the briefs would then go to the TypeSafe account of whoever wrote it.
// The value is returned to the caller only. It is never written anywhere.
export function findApiKey(env = process.env) {
  if (env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY) {
    return { key: env.CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY, source: "plugin_option" };
  }
  if (env.TYPESAFE_API_KEY) {
    return { key: env.TYPESAFE_API_KEY, source: "env" };
  }
  return { key: null, source: null };
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
