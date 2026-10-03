import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  CLAIM_STALE_MS,
  KEEP_MS,
  abandonedKeys,
  claim,
  cleanup,
  deleteCapture,
  isDone,
  loadDoneResults,
  readCapture,
  release,
  stateKey,
  triageDir,
  writeCapture,
  writeDone,
  writeStop
} from "../scripts/lib/triage-state.mjs";
import { ROOT, makeTempDir } from "./helpers.mjs";

function envFor(t) {
  const dir = makeTempDir("orch-triage-state-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { ORCH_DATA_DIR: path.join(dir, "data"), PATH: process.env.PATH };
}

function age(file, ms) {
  const seconds = (Date.now() - ms) / 1000;
  fs.utimesSync(file, seconds, seconds);
}

test("stateKey joins session and agent and replaces unsafe characters", () => {
  assert.equal(stateKey("s1", "a1"), "s1__a1");
  assert.equal(stateKey("s/1", "a..1"), "s_1__a__1");
});

test("the first accepted capture wins, with private permissions", (t) => {
  const env = envFor(t);
  assert.equal(writeCapture("k", "first report", env), true);
  assert.equal(writeCapture("k", "second report", env), false);
  assert.equal(readCapture("k", env), "first report");
  const file = path.join(triageDir(env), "pending", "k.handback.json");
  assert.equal(fs.statSync(file).mode & 0o077, 0);
  deleteCapture("k", env);
  assert.equal(readCapture("k", env), null);
});

test("a claim is taken once, then busy, then taken over when stale", (t) => {
  const env = envFor(t);
  const first = claim("k", { env });
  assert.deepEqual({ ...first, token: undefined }, { claimed: true, attempts: 1, token: undefined });
  assert.match(first.token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(claim("k", { env }), { claimed: false, reason: "busy" });
  age(path.join(triageDir(env), "claimed", "k"), CLAIM_STALE_MS + 60000);
  const second = claim("k", { env });
  assert.deepEqual({ ...second, token: undefined }, { claimed: true, attempts: 2, token: undefined });
  // The takeover gives the claim a new owner.
  assert.notEqual(second.token, first.token);
  // The takeover makes the claim fresh again.
  assert.deepEqual(claim("k", { env }), { claimed: false, reason: "busy" });
});

test("a key with a done file is never claimed", (t) => {
  const env = envFor(t);
  writeDone("k", { report_id: "r1" }, env);
  assert.equal(isDone("k", env), true);
  assert.deepEqual(claim("k", { env }), { claimed: false, reason: "done" });
});

test("after three attempts the key is abandoned", (t) => {
  const env = envFor(t);
  const file = path.join(triageDir(env), "claimed", "k");
  claim("k", { env });
  for (const expected of [2, 3]) {
    age(file, CLAIM_STALE_MS + 60000);
    assert.equal(claim("k", { env }).attempts, expected);
  }
  age(file, CLAIM_STALE_MS + 60000);
  assert.deepEqual(claim("k", { env }), { claimed: false, reason: "abandoned", attempts: 3 });
});

test("two takeovers at the same moment: exactly one wins", async (t) => {
  const env = envFor(t);
  claim("k", { env });
  age(path.join(triageDir(env), "claimed", "k"), CLAIM_STALE_MS + 60000);
  const module = JSON.stringify(path.join(ROOT, "scripts", "lib", "triage-state.mjs"));
  const script = `import { claim } from ${module}; process.stdout.write(JSON.stringify(claim("k")));`;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, ...env } });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(JSON.parse(out)));
    });
  // Repeat, so a lucky schedule cannot hide a race.
  for (let round = 0; round < 5; round += 1) {
    const results = await Promise.all([run(), run(), run()]);
    assert.equal(results.filter((r) => r.claimed).length, 1, JSON.stringify(results));
    age(path.join(triageDir(env), "claimed", "k"), CLAIM_STALE_MS + 60000);
    fs.writeFileSync(path.join(triageDir(env), "claimed", "k"), JSON.stringify({ attempts: 1 }));
    age(path.join(triageDir(env), "claimed", "k"), CLAIM_STALE_MS + 60000);
  }
});

test("abandoned keys: a saved stop, no done file and a missing or stale claim; at most two, oldest first", (t) => {
  const env = envFor(t);
  for (const key of ["a", "b", "c", "d"]) writeStop(key, { agent_id: key }, env);
  const pending = path.join(triageDir(env), "pending");
  age(path.join(pending, "a.stop.json"), 40000);
  age(path.join(pending, "b.stop.json"), 30000);
  age(path.join(pending, "c.stop.json"), 20000);
  claim("c", { env }); // fresh claim: not abandoned
  writeDone("d", { report_id: "rd" }, env); // done: not abandoned
  assert.deepEqual(abandonedKeys({ env }), ["a", "b"]);
  release("a", env);
  assert.deepEqual(abandonedKeys({ env }), ["b"]);
});

test("loadDoneResults keeps one result per report and skips a bad file", (t) => {
  const env = envFor(t);
  writeDone("k1", { report_id: "r1", n: 1 }, env);
  writeDone("k2", { report_id: "r1", n: 2 }, env);
  writeDone("k3", { report_id: "r2", n: 3 }, env);
  fs.writeFileSync(path.join(triageDir(env), "done", "bad.json"), "{");
  const results = loadDoneResults(env);
  assert.deepEqual(results.map((r) => r.report_id).sort(), ["r1", "r2"]);
});

test("cleanup deletes old files and keeps done files the caller wants", (t) => {
  const env = envFor(t);
  writeDone("keep", { report_id: "r1", group: "eval" }, env);
  writeDone("drop", { report_id: "r2", group: "tune" }, env);
  writeStop("old", {}, env);
  writeStop("new", {}, env);
  const dir = triageDir(env);
  for (const file of [path.join(dir, "done", "keep.json"), path.join(dir, "done", "drop.json"), path.join(dir, "pending", "old.stop.json")]) {
    age(file, KEEP_MS + 60000);
  }
  cleanup({ env, keepDone: (_key, result) => result.group === "eval" });
  assert.equal(fs.existsSync(path.join(dir, "done", "keep.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "done", "drop.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "pending", "old.stop.json")), false);
  assert.equal(fs.existsSync(path.join(dir, "pending", "new.stop.json")), true);
});

test("a folder that cannot be made throws, for the hook to report", (t) => {
  const env = envFor(t);
  fs.mkdirSync(env.ORCH_DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.ORCH_DATA_DIR, "triage"), "a file where the folder should be");
  assert.throws(() => writeStop("k", {}, env));
});
