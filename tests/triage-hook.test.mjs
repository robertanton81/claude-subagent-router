import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readCheckedExcerpt, readExcerpt, repoState } from "../scripts/lib/evidence.mjs";
import { prepareFinding } from "../scripts/lib/triage-core.mjs";
import { loadDoneResults, stateKey, triageDir, writeDone } from "../scripts/lib/triage-state.mjs";
import { cleanEnv, makeTempDir, readLog, runNode, startFakeJev } from "./helpers.mjs";

const REVIEW_BOT = "acme:review-bot";
const CODEX_REVIEWER = "subagent-router:codex-reviewer";

// Key lines are built at run time, so this file holds no literal key line.
// The body lines are repeated letters, not a key.
const DASHES = "-".repeat(5);
const keyLine = (edge, label) => `${DASHES}${edge} ${label}${DASHES}`;
const keyBlock = (label, body) => [keyLine("BEGIN", label), ...Array.from({ length: body }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(64)), keyLine("END", label)];
const codeLines = (count, from = 1) => Array.from({ length: count }, (_, i) => `code ${from + i}`);

function git(args, cwd) {
  execFileSync("git", args, { cwd, env: process.env, stdio: "pipe", timeout: 10000 });
}

function jevAnswer(choices, model = "jev-test") {
  const answers = {};
  choices.forEach((choice, n) => (answers[`finding_${n}`] = { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } }));
  return { body: { model, answers, usage: { input_tokens: 900, output_tokens: 20 } } };
}

async function setUp(t, { config = {}, reply = jevAnswer(["contradicts"]), env = {} } = {}) {
  const tempDir = fs.realpathSync(makeTempDir("orch-triage-hook-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const repo = path.join(tempDir, "repo");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "a.mjs"), Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
  git(["init", "-q"], repo);
  git(["add", "-A"], repo);
  git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "x"], repo);
  const fake = await startFakeJev(reply);
  t.after(fake.close);
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({
      jevModel: "jev-test",
      triageMode: "log",
      triageProjects: [repo],
      reviewFormats: [{ agentTypes: [REVIEW_BOT], labels: ["MUST-FIX", "NICE-TO-HAVE"] }],
      ...config
    })
  );
  const hookEnv = cleanEnv(tempDir, {
    ORCH_TYPESAFE_URL: fake.url,
    TYPESAFE_API_KEY: "test-key-not-a-secret",
    ORCH_TRIAGE_HANDBACK_WAIT_MS: "3000",
    ORCH_TRIAGE_LINK_WAIT_MS: "500",
    // No detached job worker may outlive a test; one test turns this off.
    ORCH_TRIAGE_NO_WORKER: "1",
    ...env
  });
  return { tempDir, repo, fake, env: hookEnv, dataDir };
}

const stopInput = (s, extra = {}) => JSON.stringify({ session_id: "s1", hook_event_name: "SubagentStop", agent_id: "a1", agent_type: REVIEW_BOT, cwd: s.repo, permission_mode: "default", last_assistant_message: "MUST-FIX: guard missing in src/a.mjs:10", ...extra });
const captureInput = (s, message, extra = {}) =>
  JSON.stringify({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "SubagentHandback", agent_id: "a1", agent_type: REVIEW_BOT, cwd: s.repo, tool_input: { message }, tool_response: { success: true }, ...extra });

const triage = (s, input) => runNode("scripts/triage-hook.mjs", { stdin: input, env: s.env, cwd: s.repo });
const capture = (s, input) => runNode("scripts/triage-capture.mjs", { stdin: input, env: s.env, cwd: s.repo });
const triageRecords = (s) => readLog(s.tempDir).filter((r) => r.event === "triage");
const captureFile = (s) => path.join(triageDir(s.env), "pending", `${stateKey("s1", "a1")}.handback.json`);

test("capture: an accepted hand-back is kept, a refused one is not, the first one wins", async (t) => {
  const s = await setUp(t);
  const refused = await capture(s, captureInput(s, "refused", { tool_response: { success: false } }));
  assert.equal(refused.stdout, "");
  assert.equal(fs.existsSync(captureFile(s)), false);
  assert.equal((await capture(s, captureInput(s, "first report"))).stdout, "");
  await capture(s, captureInput(s, "second report"));
  assert.equal(JSON.parse(fs.readFileSync(captureFile(s), "utf8")).message, "first report");
});

test("order A: the captured hand-back is the report, not the closing text", async (t) => {
  const s = await setUp(t);
  await capture(s, captureInput(s, "MUST-FIX: real report cites src/a.mjs:10"));
  const result = await triage(s, stopInput(s, { last_assistant_message: "Report delivered to caller." }));
  assert.equal(result.stdout, "");
  const [record] = triageRecords(s);
  assert.equal(record.source, "handback");
  assert.match(record.findings[0].text, /real report/);
});

test("order B: in auto mode the hook waits for a late capture", async (t) => {
  const s = await setUp(t);
  const pending = triage(s, stopInput(s, { permission_mode: "auto", last_assistant_message: "closing text only" }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await capture(s, captureInput(s, "MUST-FIX: late report src/a.mjs:10"));
  await pending;
  const [record] = triageRecords(s);
  // Without the wait the hook would have used the closing text at once. The
  // wait is measured from the moment the hook starts waiting, after Node has
  // started, so only its range is fixed: above zero, below the 3-second limit.
  assert.equal(record.source, "handback");
  assert.equal(record.handback_missing, false);
  assert.ok(record.handback_wait_ms > 0 && record.handback_wait_ms < 3000, String(record.handback_wait_ms));
});

test("no hand-back: default mode uses the last message at once; auto mode flags the miss", async (t) => {
  const s = await setUp(t, { env: { ORCH_TRIAGE_HANDBACK_WAIT_MS: "300" } });
  await triage(s, stopInput(s));
  let [record] = triageRecords(s);
  assert.equal(record.source, "final_message");
  assert.equal(record.handback_missing, false);
  await triage(s, stopInput(s, { agent_id: "a2", permission_mode: "auto" }));
  record = triageRecords(s).find((r) => r.agent_id === "a2");
  assert.equal(record.source, "final_message");
  assert.equal(record.handback_missing, true);
});

test("Jev's answer lands in the done file and the log, with the version and the change group", async (t) => {
  const s = await setUp(t);
  await triage(s, stopInput(s, { last_assistant_message: "MUST-FIX: guard missing in src/a.mjs:10\n\nNICE-TO-HAVE: rename things" }));
  const [record] = triageRecords(s);
  assert.equal(record.findings[0].outcome, "contradicts");
  assert.equal(record.findings[0].confidence, 0.9);
  assert.deepEqual(record.findings[0].citation, { path: "src/a.mjs", start: 10, end: 10 });
  assert.equal(record.findings[1].outcome, "no_citation");
  assert.match(record.repo.head, /^[0-9a-f]{40}$/);
  assert.equal(record.group_eligible, true);
  assert.equal(record.eval_version.model, "jev-test");
  assert.equal(record.jev.model, "jev-test");
  // The finding without a citation was never sent.
  assert.equal(s.fake.state.requests.length, 1);
  assert.deepEqual(Object.keys(s.fake.state.requests[0].body.questions), ["finding_0"]);
  const [done] = loadDoneResults(s.env);
  assert.equal(done.report_id, record.report_id);
  assert.match(done.snapshot, /NICE-TO-HAVE/);
});

test("a finding is never dropped or changed: every parsed item is in the result with its label", async (t) => {
  const s = await setUp(t, { reply: jevAnswer(["supports", "contradicts"]) });
  const report = "MUST-FIX: one src/a.mjs:3\nMUST-FIX: two src/a.mjs:4\nNICE-TO-HAVE: three";
  await triage(s, stopInput(s, { last_assistant_message: report }));
  const [record] = triageRecords(s);
  assert.deepEqual(
    record.findings.map((f) => [f.label, f.text]),
    [["MUST-FIX", "MUST-FIX: one src/a.mjs:3"], ["MUST-FIX", "MUST-FIX: two src/a.mjs:4"], ["NICE-TO-HAVE", "NICE-TO-HAVE: three"]]
  );
});

test("secrets are masked before sending, and a private key holds the finding back", async (t) => {
  const s = await setUp(t);
  const report = `MUST-FIX: password = hunter2 is logged at src/a.mjs:5\n\nMUST-FIX: key src/a.mjs:6\n${keyLine("BEGIN", "RSA PRIVATE KEY")}`;
  await triage(s, stopInput(s, { last_assistant_message: report }));
  const sent = s.fake.state.requests[0].body.state.findings;
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /password = <redacted>/);
  assert.doesNotMatch(JSON.stringify(s.fake.state.requests[0].body), /hunter2|PRIVATE KEY/);
  const [record] = triageRecords(s);
  assert.ok(record.redactions >= 1);
  assert.equal(record.findings[1].outcome, "withheld_secret");
});

test("a private key anywhere in a cited file holds the whole finding back, and nothing is sent", async (t) => {
  const s = await setUp(t);
  // Lines 1-10 code, 11 BEGIN, 12-36 key body, 37 END, 38-80 code. The files
  // are new and not ignored, so the hook reads them.
  fs.writeFileSync(path.join(s.repo, "src", "conf.mjs"), [...codeLines(10), ...keyBlock("RSA PRIVATE KEY", 25), ...codeLines(43, 38)].join("\n"));
  fs.writeFileSync(path.join(s.repo, "src", "pgp.mjs"), [...codeLines(5), ...keyBlock("PGP PRIVATE KEY BLOCK", 25), ...codeLines(40, 33)].join("\n"));
  fs.writeFileSync(path.join(s.repo, "src", "half.mjs"), [...codeLines(5), keyLine("BEGIN", "PRIVATE KEY"), ...codeLines(60, 7)].join("\n"));
  const report = [
    "MUST-FIX: a body line src/conf.mjs:34",
    "MUST-FIX: the first line after the end src/conf.mjs:38",
    "MUST-FIX: the key file first src/conf.mjs:34, a clean file second src/a.mjs:5",
    "MUST-FIX: a clean file first src/a.mjs:5, the key file second src/conf.mjs:34",
    "MUST-FIX: a PGP key file src/pgp.mjs:60",
    "MUST-FIX: a first key line without an end src/half.mjs:50",
    `MUST-FIX: the report quotes only the last key line ${keyLine("END", "RSA PRIVATE KEY")} near src/a.mjs:5`
  ].join("\n\n");
  await triage(s, stopInput(s, { last_assistant_message: report }));
  const [record] = triageRecords(s);
  assert.deepEqual(
    record.findings.map((f) => f.outcome),
    Array.from({ length: 7 }, () => "withheld_secret")
  );
  assert.equal(s.fake.state.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE KEY|([A-Z])\1{63}/);
  // Positive control: a finding on the clean file alone is sent.
  await triage(s, stopInput(s, { agent_id: "a2", last_assistant_message: "MUST-FIX: a clean file src/a.mjs:5" }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("a finding that cites a credential-named file is held back whole, in either order, and nothing is sent", async (t) => {
  const s = await setUp(t);
  // A new file that git does not ignore; its content is no key at all.
  fs.writeFileSync(path.join(s.repo, "src", "deploy.pem"), "not a key\n".repeat(5));
  const report = ["MUST-FIX: the key file first src/deploy.pem:1, a clean file second src/a.mjs:5", "MUST-FIX: a clean file first src/a.mjs:5, the key file second src/deploy.pem:1"].join("\n\n");
  await triage(s, stopInput(s, { last_assistant_message: report }));
  const [record] = triageRecords(s);
  assert.deepEqual(record.findings.map((f) => f.outcome), ["withheld_secret", "withheld_secret"]);
  assert.deepEqual(record.findings.map((f) => f.citation), [{ path: "src/deploy.pem", start: 1, end: 1 }, { path: "src/deploy.pem", start: 1, end: 1 }]);
  assert.equal(s.fake.state.requests.length, 0);
  // Positive control: a finding on the clean file alone is sent.
  await triage(s, stopInput(s, { agent_id: "a2", last_assistant_message: "MUST-FIX: a clean file src/a.mjs:5" }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("a citation right after a secret word is still found, and the text that is sent stays masked", async (t) => {
  const s = await setUp(t);
  await triage(s, stopInput(s, { last_assistant_message: "MUST-FIX: Leaked api token: src/a.mjs:10" }));
  const [record] = triageRecords(s);
  assert.equal(record.findings[0].outcome, "contradicts");
  assert.deepEqual(record.findings[0].citation, { path: "src/a.mjs", start: 10, end: 10 });
  const [sent] = s.fake.state.requests[0].body.state.findings;
  assert.equal(sent.text, "MUST-FIX: Leaked api token: <redacted>");
  assert.match(sent.excerpt, /^10: line 10$/m);
});

test("prepareFinding: withheld_secret from any citation holds the whole finding back at once", async (t) => {
  const s = await setUp(t);
  fs.writeFileSync(path.join(s.repo, "src", "b.mjs"), "x\ny\nz");
  const repo = { root: fs.realpathSync(s.repo) };
  const item = (text) => ({ index: 0, label: "MUST-FIX", text });
  // A stand-in reader: src/b.mjs holds a key, src/a.mjs is clean.
  const reader = () => {
    const calls = [];
    const answers = { "src/a.mjs": { excerpt: "1: clean" }, "src/b.mjs": { outcome: "withheld_secret" } };
    return { calls, read: (citation) => (calls.push(citation.path), answers[citation.path]) };
  };
  for (const text of ["MUST-FIX: src/b.mjs:1 then src/a.mjs:1", "MUST-FIX: src/a.mjs:1 then src/b.mjs:1"]) {
    const { finding } = prepareFinding(item(text), repo, [], reader().read);
    assert.equal(finding.outcome, "withheld_secret", text);
    assert.equal(finding.excerpt, null, text);
    assert.deepEqual(finding.citation, { path: "src/b.mjs", start: 1, end: 1 }, text);
  }
  // At once: after the key file no other citation is read.
  const first = reader();
  prepareFinding(item("MUST-FIX: src/b.mjs:1 then src/a.mjs:1"), repo, [], first.read);
  assert.deepEqual(first.calls, ["src/b.mjs"]);
  // Positive control: without the key file the clean citation is used.
  const { finding } = prepareFinding(item("MUST-FIX: src/a.mjs:1"), repo, [], reader().read);
  assert.deepEqual([finding.outcome, finding.excerpt], [null, "1: clean"]);
});

test("prepareFinding: a citation of a credential-named file holds the whole finding back before any read, in either order", async (t) => {
  const s = await setUp(t);
  fs.writeFileSync(path.join(s.repo, "src", "deploy.pem"), "not a key\n".repeat(5));
  const repo = { root: fs.realpathSync(s.repo) };
  const item = (text) => ({ index: 0, label: "MUST-FIX", text });
  for (const text of ["MUST-FIX: src/deploy.pem:1 then src/a.mjs:1", "MUST-FIX: src/a.mjs:1 then src/deploy.pem:1"]) {
    const calls = [];
    const { finding } = prepareFinding(item(text), repo, [], (citation) => (calls.push(citation.path), { excerpt: "1: clean" }));
    assert.equal(finding.outcome, "withheld_secret", text);
    assert.equal(finding.excerpt, null, text);
    assert.deepEqual(finding.citation, { path: "src/deploy.pem", start: 1, end: 1 }, text);
    assert.deepEqual(calls, [], `${text}: nothing was read`);
  }
});

test("prepareFinding: a secret value on the line after its name never leaves in an excerpt, on both read paths", async (t) => {
  const s = await setUp(t);
  const value = "Q".repeat(24);
  // Line 1 a comment, line 2 the name, line 3 the value, lines 4-60 code.
  fs.writeFileSync(path.join(s.repo, "src", "conf.mjs"), ["// settings", "const apiKey =", `  "${value}";`, ...codeLines(57, 4)].join("\n"));
  git(["add", "-A"], s.repo);
  git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "conf"], s.repo);
  const repo = repoState(s.repo);
  const readers = {
    "working tree": (citation) => readExcerpt(repo.root, citation),
    blob: (citation) => readCheckedExcerpt(repo.root, citation, { mode: "blob", commit: repo.head })
  };
  // The value line, the name line, and line 23, whose window starts on the value line.
  for (const [line, first] of [[3, 1], [2, 1], [23, 3]]) {
    for (const [name, read] of Object.entries(readers)) {
      const prepared = prepareFinding({ index: 0, label: "MUST-FIX", text: `MUST-FIX: leak in src/conf.mjs:${line}` }, repo, [], read);
      const label = `line ${line}, ${name}`;
      assert.equal(prepared.finding.outcome, null, label);
      assert.equal(prepared.finding.excerpt.includes(value), false, label);
      prepared.finding.excerpt.split("\n").forEach((text, i) => assert.ok(text.startsWith(`${first + i}: `), `${label}: ${text}`));
      // The reader's count is kept, and the second pass counts nothing again.
      assert.equal(prepared.redactions, 1, label);
    }
  }
});

test("a git-ignored file is never sent; a tracked file and a new file that git does not ignore are", async (t) => {
  const s = await setUp(t, { reply: jevAnswer(["supports", "supports"]) });
  fs.writeFileSync(path.join(s.repo, ".gitignore"), "local/\n");
  fs.mkdirSync(path.join(s.repo, "local"));
  fs.writeFileSync(path.join(s.repo, "local", "settings.mjs"), "IGNORED CONTENT\n".repeat(10));
  fs.writeFileSync(path.join(s.repo, "src", "new.mjs"), "new content\n".repeat(10));
  await triage(s, stopInput(s, { last_assistant_message: "MUST-FIX: ignored local/settings.mjs:3\n\nMUST-FIX: tracked src/a.mjs:3\n\nMUST-FIX: new src/new.mjs:3" }));
  const [record] = triageRecords(s);
  assert.deepEqual(record.findings.map((f) => f.outcome), ["no_citation", "supports", "supports"]);
  const body = s.fake.state.requests[0].body;
  assert.deepEqual(body.state.findings.map((f) => f.path), ["src/a.mjs", "src/new.mjs"]);
  assert.doesNotMatch(JSON.stringify(body), /IGNORED CONTENT/);
});

// The first git on PATH, so a stand-in can hand every other command to it.
function realGit() {
  for (const dir of String(process.env.PATH).split(path.delimiter)) {
    const file = path.join(dir, "git");
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not in this folder.
    }
  }
  throw new Error("no git on PATH");
}

test("a failed ignore check sends nothing, and the hook still ends normally", { skip: process.platform === "win32" }, async (t) => {
  const s = await setUp(t);
  // A git stand-in whose "check-ignore" fails; every other command goes to the real git.
  const bin = path.join(s.tempDir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = "check-ignore" ]; then exit 128; fi\nexec '${realGit()}' "$@"\n`, { mode: 0o755 });
  const run = await runNode("scripts/triage-hook.mjs", { stdin: stopInput(s), env: { ...s.env, PATH: `${bin}${path.delimiter}${s.env.PATH}` }, cwd: s.repo });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, "");
  // The failure stays visible: stderr names it and the file that was not read.
  assert.match(run.stderr, /^subagent-router triage: git check-ignore failed \(exit 128\), so src\/a\.mjs was not read$/m);
  assert.equal(s.fake.state.requests.length, 0);
  assert.deepEqual(triageRecords(s)[0].findings.map((f) => f.outcome), ["no_citation"]);
  assert.deepEqual(readLog(s.tempDir).filter((r) => r.event === "hook_error"), []);
  // Positive control: the same stop with the real git is sent.
  await triage(s, stopInput(s, { agent_id: "a2" }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("redaction comes before the cut: a secret across character 1,500 is masked whole", async (t) => {
  const s = await setUp(t);
  const text = `MUST-FIX: ${"x".repeat(1480)} test-key-not-a-secret src/a.mjs:7`;
  await triage(s, stopInput(s, { last_assistant_message: text }));
  const body = JSON.stringify(s.fake.state.requests[0].body);
  assert.doesNotMatch(body, /test-key|not-a-sec/);
});

test("Jev down: every cited finding is an error, the done file exists, exit code 0", async (t) => {
  const s = await setUp(t, { reply: { status: 500, body: "boom" } });
  const result = await triage(s, stopInput(s));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const [record] = triageRecords(s);
  assert.equal(record.findings[0].outcome, "error");
  assert.equal(record.jev.error, "http_500");
  assert.equal(loadDoneResults(s.env).length, 1);
});

test("model mismatch: a pinned model that answers as another model gives errors", async (t) => {
  const s = await setUp(t, { reply: jevAnswer(["supports"], "jev-other") });
  await triage(s, stopInput(s));
  const [record] = triageRecords(s);
  assert.equal(record.findings[0].outcome, "error");
  assert.equal(record.jev.error, "model_mismatch");
});

test("a crash between the done file and the log record: no second Jev call, one result", async (t) => {
  const s = await setUp(t);
  writeDone(stateKey("s1", "a1"), { report_id: "r-crashed", findings: [] }, s.env);
  await triage(s, stopInput(s));
  assert.equal(s.fake.state.requests.length, 0);
  assert.deepEqual(loadDoneResults(s.env).map((r) => r.report_id), ["r-crashed"]);
});

test("abandoned work of another key is redone by the next run", async (t) => {
  const s = await setUp(t);
  const oldKey = stateKey("s0", "a0");
  const pending = path.join(triageDir(s.env), "pending");
  fs.mkdirSync(pending, { recursive: true });
  fs.writeFileSync(path.join(pending, `${oldKey}.stop.json`), stopInput(s, { session_id: "s0", agent_id: "a0" }));
  await triage(s, stopInput(s));
  assert.deepEqual(triageRecords(s).map((r) => r.agent_id).sort(), ["a0", "a1"]);
});

function codexFixture(s, { withJob = true, result = "- [P1] missing check — src/a.mjs:10\n- [P1] wrong order — src/a.mjs:12", exitCode = "0" } = {}) {
  fs.appendFileSync(
    path.join(s.dataDir, "dispatch-log.jsonl"),
    `${JSON.stringify({ event: "dispatch", tool_use_id: "toolu_c", codex_request: "req-abc123" })}\n${JSON.stringify({ event: "launched", tool_use_id: "toolu_c", agent_id: "ac" })}\n`
  );
  const requests = path.join(s.dataDir, "codex-requests");
  fs.mkdirSync(requests, { recursive: true });
  if (withJob) {
    fs.writeFileSync(path.join(requests, "req-abc123.job"), "job-1");
    fs.mkdirSync(path.join(s.dataDir, "codex-jobs", "job-1"), { recursive: true });
    fs.writeFileSync(path.join(s.dataDir, "codex-jobs", "job-1", "result.md"), result);
    if (exitCode !== null) fs.writeFileSync(path.join(s.dataDir, "codex-jobs", "job-1", "exit-code"), exitCode);
  }
}

test("Codex reviewer stop: the count comes from the job's result, and the triage is left to the job worker", async (t) => {
  const s = await setUp(t, { reply: jevAnswer(["supports", "insufficient"]) });
  codexFixture(s);
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER, last_assistant_message: "The review found 2 blocking issues." }));
  const counts = readLog(s.tempDir).find((r) => r.event === "review_findings");
  assert.deepEqual(counts.counts, { P0: 0, P1: 2, P2: 0, P3: 0 });
  assert.equal(counts.source, "codex_result");
  assert.equal(counts.job_id, "job-1");
  assert.deepEqual(triageRecords(s), [], "the stop writes no triage record of its own");
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(fs.existsSync(path.join(triageDir(s.env), "pending", `${stateKey("s1", "ac")}.stop.json`)), false, "no stop input is kept for a Codex reviewer");
});

for (const [name, fixture, reason] of [
  ["no exit-code yet", { exitCode: null }, "not_finished"],
  ["an empty exit-code", { exitCode: "" }, "not_finished"],
  ["a failed job", { exitCode: "1" }, "exit_1"],
  ["an empty result", { result: "" }, "empty_result"],
  ["a result that does not parse", { result: "The review could not be completed." }, "unparsed"]
]) {
  test(`Codex reviewer stop with ${name}: the count is unknown (${reason}), never zero`, async (t) => {
    const s = await setUp(t);
    codexFixture(s, fixture);
    await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
    const counts = readLog(s.tempDir).find((r) => r.event === "review_findings");
    assert.equal(counts.source, "unavailable");
    assert.equal(counts.reason, reason);
    assert.equal(counts.counts, null);
  });
}

// Only a missing launched record and a running job can change after the stop.
// Every other reason is final, so the hook must not poll for the whole wait:
// it runs at each Codex review stop, also while the triage is off.
test("Codex reviewer stop with a final reason ends at once; a running job is still waited for", async (t) => {
  const WAIT_MS = 6000;
  const timed = async (fixture, prepare = () => {}) => {
    const s = await setUp(t, { config: { triageMode: "off" }, env: { ORCH_TRIAGE_LINK_WAIT_MS: String(WAIT_MS) } });
    codexFixture(s, fixture);
    prepare(s);
    const started = Date.now();
    await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
    return { ms: Date.now() - started, reason: readLog(s.tempDir).find((r) => r.event === "review_findings").reason };
  };
  for (const [fixture, prepare, reason] of [
    [{ exitCode: "1" }, undefined, "exit_1"],
    [{ result: "" }, undefined, "empty_result"],
    [{ withJob: false }, undefined, "no_job"],
    [{}, (s) => fs.rmSync(path.join(s.dataDir, "codex-jobs", "job-1", "result.md")), "no_result"]
  ]) {
    const run = await timed(fixture, prepare);
    assert.equal(run.reason, reason);
    assert.ok(run.ms < WAIT_MS / 2, `${reason} took ${run.ms} ms`);
  }
  const running = await timed({ exitCode: null });
  assert.equal(running.reason, "not_finished");
  assert.ok(running.ms >= WAIT_MS, `a running job was given up after ${running.ms} ms`);
});

test("Codex reviewer stop: the count comes from the parsed items, so a marked tag counts, and a clean verdict is a known zero", async (t) => {
  const s = await setUp(t);
  codexFixture(s, { result: "- [**P1**] missing check in src/a.mjs:10\n- [`P2`] wrong order in src/a.mjs:12" });
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  assert.deepEqual(readLog(s.tempDir).find((r) => r.event === "review_findings").counts, { P0: 0, P1: 1, P2: 1, P3: 0 });
  const clean = await setUp(t);
  codexFixture(clean, { result: "No actionable regressions found in commit abc." });
  await triage(clean, stopInput(clean, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  const counts = readLog(clean.tempDir).find((r) => r.event === "review_findings");
  assert.deepEqual([counts.source, counts.counts], ["codex_result", { P0: 0, P1: 0, P2: 0, P3: 0 }]);
});

test("a cited file in a nested repository of a listed checkout is never sent", async (t) => {
  const s = await setUp(t);
  const nested = path.join(s.repo, "vendor", "lib");
  fs.mkdirSync(path.join(nested, "src"), { recursive: true });
  fs.writeFileSync(path.join(nested, "src", "b.mjs"), Array.from({ length: 20 }, (_, i) => `nested ${i + 1}`).join("\n"));
  git(["init", "-q"], nested);
  await triage(s, stopInput(s, { last_assistant_message: "MUST-FIX: guard missing in vendor/lib/src/b.mjs:5" }));
  assert.equal(s.fake.state.requests.length, 0);
  assert.deepEqual(triageRecords(s)[0].findings.map((f) => f.outcome), ["no_citation"]);
  // Positive control: the same finding on a file of the checkout itself is sent.
  await triage(s, stopInput(s, { agent_id: "a2", last_assistant_message: "MUST-FIX: guard missing in src/a.mjs:5" }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("Codex reviewer stop without result.md: the count is unknown (no_result)", async (t) => {
  const s = await setUp(t);
  codexFixture(s);
  fs.rmSync(path.join(s.dataDir, "codex-jobs", "job-1", "result.md"));
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  const counts = readLog(s.tempDir).find((r) => r.event === "review_findings");
  assert.deepEqual([counts.source, counts.reason, counts.counts], ["unavailable", "no_result", null]);
});

test("Codex review without a job file: unavailable with a reason, never zero", async (t) => {
  const s = await setUp(t);
  codexFixture(s, { withJob: false });
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  const counts = readLog(s.tempDir).find((r) => r.event === "review_findings");
  assert.equal(counts.source, "unavailable");
  assert.equal(counts.reason, "no_job");
  assert.equal(counts.counts, null);
});

test("the Codex count runs with the triage off, and sends nothing", async (t) => {
  const s = await setUp(t, { config: { triageMode: "off" } });
  codexFixture(s);
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  assert.equal(readLog(s.tempDir).find((r) => r.event === "review_findings").counts.P1, 2);
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(triageRecords(s).length, 0);
});

for (const [name, config] of [
  ["triageMode off", { triageMode: "off" }],
  ["jevEnabled false", { jevEnabled: false }],
  ["mode off", { mode: "off" }]
]) {
  test(`switched off (${name}): nothing is sent, no record, the capture is deleted`, async (t) => {
    const s = await setUp(t, { config, env: config.jevEnabled === false ? { ORCH_JEV_ENABLED: "" } : {} });
    fs.mkdirSync(path.dirname(captureFile(s)), { recursive: true });
    fs.writeFileSync(captureFile(s), JSON.stringify({ message: "MUST-FIX: x src/a.mjs:1" }));
    await triage(s, stopInput(s));
    assert.equal(s.fake.state.requests.length, 0);
    assert.equal(triageRecords(s).length, 0);
    assert.equal(fs.existsSync(captureFile(s)), false);
  });
}

test("a skipped agent type: its capture is deleted and nothing is written", async (t) => {
  const s = await setUp(t);
  fs.mkdirSync(path.dirname(captureFile(s)), { recursive: true });
  fs.writeFileSync(captureFile(s), JSON.stringify({ message: "some searcher answer" }));
  await triage(s, stopInput(s, { agent_type: "acme:searcher" }));
  assert.equal(fs.existsSync(captureFile(s)), false);
  assert.equal(triageRecords(s).length, 0);
});

for (const [name, projects] of [
  ["empty", []],
  ["another checkout", ["/elsewhere/checkout"]],
  ["a relative entry", ["repo"]]
]) {
  test(`allowlist ${name}: zero requests and no record`, async (t) => {
    const s = await setUp(t, { config: { triageProjects: projects } });
    await triage(s, stopInput(s));
    assert.equal(s.fake.state.requests.length, 0);
    assert.equal(triageRecords(s).length, 0);
  });
}

test("allowlist: consent withdrawn while the hook waits stops the send", async (t) => {
  const s = await setUp(t);
  const pending = triage(s, stopInput(s, { permission_mode: "auto" }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  const file = path.join(s.dataDir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), triageProjects: [] }));
  await capture(s, captureInput(s, "MUST-FIX: x src/a.mjs:1"));
  await pending;
  assert.equal(s.fake.state.requests.length, 0);
  assert.equal(triageRecords(s)[0].jev.error, "consent_withdrawn");
});

test("allowlist: a second worktree of a listed repository stays off until listed", async (t) => {
  const s = await setUp(t);
  const second = path.join(s.tempDir, "second");
  git(["worktree", "add", "-q", "--detach", second], s.repo);
  await triage(s, stopInput(s, { cwd: second }));
  assert.equal(s.fake.state.requests.length, 0);
  // Positive control: the listed checkout itself is sent.
  await triage(s, stopInput(s, { agent_id: "a2" }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("allowlist: with triageWorktrees only a registered worktree of a listed repository is sent", async (t) => {
  const s = await setUp(t, { config: { triageWorktrees: true } });
  // A copy is a second repository with its own git folder; its path starts with the listed one.
  const other = `${s.repo}-copy`;
  fs.cpSync(s.repo, other, { recursive: true });
  const second = path.join(s.tempDir, "second");
  git(["worktree", "add", "-q", "--detach", second], s.repo);
  // A copy of the worktree folder keeps a .git file that names the repository,
  // but git does not list it as a worktree.
  const copied = path.join(s.tempDir, "second-copy");
  fs.cpSync(second, copied, { recursive: true });
  await triage(s, stopInput(s, { cwd: other }));
  await triage(s, stopInput(s, { agent_id: "a3", cwd: copied }));
  assert.equal(s.fake.state.requests.length, 0, "another repository and a copied worktree stay off");
  assert.deepEqual(triageRecords(s), [], "a refusal writes no triage record");
  assert.deepEqual(readLog(s.tempDir).filter((r) => r.event === "hook_error"), [], "a refusal is not a crash");
  // Positive control: the registered worktree is sent.
  await triage(s, stopInput(s, { agent_id: "a2", cwd: second }));
  assert.equal(s.fake.state.requests.length, 1, "a registered worktree of the listed repository is sent");
  const record = triageRecords(s).find((r) => r.agent_id === "a2");
  assert.equal(record.repo.root, fs.realpathSync(second));
  assert.equal(record.repo.common_dir, fs.realpathSync(path.join(s.repo, ".git")));
});

test("allowlist: an inherited GIT_DIR cannot make a folder outside git pass as a listed checkout", async (t) => {
  const s = await setUp(t);
  // A folder outside git, with code, listed by hand in the settings file.
  const plain = path.join(s.tempDir, "plain");
  fs.mkdirSync(path.join(plain, "src"), { recursive: true });
  fs.writeFileSync(path.join(plain, "src", "a.mjs"), Array.from({ length: 40 }, (_, i) => `plain ${i + 1}`).join("\n"));
  const file = path.join(s.dataDir, "config.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), triageProjects: [plain] }));
  const gitDir = path.join(s.repo, ".git");
  // Positive control: git itself honours the variable and calls the folder a
  // checkout top folder. Only the hook's dropping of GIT_ variables stops that.
  const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: plain, env: { ...process.env, GIT_DIR: gitDir }, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  assert.equal(fs.realpathSync(toplevel), fs.realpathSync(plain));
  const run = await runNode("scripts/triage-hook.mjs", { stdin: stopInput(s, { cwd: plain }), env: { ...s.env, GIT_DIR: gitDir }, cwd: plain });
  assert.equal(run.code, 0);
  assert.equal(s.fake.state.requests.length, 0, "the folder outside git sends nothing");
  // A record is written only after consent passed, so its absence pins the
  // consent rule itself (the excerpt rules alone would also send nothing).
  assert.deepEqual(triageRecords(s), [], "consent is refused: no triage record");
});

test("allowlist: a listed folder below the top folder covers no worktree", async (t) => {
  const s = await setUp(t, { config: { triageWorktrees: true } });
  const second = path.join(s.tempDir, "second");
  git(["worktree", "add", "-q", "--detach", second], s.repo);
  const file = path.join(s.dataDir, "config.json");
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...config, triageProjects: [path.join(s.repo, "src")] }));
  await triage(s, stopInput(s, { cwd: second }));
  assert.equal(s.fake.state.requests.length, 0, "the listed path is not a top folder");
  // Positive control: the same worktree is sent once the top folder is listed.
  fs.writeFileSync(file, JSON.stringify({ ...config, triageProjects: [s.repo] }));
  await triage(s, stopInput(s, { agent_id: "a2", cwd: second }));
  assert.equal(s.fake.state.requests.length, 1);
});

test("fail open, logged: a blocked triage folder gives a hook_error and exit 0", async (t) => {
  const s = await setUp(t);
  fs.writeFileSync(path.join(s.dataDir, "triage"), "a file where the folder should be");
  const result = await triage(s, stopInput(s));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const error = readLog(s.tempDir).find((r) => r.event === "hook_error");
  assert.equal(error.hook, "triage");
});

test("fail open, unlogged: a data folder that is a file still exits 0 without output", async (t) => {
  const s = await setUp(t);
  const blocked = path.join(s.tempDir, "not-a-folder");
  fs.writeFileSync(blocked, "x");
  const result = await runNode("scripts/triage-hook.mjs", { stdin: stopInput(s), env: { ...s.env, ORCH_DATA_DIR: blocked }, cwd: s.repo });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
});

test("fail open, capture: a blocked triage folder gives a hook_error, exit 0 and no output", async (t) => {
  const s = await setUp(t);
  // The triage is on (so the gate passes) and the capture write itself fails.
  fs.writeFileSync(path.join(s.dataDir, "triage"), "a file where the folder should be");
  const result = await capture(s, captureInput(s, "MUST-FIX: x src/a.mjs:1"));
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  const error = readLog(s.tempDir).find((r) => r.event === "hook_error");
  assert.equal(error?.hook, "triage-capture");
});

test("Codex review across a log rotation: the records in the older log file still link", async (t) => {
  const s = await setUp(t, { reply: jevAnswer(["supports", "supports"]) });
  codexFixture(s);
  // Move the two records into the rotated file, as rotation would.
  const current = path.join(s.dataDir, "dispatch-log.jsonl");
  fs.renameSync(current, path.join(s.dataDir, "dispatch-log.1.jsonl"));
  await triage(s, stopInput(s, { agent_id: "ac", agent_type: CODEX_REVIEWER }));
  const counts = readLog(s.tempDir).find((r) => r.event === "review_findings");
  assert.equal(counts.source, "codex_result");
  assert.equal(counts.counts.P1, 2);
});
