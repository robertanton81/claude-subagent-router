// Token counts of one finished subagent, read from its transcript.
//
// Claude Code names the transcript in the SubagentStop input
// (`agent_transcript_path`). It is a JSON Lines file. Each request of the
// subagent appears as one or more `assistant` lines: one line per content block
// (thinking, text, tool use), and every line of one reply repeats the same
// `message.id`. So each message id is counted once, with the usage of its last
// line.
//
// Claude Code writes the last lines of a transcript a little after it starts the
// SubagentStop hooks (seen: tens of ms in a session, about 400 ms in a
// `claude -p` run). So the hook waits, for a short time only, until the file
// shows the transcript's own end (see `transcriptEnded`).
//
// The format is not a documented interface. Every way it can go wrong ends in a
// status, never in an exception and never in a zero that looks real:
//   read     the whole transcript was read up to its end, every reply counted
//   partial  the counts are a lower bound, and `reason` says why: the end never
//            showed (`no_end`), lines were cut, unreadable or skipped, or some
//            replies kept only the output count of their stream's start
//            (`stream_output`, see below)
//   unread   no counts at all; `reason` says why. A transcript with no reply is
//            `no_usage`, never `read` with nothing: the subagent got no answer
//            (it was stopped, or its request failed), or the format has
//            changed. Replies that all failed a check give that check's reason.
// Claude Code 2.1.281 to 2.1.289 write no final usage for most replies that end
// in a tool call: the last line of such a reply has no `stop_reason`, and its
// output count is the one of the stream's start (a median of 8 tokens, against
// 508 for replies with a stop reason). Input and cache counts are set at the
// start, so they stay right. Each model's `stream_output` counts such replies,
// and the record is then `partial` (`stream_output`): output is a lower bound.
//
// The counts cover the whole transcript, so an agent that is continued after a
// stop gets a larger total at its next stop: the newest record is the total,
// and records of one agent are never added up.
// The result holds model ids (at most 100 characters of a fixed set) and counts
// only: no path and no transcript text.

import fs from "node:fs";
import path from "node:path";

// The largest transcript seen in 14 days on the owner's machine was 4 MB.
export const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
// A usage line longer than this is skipped, so one huge reply cannot use up the
// hook's 5 seconds in JSON.parse.
export const MAX_USAGE_LINE_BYTES = 2 * 1024 * 1024;
// The log hook must also release the writer lock and may call Jev afterwards,
// all inside the 5 seconds that Claude Code gives it.
export const MAX_READ_MS = 1000;
// How long the hook waits for the transcript's end, and how often it looks.
export const MAX_WAIT_MS = 1500;
export const POLL_MS = 25;

// Elapsed time is measured on a clock that never goes back.
const monotonic = () => performance.now();

// Tests shorten the wait. The value stays between 0 and 3 seconds.
export function usageWaitMs(env = process.env) {
  const raw = String(env.ORCH_USAGE_WAIT_MS ?? "").trim();
  const value = Number(raw);
  return raw !== "" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 3000) : MAX_WAIT_MS;
}

// Claude Code writes its own error notices as assistant lines of this model,
// with zero usage. They are not requests, but one at the end ends the run.
const SYNTHETIC_MODEL = "<synthetic>";
// A model id goes into the log as it is only when it looks like one; anything
// else counts as "unknown", so no long or odd text can reach the log this way.
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,100}$/;
// Why a reply ended its turn. A tool call ("tool_use", or null on a line that is
// not the last of its reply) means more is coming.
const END_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);
// Attachment lines that Claude Code writes after a run's end; seen after 3,147
// ends in real transcripts, and no other line type. Any other line after an end
// means that the run went on, so the transcript does not count as ended.
const TRAILING_ATTACHMENTS = new Set(["prompt_snapshot", "hook_success", "hook_non_blocking_error"]);
// Reasons after which waiting cannot help.
const FINAL_REASONS = new Set(["no_path", "not_absolute", "not_a_file", "too_large", "unreadable"]);

const COUNT_FIELDS = [
  ["input", "input_tokens"],
  ["output", "output_tokens"],
  ["cache_read", "cache_read_input_tokens"],
  ["cache_write", "cache_creation_input_tokens"]
];

function unread(reason, complete = false) {
  return { status: "unread", reason, models: {}, complete };
}

// Opens the file without following a symbolic link and reads at most `maxBytes`.
// A named pipe is a special file whose open waits until another process writes
// to it. O_NONBLOCK keeps the open from waiting; fstat, the check of the opened
// file's type and size, then refuses it. A regular file reads the same with or
// without O_NONBLOCK.
// Returns { text } or { reason }.
function readBounded(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error.code === "ENOENT") return { reason: "missing" };
    if (error.code === "ELOOP") return { reason: "not_a_file" };
    return { reason: "unreadable" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { reason: "not_a_file" };
    if (stat.size > maxBytes) return { reason: "too_large" };
    // The file may still grow; read only what fstat saw.
    const buffer = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const read = fs.readSync(fd, buffer, filled, stat.size - filled, filled);
      if (read === 0) break;
      filled += read;
    }
    return { text: buffer.subarray(0, filled).toString("utf8") };
  } catch {
    return { reason: "unreadable" };
  } finally {
    fs.closeSync(fd);
  }
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

// The counts of one reply, or null when the usage does not look as expected.
// Input and output must be whole numbers. The API sends null for a cache count
// when there is none, and an old reply may leave the field out, so both mean 0.
// Anything else (a string, a fraction, a negative number, a missing input or
// output) is not read as 0: the caller marks the counts partial.
function countsOf(usage) {
  const counts = {};
  for (const [name, field] of COUNT_FIELDS) {
    const value = usage[field];
    const optional = name === "cache_read" || name === "cache_write";
    if (isCount(value)) {
      counts[name] = value;
    } else if (optional && (value === null || value === undefined)) {
      counts[name] = 0;
    } else {
      return null;
    }
  }
  return counts;
}

// Whether the whole lines of a transcript reach its own end. Seen on 1,340 real
// transcripts (Claude Code 2.1.275 to 2.1.292): 1,175 end with a `user` line
// marked `toolEndsTurn` (a hand-back or a structured result), 124 with an
// `assistant` reply whose `stop_reason` ends the turn, 3 with an error notice.
// The known trailing attachments (TRAILING_ATTACHMENTS) can follow the end and
// are passed over. Each trailing line is parsed whole, whatever its size: the file
// is at most MAX_TRANSCRIPT_BYTES, only the last few lines are looked at, and a
// guess from the text could take a large attachment for an unfinished turn.
export function transcriptEnded(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return false;
    }
    if (row?.type === "attachment" && TRAILING_ATTACHMENTS.has(row.attachment?.type)) continue;
    if (row?.type === "user") return row.toolEndsTurn === true;
    if (row?.type === "assistant") {
      const message = row.message ?? {};
      return message.model === SYNTHETIC_MODEL || END_REASONS.has(message.stop_reason);
    }
    return false;
  }
  return false;
}

// Returns { status, reason?, models, complete }, where models maps a model id to
// { messages, input, output, cache_read, cache_write }, and complete says
// whether the file reached the transcript's end.
export function readTranscriptUsage(file, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_TRANSCRIPT_BYTES;
  const maxLineBytes = options.maxLineBytes ?? MAX_USAGE_LINE_BYTES;
  const maxMs = options.maxMs ?? MAX_READ_MS;
  const now = options.now ?? monotonic;
  const started = now();

  if (typeof file !== "string" || file === "") return unread("no_path");
  if (!path.isAbsolute(file)) return unread("not_absolute");

  const { text, reason } = readBounded(file, maxBytes);
  if (reason) return unread(reason);

  const lines = text.split("\n");
  // A file that does not end with a newline was cut during a write. Its last
  // piece is not a whole line, and the cut can come before the word "usage",
  // so any such piece makes the counts partial.
  const cut = lines.pop();
  let partial = cut !== "" ? "cut_line" : null;
  const complete = partial === null && transcriptEnded(lines);
  if (!complete) partial ??= "no_end";

  // message id -> { model, counts }; the last line of a reply wins.
  const replies = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    if (index % 200 === 0 && now() - started > maxMs) {
      partial = "time_limit";
      break;
    }
    const line = lines[index];
    // A reply line holds "usage", or at least its type; a reply without usage
    // must be seen too, or a changed format would read as complete.
    const hasUsage = line.includes('"usage"');
    if (!hasUsage && !line.includes('"type":"assistant"')) continue;
    if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
      partial ??= "long_line";
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      partial ??= "bad_line";
      continue;
    }
    const message = row?.message;
    if (row?.type !== "assistant" || typeof message !== "object" || message === null) continue;
    if (message.model === SYNTHETIC_MODEL) continue;
    const model = typeof message.model === "string" && MODEL_ID.test(message.model) ? message.model : "unknown";
    const counts = typeof message.usage === "object" && message.usage !== null && !Array.isArray(message.usage) ? countsOf(message.usage) : null;
    if (!counts) {
      partial ??= "bad_usage";
      continue;
    }
    // Without an id the lines of one reply cannot be told apart, and counting
    // each line could count one reply several times: skip it.
    const id = typeof message.id === "string" && message.id !== "" ? message.id : typeof row.requestId === "string" && row.requestId !== "" ? `request:${row.requestId}` : null;
    if (id === null) {
      partial ??= "no_id";
      continue;
    }
    replies.set(id, { model, counts, finalOutput: message.stop_reason !== null && message.stop_reason !== undefined });
  }

  // A Map, then own properties: a model id such as "__proto__" stays a plain key.
  const totals = new Map();
  for (const { model, counts, finalOutput } of replies.values()) {
    if (!totals.has(model)) totals.set(model, { messages: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, stream_output: 0 });
    const total = totals.get(model);
    total.messages += 1;
    if (!finalOutput) total.stream_output += 1;
    for (const [name] of COUNT_FIELDS) {
      total[name] += counts[name];
    }
  }
  for (const total of totals.values()) {
    if (!Object.values(total).every(isCount)) return unread("bad_usage", complete);
  }
  // No counts at all is always "unread", with the reason that caused it.
  if (totals.size === 0) return unread(partial ?? "no_usage", complete);
  if ([...totals.values()].some((total) => total.stream_output > 0)) partial ??= "stream_output";
  const models = Object.fromEntries(totals);
  return partial ? { status: "partial", reason: partial, models, complete } : { status: "read", models, complete };
}

function sizeOf(file) {
  try {
    return fs.lstatSync(file).size;
  } catch {
    // No size: the read that follows reports why (missing or unreadable).
    return null;
  }
}

// Reads the transcript, and reads it again whenever it grows, until it reaches
// its end or `maxWaitMs` has passed. Returns the last result with `wait_ms`.
export async function waitForTranscriptUsage(file, options = {}) {
  const maxWaitMs = options.maxWaitMs ?? MAX_WAIT_MS;
  const pollMs = options.pollMs ?? POLL_MS;
  const now = options.now ?? monotonic;
  const read = options.read ?? readTranscriptUsage;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let seenSize;
  let result;
  for (;;) {
    const size = typeof file === "string" && path.isAbsolute(file) ? sizeOf(file) : null;
    if (result === undefined || size !== seenSize) {
      const left = maxWaitMs - (now() - started);
      result = read(file, { ...options, now, maxMs: Math.min(options.maxMs ?? MAX_READ_MS, Math.max(left, 100)) });
      seenSize = size;
    }
    const waited = now() - started;
    if (result.complete || FINAL_REASONS.has(result.reason) || waited >= maxWaitMs) {
      return { ...result, wait_ms: Math.round(waited) };
    }
    await sleep(Math.min(pollMs, maxWaitMs - waited));
  }
}

// The time budget of the log hook at a stop. Claude Code stops the hook after
// 5 seconds. Normally the wait and the Jev call end by HOOK_DEADLINE_MS after
// the hook's start, which leaves room for the start of Node. Before the wait,
// the hook may have waited for the writer lock (up to 3 seconds in a rare
// case), so both parts are measured from the start, not from the wait. In that
// rare case the wait gets nothing and the Jev call still gets its minimum of
// 1 second, so the hook ends about 4 seconds after the lock wait began: later
// than HOOK_DEADLINE_MS, but inside the 5 seconds.
export const HOOK_DEADLINE_MS = 4000;
export const VERIFICATION_TIMEOUT_MS = 3000;
export const MIN_VERIFICATION_MS = 1000;

// How long the transcript wait may take, keeping a Jev call's minimum free.
// Whole milliseconds: the elapsed time comes from a clock with fractions.
export function usageWaitBudget(elapsedMs, waitMs) {
  return Math.floor(Math.max(0, Math.min(waitMs, HOOK_DEADLINE_MS - elapsedMs - MIN_VERIFICATION_MS - 100)));
}

// How long the Jev call may take: what is left before the deadline, at most
// 3 seconds and at most jevTimeoutMs, never less than 1 second. Whole
// milliseconds: AbortSignal.timeout refuses a fraction, and the call would then
// fail at once.
export function verificationBudget(elapsedMs, jevTimeoutMs) {
  return Math.floor(Math.min(jevTimeoutMs, VERIFICATION_TIMEOUT_MS, Math.max(MIN_VERIFICATION_MS, HOOK_DEADLINE_MS - elapsedMs)));
}

// The record for an error that the reader did not turn into a status, which
// would be a bug. It names the kind of error, never its message, which can
// hold a path.
export function usageErrorRecord(error, waitedMs) {
  const code = typeof error?.code === "string" && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : null;
  const name = typeof error?.name === "string" && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : null;
  return { status: "unread", reason: "error", error: code ?? name ?? "unknown", models: {}, complete: false, wait_ms: Math.round(waitedMs) };
}
