// Direct tests of findCodexResult: a reason that can still change keeps the
// wait going, and a final reason ends it at once.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { findCodexResult } from "../scripts/lib/codex-result.mjs";
import { makeTempDir } from "./helpers.mjs";

const WAIT_MS = 1500;

function setUp(t) {
  const tempDir = makeTempDir("orch-codex-result-");
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, ORCH_DATA_DIR: dataDir };
  const log = (record) => fs.appendFileSync(path.join(dataDir, "dispatch-log.jsonl"), `${JSON.stringify(record)}\n`);
  return { dataDir, env, log };
}

test("a launched record that is written after the call starts is found, because the wait goes on", async (t) => {
  const { dataDir, env, log } = setUp(t);
  const jobId = "20261003-140000-abcdef";
  const report = "- [P1] guard missing in src/a.mjs:10\n";
  // Everything but the launched record is there before the call.
  log({ event: "dispatch", tool_use_id: "tu-1", codex_request: "req-abc123def456" });
  fs.mkdirSync(path.join(dataDir, "codex-requests"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "codex-requests", "req-abc123def456.job"), jobId);
  const jobDir = path.join(dataDir, "codex-jobs", jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "result.md"), report);
  fs.writeFileSync(path.join(jobDir, "exit-code"), "0");
  // A foreground subagent: its launched record comes after SubagentStop.
  const late = setTimeout(() => log({ event: "launched", tool_use_id: "tu-1", agent_id: "agent-1" }), 400);
  t.after(() => clearTimeout(late));

  const started = Date.now();
  const found = await findCodexResult("agent-1", { waitMs: WAIT_MS, env });
  const elapsed = Date.now() - started;
  assert.deepEqual(found, { text: report, jobId, exitCode: 0 });
  assert.ok(elapsed >= 350, `the launched record came after about 400 ms, so the wait was used (${elapsed} ms)`);
});

test("a dispatch record without a request id ends the wait at once with no_request", async (t) => {
  const { env, log } = setUp(t);
  log({ event: "dispatch", tool_use_id: "tu-2" });
  log({ event: "launched", tool_use_id: "tu-2", agent_id: "agent-2" });

  const started = Date.now();
  const found = await findCodexResult("agent-2", { waitMs: WAIT_MS, env });
  const elapsed = Date.now() - started;
  assert.deepEqual(found, { reason: "no_request" });
  assert.ok(elapsed < WAIT_MS / 3, `a final reason does not wait for the deadline (${elapsed} ms of ${WAIT_MS})`);
});
