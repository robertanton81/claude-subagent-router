import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  readTranscriptUsage,
  HOOK_DEADLINE_MS,
  transcriptEnded,
  usageErrorRecord,
  usageWaitBudget,
  usageWaitMs,
  verificationBudget,
  waitForTranscriptUsage
} from "../scripts/lib/transcript-usage.mjs";
import { ROOT, cleanEnv, makeTempDir, readLog, runNode, startFakeJev } from "./helpers.mjs";

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";

// One transcript line as Claude Code writes it: one line per content block,
// each line of a reply with the same message id. The line of a text block ends
// the turn by default (`stop_reason: "end_turn"`); a thinking or tool-use line
// has no stop reason unless the test gives one. `id: null` leaves the message id
// out; `requestId: null` leaves that out too.
function assistant(id, model, usage, { block = "text", requestId = `req_${id}`, stopReason = block === "text" ? "end_turn" : null } = {}) {
  const message = { model, role: "assistant", content: [{ type: block, text: "private reply text" }], stop_reason: stopReason, usage };
  if (id !== null) message.id = id;
  const row = { type: "assistant", message };
  if (requestId !== null) row.requestId = requestId;
  return JSON.stringify(row);
}

// A reply that ends in a tool call and carries its final usage.
const toolCall = (id, model, counts) => assistant(id, model, counts, { block: "tool_use", stopReason: "tool_use" });

function usage(input, output, cacheRead, cacheWrite) {
  return { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite };
}

// The totals of one model as the reader returns them.
function totals(messages, input, output, cacheRead, cacheWrite, streamOutput = 0) {
  return { messages, input, output, cache_read: cacheRead, cache_write: cacheWrite, stream_output: streamOutput };
}

function writeTranscript(dir, lines, { trailingNewline = true, name = "agent-a1.jsonl" } = {}) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return file;
}

function withDir(body) {
  const dir = makeTempDir();
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withDirAsync(body) {
  const dir = makeTempDir();
  try {
    return await body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const PROMPT = JSON.stringify({ type: "user", message: { role: "user", content: "the task" } });
const TOOL_RESULT = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "file text" }] } });
// The end of a hand-back or a structured result, as Claude Code writes it.
const HANDBACK_END = JSON.stringify({ type: "user", toolEndsTurn: true, message: { role: "user", content: [{ type: "tool_result", content: "handed back" }] } });
const SNAPSHOT = JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot" } });
const HOOK_SUCCESS = JSON.stringify({ type: "attachment", attachment: { type: "hook_success" } });
const QUEUED = JSON.stringify({ type: "attachment", attachment: { type: "queued_command" } });
const SYSTEM_LINE = JSON.stringify({ type: "system", subtype: "notice" });
const ERROR_NOTICE = assistant("msg_err", "<synthetic>", usage(0, 0, 0, 0), { stopReason: "stop_sequence" });
const ERROR_NOTICE_NO_REASON = assistant("msg_err", "<synthetic>", usage(0, 0, 0, 0), { stopReason: null });

const UNREAD = (reason, complete = false) => ({ status: "unread", reason, models: {}, complete });

// ---- the end of a transcript ----

test("a transcript ends with a turn-ending reply, a hand-back, or an error notice", () => {
  const reply = assistant("msg_1", HAIKU, usage(1, 1, 0, 0));
  const cases = [
    ["a reply that ends its turn", [PROMPT, reply], true],
    ["a hand-back, with the attachments that follow an end", [PROMPT, toolCall("msg_1", HAIKU, usage(1, 1, 0, 0)), HANDBACK_END, SNAPSHOT, HOOK_SUCCESS], true],
    ["an end, then an attachment that brings new input", [PROMPT, reply, QUEUED], false],
    ["an end, then a system line", [PROMPT, reply, SYSTEM_LINE], false],
    ["an error notice", [PROMPT, ERROR_NOTICE], true],
    ["an error notice with no stop reason", [PROMPT, ERROR_NOTICE_NO_REASON], true],
    ["a reply cut at max_tokens", [PROMPT, assistant("msg_1", HAIKU, usage(1, 1, 0, 0), { stopReason: "max_tokens" })], true],
    ["a refusal", [PROMPT, assistant("msg_1", HAIKU, usage(1, 1, 0, 0), { stopReason: "refusal" })], true],
    ["only the prompt", [PROMPT], false],
    ["a tool call still waiting for its result", [PROMPT, toolCall("msg_1", HAIKU, usage(1, 1, 0, 0))], false],
    ["the thinking line of a reply whose text is not written yet", [PROMPT, assistant("msg_1", HAIKU, usage(1, 1, 0, 0), { block: "thinking" })], false],
    ["a tool result that does not end the turn", [PROMPT, toolCall("msg_1", HAIKU, usage(1, 1, 0, 0)), TOOL_RESULT], false],
    ["a last line that does not parse, after a turn-ending reply", [PROMPT, reply, '{"type":"assistant"'], false],
    ["nothing", [], false]
  ];
  for (const [name, lines, ended] of cases) {
    assert.equal(transcriptEnded(lines), ended, name);
  }
});

test("a large line at the end is parsed whole, so a large attachment after the end does not hide it", () =>
  withDir((dir) => {
    // Larger than the 2 MiB limit for usage lines.
    const big = "x".repeat(3 * 1024 * 1024);
    const bigAttachment = JSON.stringify({ type: "attachment", attachment: { type: "prompt_snapshot", data: big } });
    const ended = writeTranscript(dir, [PROMPT, assistant("msg_1", HAIKU, usage(1, 10, 0, 0)), bigAttachment]);
    const result = readTranscriptUsage(ended);
    assert.deepEqual([result.status, result.complete], ["read", true]);
    // A large tool result that does not end the turn still means: not ended.
    const bigResult = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: big }] } });
    assert.equal(transcriptEnded([PROMPT, toolCall("msg_1", HAIKU, usage(1, 1, 0, 0)), bigResult]), false);
  }));

test("a transcript that has not reached its end gives a lower bound, never a complete count", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(1, 10, 0, 0)), TOOL_RESULT]);
    assert.deepEqual(readTranscriptUsage(file), {
      status: "partial",
      reason: "no_end",
      models: { [HAIKU]: totals(1, 1, 10, 0, 0) },
      complete: false
    });
    assert.deepEqual(readTranscriptUsage(writeTranscript(dir, [PROMPT])), UNREAD("no_end"));
  }));

// ---- counting ----

test("counts each reply once, from its last line, also with another reply between its blocks", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [
      PROMPT,
      assistant("msg_1", HAIKU, usage(10, 300, 0, 47000), { block: "thinking" }),
      TOOL_RESULT,
      toolCall("msg_2", HAIKU, usage(2, 50, 47379, 100)),
      assistant("msg_1", HAIKU, usage(10, 309, 0, 47379)),
      assistant("msg_3", SONNET, usage(5, 70, 1000, 0))
    ]);
    assert.deepEqual(readTranscriptUsage(file), {
      status: "read",
      models: { [HAIKU]: totals(2, 12, 359, 47379, 47479), [SONNET]: totals(1, 5, 70, 1000, 0) },
      complete: true
    });
  }));

test("a reply that kept only the output count of its stream's start makes the output a lower bound", () =>
  withDir((dir) => {
    // Claude Code 2.1.281 to 2.1.289 often write no final line for a tool call:
    // its only line has no stop reason and the output count of the start (8).
    const streamStart = assistant("msg_1", HAIKU, usage(5, 8, 100, 0), { block: "tool_use", stopReason: null });
    const file = writeTranscript(dir, [PROMPT, streamStart, TOOL_RESULT, assistant("msg_2", HAIKU, usage(5, 400, 200, 0))]);
    assert.deepEqual(readTranscriptUsage(file), {
      status: "partial",
      reason: "stream_output",
      models: { [HAIKU]: totals(2, 10, 408, 300, 0, 1) },
      complete: true
    });
    // The same reply with its final line counts as exact.
    const final = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(5, 480, 100, 0)), TOOL_RESULT, assistant("msg_2", HAIKU, usage(5, 400, 200, 0))]);
    assert.deepEqual(readTranscriptUsage(final).status, "read");
  }));

test("lines that are not assistant replies are never counted, even with a usage object", () =>
  withDir((dir) => {
    const reply = assistant("msg_1", HAIKU, usage(1, 10, 0, 100));
    const user = JSON.stringify({ type: "user", message: { id: "msg_u", model: HAIKU, usage: usage(9, 9, 9, 9) } });
    const system = JSON.stringify({ type: "system", message: { id: "msg_s", model: HAIKU, usage: usage(9, 9, 9, 9) } });
    const file = writeTranscript(dir, [user, reply, system]);
    assert.deepEqual(readTranscriptUsage(file).models, { [HAIKU]: totals(1, 1, 10, 0, 100) });
  }));

test("a reply without a message id is told apart by its request id, and skipped without one", () =>
  withDir((dir) => {
    const cases = [
      ["same request id", [assistant(null, HAIKU, usage(1, 10, 0, 0), { requestId: "req_a" }), assistant(null, HAIKU, usage(1, 11, 0, 0), { requestId: "req_a" })], "read", 1, 11],
      ["two request ids", [assistant(null, HAIKU, usage(1, 10, 0, 0), { requestId: "req_a" }), assistant(null, HAIKU, usage(1, 20, 0, 0), { requestId: "req_b" })], "read", 2, 30],
      ["one reply with no id at all", [assistant("msg_1", HAIKU, usage(1, 10, 0, 0)), assistant(null, HAIKU, usage(1, 20, 0, 0), { requestId: null })], "partial", 1, 10]
    ];
    for (const [name, lines, status, messages, output] of cases) {
      const result = readTranscriptUsage(writeTranscript(dir, lines));
      assert.deepEqual([result.status, result.models[HAIKU].messages, result.models[HAIKU].output], [status, messages, output], name);
      if (status === "partial") assert.equal(result.reason, "no_id", name);
    }
    const allAnonymous = writeTranscript(dir, [assistant(null, HAIKU, usage(1, 10, 0, 0), { requestId: null }), assistant(null, HAIKU, usage(1, 20, 0, 0), { requestId: null })]);
    assert.deepEqual(readTranscriptUsage(allAnonymous), UNREAD("no_id", true));
  }));

test("Claude Code's own notices are not counted as requests", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 0)), ERROR_NOTICE]);
    const result = readTranscriptUsage(file);
    assert.deepEqual([Object.keys(result.models), result.complete], [[HAIKU], true]);
  }));

test("the result holds no path and no transcript text", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 0))]);
    const text = JSON.stringify(readTranscriptUsage(file));
    assert.ok(!text.includes(dir), "no path");
    assert.ok(!text.includes("private reply text"), "no transcript text");
  }));

test("a model id that does not look like one is counted as unknown, and real ids of every shape are kept", () =>
  withDir((dir) => {
    const bedrock = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const longContext = "claude-sonnet-5-5[1m]";
    const gateway = "team/claude@eu";
    const longest = "m".repeat(100);
    const file = writeTranscript(dir, [
      assistant("msg_1", undefined, usage(1, 1, 0, 0)),
      assistant("msg_2", "m".repeat(101), usage(1, 2, 0, 0)),
      assistant("msg_3", "model with spaces", usage(1, 3, 0, 0)),
      assistant("msg_4", bedrock, usage(1, 4, 0, 0)),
      assistant("msg_5", longContext, usage(1, 5, 0, 0)),
      assistant("msg_6", gateway, usage(1, 6, 0, 0)),
      assistant("msg_7", longest, usage(1, 7, 0, 0))
    ]);
    const result = readTranscriptUsage(file);
    assert.deepEqual(result.models.unknown, totals(3, 3, 6, 0, 0));
    assert.deepEqual(
      [bedrock, longContext, gateway, longest].map((id) => result.models[id]?.output),
      [4, 5, 6, 7]
    );
  }));

test("a model id of __proto__ stays a plain key and never reaches the prototype", () =>
  withDir((dir) => {
    const result = readTranscriptUsage(writeTranscript(dir, [assistant("msg_1", "__proto__", usage(1, 4, 0, 0))]));
    assert.ok(Object.hasOwn(result.models, "__proto__"), "__proto__ is an own key");
    assert.equal(result.models.__proto__.output, 4);
    assert.equal({}.messages, undefined, "Object.prototype is untouched");
  }));

test("a transcript with no counted reply is unread, never a zero", () =>
  withDir((dir) => {
    // The run ended on an error before any reply.
    assert.deepEqual(readTranscriptUsage(writeTranscript(dir, [PROMPT, ERROR_NOTICE])), UNREAD("no_usage", true));
    // A renamed usage field, as a format change could bring.
    const renamed = JSON.stringify({ type: "assistant", message: { id: "msg_1", model: HAIKU, stop_reason: "end_turn", token_usage: usage(1, 10, 0, 0) } });
    assert.deepEqual(readTranscriptUsage(writeTranscript(dir, [PROMPT, renamed])), UNREAD("bad_usage", true));
  }));

test("a line cut during a write makes the counts partial, never wrong", () =>
  withDir((dir) => {
    const whole = assistant("msg_1", HAIKU, usage(1, 10, 0, 100));
    // The cut comes before the word "usage".
    const cut = assistant("msg_2", HAIKU, usage(1, 20, 0, 200)).slice(0, 40);
    assert.deepEqual(readTranscriptUsage(writeTranscript(dir, [whole, cut], { trailingNewline: false })), {
      status: "partial",
      reason: "cut_line",
      models: { [HAIKU]: totals(1, 1, 10, 0, 100) },
      complete: false
    });
    // A cut line is reported first, also when a bad line comes before it.
    const both = readTranscriptUsage(writeTranscript(dir, [whole, '{"usage": oops', cut], { trailingNewline: false }));
    assert.deepEqual([both.status, both.reason], ["partial", "cut_line"]);
  }));

test("a usage line that does not parse is skipped, and the lines after it still count", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 100)), '{"type":"assistant","message":{"usage": oops}}', assistant("msg_2", HAIKU, usage(1, 20, 0, 0))]);
    const result = readTranscriptUsage(file);
    assert.deepEqual([result.status, result.reason, result.models[HAIKU].messages, result.models[HAIKU].output], ["partial", "bad_line", 2, 30]);
  }));

test("usage that does not look as expected is never counted as zero", () =>
  withDir((dir) => {
    // The API sends null for a cache count when there is none: that is a real 0.
    const good = writeTranscript(dir, [assistant("msg_1", HAIKU, { input_tokens: 4, output_tokens: 9, cache_read_input_tokens: null })]);
    assert.deepEqual(readTranscriptUsage(good), { status: "read", models: { [HAIKU]: totals(1, 4, 9, 0, 0) }, complete: true });
    const cases = [
      ["empty usage", {}],
      ["a count as text", usage("4", 9, 0, 0)],
      ["a negative count", usage(4, -1, 0, 0)],
      ["a fraction", usage(4, 9.5, 0, 0)],
      ["a count past the safe integers", usage(4, 2 ** 60, 0, 0)],
      ["no output count", { input_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      ["no input count", { output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
      ["a cache count as text", usage(1, 9, "7", 0)],
      ["usage null", null],
      ["usage as text", "9 tokens"],
      ["usage as a list", [1, 2]],
      ["no usage field", undefined]
    ];
    for (const [name, bad] of cases) {
      const file = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 100)), assistant("msg_2", HAIKU, bad)]);
      const result = readTranscriptUsage(file);
      assert.deepEqual([result.status, result.reason, result.models[HAIKU]?.messages], ["partial", "bad_usage", 1], name);
    }
    // A user line whose content holds a reply object is no reply: the raw line
    // holds "type":"assistant" and "usage", so it is parsed, and its type decides.
    const quoted = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "assistant", usage: usage(9, 9, 9, 9) }] } });
    assert.ok(quoted.includes('"type":"assistant"') && quoted.includes('"usage"'));
    assert.equal(readTranscriptUsage(writeTranscript(dir, [quoted, assistant("msg_1", HAIKU, usage(1, 10, 0, 100))])).status, "read");
  }));

test("a sum past the safe integers is never logged as a count", () =>
  withDir((dir) => {
    // Each reply alone is a safe integer; their sum is not.
    const file = writeTranscript(dir, [toolCall("msg_1", HAIKU, usage(2 ** 52, 1, 0, 0)), TOOL_RESULT, assistant("msg_2", HAIKU, usage(2 ** 52, 1, 0, 0))]);
    assert.deepEqual(readTranscriptUsage(file), UNREAD("bad_usage", true));
  }));

test("a reply line over the size limit is skipped, and the lines after it still count", () =>
  withDir((dir) => {
    const short1 = toolCall("m1", HAIKU, usage(1, 1, 0, 0));
    const longUsage = assistant("msg_long", HAIKU, { ...usage(1, 99, 0, 0), padding: "x".repeat(400) });
    const short2 = assistant("m2", HAIKU, usage(1, 2, 0, 0));
    const limit = Math.max(Buffer.byteLength(short1), Buffer.byteLength(short2)) + 10;
    assert.ok(Buffer.byteLength(longUsage) > limit);
    assert.deepEqual(readTranscriptUsage(writeTranscript(dir, [short1, longUsage, short2]), { maxLineBytes: limit }), {
      status: "partial",
      reason: "long_line",
      models: { [HAIKU]: totals(2, 2, 3, 0, 0) },
      complete: true
    });
    // A long reply line without usage is not passed over in silence either.
    const longNoUsage = JSON.stringify({ type: "assistant", message: { id: "msg_long", model: HAIKU, stop_reason: "tool_use", content: [{ type: "text", text: "x".repeat(400) }] } });
    const result = readTranscriptUsage(writeTranscript(dir, [short1, longNoUsage, short2]), { maxLineBytes: limit });
    assert.deepEqual([result.status, result.reason], ["partial", "long_line"]);
  }));

test("the read stops at its time limit and says so", () =>
  withDir((dir) => {
    const lines = [];
    for (let index = 0; index < 500; index += 1) {
      lines.push(assistant(`msg_${index}`, HAIKU, usage(1, 1, 0, 0)));
    }
    const file = writeTranscript(dir, lines);
    // Each look at the clock moves it on by 600 ms, so the second check, at
    // line 200, is past the 1,000 ms limit.
    let clock = 0;
    const result = readTranscriptUsage(file, { now: () => (clock += 600) });
    assert.deepEqual([result.status, result.reason, result.models[HAIKU].messages], ["partial", "time_limit", 200]);
  }));

test("a transcript that cannot be read gives a reason and no counts", () =>
  withDir((dir) => {
    const file = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 100))]);
    const link = path.join(dir, "link.jsonl");
    fs.symlinkSync(file, link);
    const cases = [
      [undefined, "no_path"],
      ["", "no_path"],
      ["agent-a1.jsonl", "not_absolute"],
      [path.join(dir, "missing.jsonl"), "missing"],
      [dir, "not_a_file"],
      [link, "not_a_file"],
      [path.join(dir, "a\0b.jsonl"), "unreadable"]
    ];
    for (const [input, reason] of cases) {
      assert.deepEqual(readTranscriptUsage(input), UNREAD(reason), JSON.stringify(input));
    }
    assert.deepEqual(readTranscriptUsage(file, { maxBytes: 10 }), UNREAD("too_large"));
  }));

// A named pipe (a special file whose open waits until another process writes
// to it) would block a plain open until a writer comes. The read runs in a
// child with a time limit, so a regression fails here and cannot hang the suite.
test("a named pipe is refused at once, not waited on", { skip: process.platform === "win32" }, () =>
  withDir((dir) => {
    const fifo = path.join(dir, "agent-a1.jsonl");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0, "mkfifo");
    const moduleUrl = pathToFileURL(path.join(ROOT, "scripts", "lib", "transcript-usage.mjs")).href;
    const code = `const { readTranscriptUsage } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(readTranscriptUsage(${JSON.stringify(fifo)})));`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.signal, null, "the read did not wait for a writer");
    assert.deepEqual(JSON.parse(child.stdout), UNREAD("not_a_file"));
  }));

// ---- waiting for the end ----

// A clock that only the fake sleep moves, and a sleep that can run a step at a
// given time, so no test waits for real time.
function fakeTime(steps = []) {
  let clock = 0;
  const todo = [...steps].sort((a, b) => a.at - b.at);
  return {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      while (todo.length && todo[0].at <= clock) todo.shift().run();
    }
  };
}

test("the wait reads again when the file grows, and stops at the transcript's end", async () =>
  withDirAsync(async (dir) => {
    const file = writeTranscript(dir, [PROMPT, assistant("msg_1", HAIKU, usage(1, 10, 0, 0), { block: "thinking" })]);
    const time = fakeTime([{ at: 100, run: () => fs.appendFileSync(file, `${assistant("msg_1", HAIKU, usage(1, 12, 0, 0))}\n`) }]);
    const result = await waitForTranscriptUsage(file, { maxWaitMs: 1500, pollMs: 25, now: time.now, sleep: time.sleep });
    assert.deepEqual(result, { status: "read", models: { [HAIKU]: totals(1, 1, 12, 0, 0) }, complete: true, wait_ms: 100 });
  }));

test("the wait reads a file again only when it grew, with the read time capped by the time left", async () =>
  withDirAsync(async (dir) => {
    const file = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(1, 10, 0, 0))]);
    const reads = [];
    const read = (f, options) => {
      reads.push(options.maxMs);
      return readTranscriptUsage(f, options);
    };
    // The file grows once, 50 ms before the end of the wait.
    const time = fakeTime([{ at: 1450, run: () => fs.appendFileSync(file, `${TOOL_RESULT}\n`) }]);
    const result = await waitForTranscriptUsage(file, { maxWaitMs: 1500, pollMs: 25, now: time.now, sleep: time.sleep, read });
    assert.deepEqual([result.reason, result.wait_ms], ["no_end", 1500]);
    // One read at the start, one after the growth; the second gets at least
    // 100 ms, not the full second.
    assert.deepEqual(reads, [1000, 100]);
  }));

test("a transcript whose end never comes gives a lower bound after the full wait", async () =>
  withDirAsync(async (dir) => {
    const file = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(1, 10, 0, 0))]);
    const time = fakeTime();
    const result = await waitForTranscriptUsage(file, { maxWaitMs: 1500, pollMs: 25, now: time.now, sleep: time.sleep });
    assert.deepEqual([result.status, result.reason, result.complete, result.wait_ms], ["partial", "no_end", false, 1500]);
  }));

test("the wait does not wait for what cannot change, but waits for a file that is not there yet", async () =>
  withDirAsync(async (dir) => {
    const big = writeTranscript(dir, [assistant("msg_1", HAIKU, usage(1, 10, 0, 0))], { name: "big.jsonl" });
    const cases = [
      [undefined, "no_path", {}],
      ["agent.jsonl", "not_absolute", {}],
      [dir, "not_a_file", {}],
      [big, "too_large", { maxBytes: 10 }],
      [path.join(dir, "a\0b.jsonl"), "unreadable", {}]
    ];
    for (const [input, reason, options] of cases) {
      const time = fakeTime();
      const result = await waitForTranscriptUsage(input, { maxWaitMs: 1500, now: time.now, sleep: time.sleep, ...options });
      assert.deepEqual([result.reason, result.wait_ms], [reason, 0], reason);
    }
    const late = path.join(dir, "late.jsonl");
    const time = fakeTime([{ at: 200, run: () => fs.writeFileSync(late, `${PROMPT}\n${assistant("msg_1", HAIKU, usage(1, 10, 0, 0))}\n`) }]);
    const result = await waitForTranscriptUsage(late, { maxWaitMs: 1500, pollMs: 25, now: time.now, sleep: time.sleep });
    assert.deepEqual([result.status, result.complete, result.wait_ms], ["read", true, 200]);
  }));

test("the wait time comes from ORCH_USAGE_WAIT_MS and stays between 0 and 3 seconds", () => {
  const cases = [
    [undefined, 1500],
    ["", 1500],
    ["  ", 1500],
    ["0", 0],
    ["200", 200],
    ["-5", 0],
    ["60000", 3000],
    ["soon", 1500]
  ];
  for (const [value, expected] of cases) {
    assert.equal(usageWaitMs(value === undefined ? {} : { ORCH_USAGE_WAIT_MS: value }), expected, JSON.stringify(value));
  }
});

test("the stop hook's time budget keeps the wait and the Jev call inside 4 seconds from its start", () => {
  // The wait keeps 1.1 seconds free for a Jev call.
  assert.equal(usageWaitBudget(0, 1500), 1500);
  assert.equal(usageWaitBudget(2000, 1500), 900);
  assert.equal(usageWaitBudget(3500, 1500), 0);
  // The Jev call gets what is left, at most 3 seconds, at least 1.
  assert.equal(verificationBudget(0, 8000), 3000);
  assert.equal(verificationBudget(2500, 8000), 1500);
  assert.equal(verificationBudget(3500, 8000), 1000);
  assert.equal(verificationBudget(0, 2000), 2000);
  // The elapsed time has fractions; the budgets are whole milliseconds, because
  // AbortSignal.timeout refuses a fraction.
  assert.equal(verificationBudget(1543.27, 8000), 2456);
  assert.equal(usageWaitBudget(12.6, 1500), 1500);
  assert.equal(usageWaitBudget(2000.4, 1500), 899);
  assert.doesNotThrow(() => AbortSignal.timeout(verificationBudget(1543.27, 8000)));
});

// ---- the log hook ----

test("the log hook writes the usage record after the stop record", async () => {
  const tempDir = makeTempDir();
  try {
    const transcript = writeTranscript(tempDir, [PROMPT, assistant("msg_1", HAIKU, usage(3, 40, 500, 600))]);
    const env = cleanEnv(tempDir, { ORCH_USAGE_WAIT_MS: "200" });
    const stop = { hook_event_name: "SubagentStop", session_id: "s", cwd: "/work/project", agent_id: "a1", agent_type: "workflow-subagent", agent_transcript_path: transcript, last_assistant_message: "ok" };
    for (const event of [stop, { ...stop, agent_id: "a2", agent_transcript_path: path.join(tempDir, "gone.jsonl") }]) {
      const result = await runNode("scripts/log-hook.mjs", { stdin: JSON.stringify(event), env });
      assert.deepEqual([result.code, result.stdout, result.stderr], [0, "", ""]);
    }
    const records = readLog(tempDir);
    assert.deepEqual(records.map((record) => [record.event, record.agent_id]), [["stop", "a1"], ["usage", "a1"], ["stop", "a2"], ["usage", "a2"]]);
    const [, read, , missing] = records;
    assert.deepEqual(
      { event: read.event, agent_type: read.agent_type, source: read.source, cumulative: read.cumulative, status: read.status, complete: read.complete, models: read.models, session_id: read.session_id, cwd: read.cwd },
      {
        event: "usage",
        agent_type: "workflow-subagent",
        source: "transcript",
        cumulative: true,
        status: "read",
        complete: true,
        models: { [HAIKU]: totals(1, 3, 40, 500, 600) },
        session_id: "s",
        cwd: "/work/project"
      }
    );
    // A file that never appears is waited for, then reported; observed_at is
    // the time of the read, after the wait.
    assert.deepEqual([missing.status, missing.reason, missing.complete, missing.models], ["unread", "missing", false, {}]);
    assert.ok(missing.wait_ms >= 200, `waited ${missing.wait_ms} ms`);
    assert.ok(Date.parse(missing.observed_at) - Date.parse(missing.ts) >= 200, "observed_at comes after the wait");
    assert.ok(!JSON.stringify(records).includes(transcript), "the log holds no transcript path");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the log hook waits for a final reply that Claude Code writes after the stop", async () =>
  withDirAsync(async (dir) => {
    const transcript = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(1, 10, 0, 0)), TOOL_RESULT]);
    const logFile = path.join(dir, "data", "dispatch-log.jsonl");
    // A separate process appends the final reply 100 ms after the hook has
    // written its stop record, as Claude Code does after it has started the
    // SubagentStop hooks. Tied to the stop record, not to a fixed delay.
    const finalLine = `${assistant("msg_2", HAIKU, usage(1, 20, 0, 0))}\n`;
    const writerCode = `
      const fs = require("fs");
      const started = Date.now();
      const look = () => {
        let log = "";
        try { log = fs.readFileSync(${JSON.stringify(logFile)}, "utf8"); } catch {}
        if (log.includes('"event":"stop"')) return setTimeout(() => fs.appendFileSync(${JSON.stringify(transcript)}, ${JSON.stringify(finalLine)}), 100);
        if (Date.now() - started < 10000) setTimeout(look, 10);
      };
      look();`;
    const writer = spawn(process.execPath, ["-e", writerCode], { stdio: "ignore" });
    const env = cleanEnv(dir, { ORCH_USAGE_WAIT_MS: "2500" });
    const stop = { hook_event_name: "SubagentStop", session_id: "s", agent_id: "a1", agent_type: "Explore", agent_transcript_path: transcript, last_assistant_message: "ok" };
    const result = await runNode("scripts/log-hook.mjs", { stdin: JSON.stringify(stop), env });
    await new Promise((resolve) => (writer.exitCode !== null ? resolve() : writer.on("exit", resolve)));
    assert.equal(result.code, 0);
    const record = readLog(dir).find((r) => r.event === "usage");
    assert.deepEqual([record.status, record.complete, record.models[HAIKU].messages, record.models[HAIKU].output], ["read", true, 2, 30]);
    assert.ok(record.wait_ms > 0, `the hook waited for the final reply (${record.wait_ms} ms)`);
  }));

test("the wait shortens the Jev call, so the hook stays inside its 5 seconds", async () =>
  withDirAsync(async (dir) => {
    // Jev answers after 2.7 seconds. After a 1.5-second wait the call gets about
    // 2.5 seconds, so it times out; a call with a fixed 3 seconds would succeed.
    const jev = await startFakeJev({ body: { model: "jev-test", answers: { outcome: { type: "choice", choice: "passed", probabilities: { passed: 1 }, confidence: 0.9 } } }, delayMs: 2700 });
    try {
      const transcript = writeTranscript(dir, [PROMPT, toolCall("msg_1", HAIKU, usage(1, 10, 0, 0))]);
      const env = cleanEnv(dir, { ORCH_TYPESAFE_URL: jev.url, TYPESAFE_API_KEY: "test-key-not-a-secret", ORCH_JEV_TIMEOUT_MS: "8000", ORCH_USAGE_WAIT_MS: "1500" });
      const stop = {
        hook_event_name: "SubagentStop",
        session_id: "s",
        agent_id: "a1",
        agent_type: "subagent-router:implementer",
        agent_transcript_path: transcript,
        last_assistant_message: "Changed files: a.js\nVerification: npm test: 3 pass, 0 fail\nOpen problems: none"
      };
      const started = Date.now();
      const result = await runNode("scripts/log-hook.mjs", { stdin: JSON.stringify(stop), env });
      const took = Date.now() - started;
      assert.equal(result.code, 0);
      const records = readLog(dir);
      const usageRecord = records.find((r) => r.event === "usage");
      const verification = records.find((r) => r.event === "verification");
      assert.deepEqual([usageRecord.reason, usageRecord.wait_ms >= 1500], ["no_end", true]);
      assert.equal(verification.error, "timeout", "the Jev call got only what was left");
      // About 4,000 - 1,550 ms: more than the 1-second minimum, less than 3 seconds.
      const budget = Number(/(\d+) ms$/.exec(verification.detail ?? "")?.[1]);
      assert.ok(budget > 2000 && budget < 2600, `the Jev call got ${verification.detail}`);
      assert.ok(took < 5000, `the hook took ${took} ms`);
    } finally {
      await jev.close();
    }
  }));

test("an error that the reader did not turn into a status is logged by its kind, never its message", () => {
  const cases = [
    [Object.assign(new Error("/home/someone/secret/agent-a1.jsonl"), { code: "EACCES" }), "EACCES"],
    [new TypeError("cannot read /home/someone/secret"), "TypeError"],
    [Object.assign(new Error("x"), { code: "not a code /tmp/x" }), "Error"],
    [{ name: "has a /path in it" }, "unknown"],
    [null, "unknown"]
  ];
  for (const [error, kind] of cases) {
    const record = usageErrorRecord(error, 12.7);
    assert.deepEqual(record, { status: "unread", reason: "error", error: kind, models: {}, complete: false, wait_ms: 13 });
    assert.ok(!JSON.stringify(record).includes("secret"), "no message reaches the record");
  }
});

test("the log hook's timeout in hooks.json leaves room for its 4-second budget", () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, "hooks", "hooks.json"), "utf8"));
  const stop = hooks.hooks.SubagentStop.flatMap((group) => group.hooks).find((hook) => (hook.args ?? []).some((arg) => arg.endsWith("log-hook.mjs")));
  assert.ok(stop, "the log hook runs on SubagentStop");
  // The deadline, the 1-second Jev minimum after a slow lock release, and the start of Node.
  assert.ok(stop.timeout * 1000 >= HOOK_DEADLINE_MS + 500, `the log hook's timeout (${stop.timeout} s) must leave room for ${HOOK_DEADLINE_MS} ms`);
});
