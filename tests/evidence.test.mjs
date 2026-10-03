import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { changeGroup, findCitations, readCheckedExcerpt, readExcerpt, repoState } from "../scripts/lib/evidence.mjs";
import { ROOT, makeTempDir } from "./helpers.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, env: process.env, stdio: "pipe", encoding: "utf8", timeout: 10000 });
}

// Key lines are built at run time, so this file holds no literal key line.
// The body lines are repeated letters, not a key.
const DASHES = "-".repeat(5);
const keyBlock = (label, body, { begin = true, end = true } = {}) => [
  ...(begin ? [`${DASHES}BEGIN ${label}${DASHES}`] : []),
  ...Array.from({ length: body }, (_, i) => String.fromCharCode(65 + (i % 26)).repeat(64)),
  ...(end ? [`${DASHES}END ${label}${DASHES}`] : [])
];
const codeLines = (count, from = 1) => Array.from({ length: count }, (_, i) => `code ${from + i}`);

function commit(cwd) {
  git(["add", "-A"], cwd);
  git(["-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "x"], cwd);
}

function repo(t, { withCommit = true } = {}) {
  const root = fs.realpathSync(makeTempDir("orch-evidence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(["init", "-q"], root);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.mjs"), Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
  fs.writeFileSync(path.join(root, "src", "my file.mjs"), "x\ny\nz");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM x\nRUN y");
  fs.writeFileSync(path.join(root, "file.mjs"), "a root file with the same tail name");
  fs.writeFileSync(path.join(root, ".env"), "K=not-a-secret");
  if (withCommit) commit(root);
  return root;
}

const keys = (list) => list.map((c) => `${c.path}:${c.start}-${c.end}`);

test("findCitations finds the written forms in text order and keeps each once", (t) => {
  const root = repo(t);
  const text = `see src/a.mjs:10 and src/a.mjs:10-12, src/a.mjs:10–12, [x](src/my file.mjs:2), \`Dockerfile:1\`, ${root}/src/a.mjs:7`;
  assert.deepEqual(keys(findCitations(text, root)), ["src/a.mjs:10-10", "src/a.mjs:10-12", "src/my file.mjs:2-2", "Dockerfile:1-1", "src/a.mjs:7-7"]);
});

test("findCitations drops outside paths, outward links and line 0", (t) => {
  const root = repo(t);
  const outside = fs.realpathSync(makeTempDir("orch-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "b.mjs"), "outside");
  fs.symlinkSync(path.join(outside, "b.mjs"), path.join(root, "src", "link.mjs"));
  const text = `${outside}/b.mjs:1 src/link.mjs:1 src/a.mjs:0`;
  assert.deepEqual(findCitations(text, root), []);
  // Positive control: the same text plus one valid citation finds exactly that one.
  assert.deepEqual(keys(findCitations(`${text} src/a.mjs:3`, root)), ["src/a.mjs:3-3"]);
});

test("findCitations marks a citation of a credential file instead of dropping it, and both readers refuse a marked one without reading", (t) => {
  const root = repo(t);
  fs.mkdirSync(path.join(root, "deploy"));
  fs.writeFileSync(path.join(root, "deploy", "key.pem"), "not a key\n".repeat(5));
  fs.mkdirSync(path.join(root, "keys"));
  fs.writeFileSync(path.join(root, "keys", "server.ppk"), "not a key\n".repeat(5));
  // A link with an ordinary name whose real path is a credential file.
  fs.symlinkSync(path.join(root, "deploy", "key.pem"), path.join(root, "src", "conf.mjs"));
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  // .ssh/id_rsa does not exist: the finding text may still describe the key.
  const text = "deploy/key.pem:3 then src/a.mjs:5, .env:1, .ssh/id_rsa:2, src/conf.mjs:4 and keys/server.ppk:1";
  const found = findCitations(text, root);
  assert.deepEqual(
    found.map((c) => (c.refused ? `${c.refused} ${c.path}:${c.start}-${c.end}` : `read ${c.path}:${c.start}-${c.end}`)),
    ["credential_name deploy/key.pem:3-3", "read src/a.mjs:5-5", "credential_name .env:1-1", "credential_name .ssh/id_rsa:2-2", "credential_name src/conf.mjs:4-4", "credential_name keys/server.ppk:1-1"]
  );
  for (const marked of found.filter((c) => c.refused)) {
    assert.deepEqual(Object.keys(marked).sort(), ["end", "path", "refused", "start"], "a marked citation carries no path to read");
    assert.deepEqual(readExcerpt(root, marked), { outcome: "withheld_secret" }, marked.path);
    assert.deepEqual(readCheckedExcerpt(root, marked, { mode: "blob", commit: head }), { outcome: "withheld_secret" }, marked.path);
  }
});

test("a secret value on the line after its name is masked on both read paths, and every line keeps its number", (t) => {
  const root = repo(t);
  const value = "Q".repeat(24);
  // Line 1 a comment, line 2 the name, line 3 the value, lines 4-60 code.
  fs.writeFileSync(path.join(root, "src", "conf.mjs"), ["// settings", "const apiKey =", `  "${value}";`, ...codeLines(57, 4)].join("\n"));
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  // The value line, the name line, and line 23, whose window starts on the value line.
  for (const [text, first] of [["src/conf.mjs:3", 1], ["src/conf.mjs:2", 1], ["src/conf.mjs:23", 3]]) {
    const [citation] = findCitations(text, root);
    for (const [name, read] of [["working tree", readExcerpt(root, citation)], ["blob", readCheckedExcerpt(root, citation, { mode: "blob", commit: head })]]) {
      assert.equal(typeof read?.excerpt, "string", `${text} ${name}`);
      assert.equal(read.excerpt.includes(value), false, `${text} ${name}`);
      const lines = read.excerpt.split("\n");
      lines.forEach((line, i) => assert.ok(line.startsWith(`${first + i}: `), `${text} ${name}: ${line}`));
      assert.ok(lines.includes('3:   <redacted>;'), `${text} ${name}`);
      assert.equal(read.redactions, 1, `${text} ${name}`);
    }
  }
});

test("a UTF-16 file is never read, also when its first 8 KiB holds no NUL byte", (t) => {
  const root = repo(t);
  // Both UTF-16LE bytes of U+0101 are 0x01, so the first 10 KB hold no NUL.
  const bytes = Buffer.from(`${String.fromCharCode(0x101).repeat(5000)}\npassword = "${"Q".repeat(24)}"\nmore\n`, "utf16le");
  assert.equal(bytes.subarray(0, 8192).includes(0), false);
  fs.writeFileSync(path.join(root, "src", "wide.mjs"), bytes);
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  const [citation] = findCitations("src/wide.mjs:2", root);
  assert.ok(citation);
  assert.equal(readExcerpt(root, citation), null);
  assert.equal(readCheckedExcerpt(root, citation, { mode: "blob", commit: head }), null);
});

test("a key file changed after the reviewed commit still gives withheld_secret on the job path", (t) => {
  const root = repo(t);
  // A key file at the commit, and a clean file that gets a key after it.
  fs.writeFileSync(path.join(root, "src", "conf.mjs"), [...codeLines(10), ...keyBlock("RSA PRIVATE KEY", 25), ...codeLines(43, 38)].join("\n"));
  fs.writeFileSync(path.join(root, "src", "later.mjs"), codeLines(80).join("\n"));
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  fs.appendFileSync(path.join(root, "src", "conf.mjs"), "\ncode 81");
  fs.writeFileSync(path.join(root, "src", "later.mjs"), [...codeLines(10), ...keyBlock("EC PRIVATE KEY", 25), ...codeLines(43, 38)].join("\n"));
  fs.appendFileSync(path.join(root, "src", "a.mjs"), "\nline 201");
  for (const text of ["src/conf.mjs:75", "src/later.mjs:75"]) {
    const [citation] = findCitations(text, root);
    assert.deepEqual(readCheckedExcerpt(root, citation, { mode: "blob", commit: head }), { outcome: "withheld_secret" }, text);
  }
  // Positive control: a clean file changed after the commit is stale, so the blob check ran.
  const [clean] = findCitations("src/a.mjs:5", root);
  assert.deepEqual(readCheckedExcerpt(root, clean, { mode: "blob", commit: head }), { outcome: "stale_evidence" });
});

test("readExcerpt returns numbered lines with 20 lines of context and no character cut", (t) => {
  const root = repo(t);
  const [citation] = findCitations("src/a.mjs:50-52", root);
  const { excerpt } = readExcerpt(root, citation);
  const lines = excerpt.split("\n");
  assert.equal(lines[0], "30: line 30");
  assert.equal(lines.at(-1), "72: line 72");
  assert.equal(lines.length, 43);
});

test("readExcerpt refuses binary, oversized and past-the-end cases", (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 0, 2]));
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(1024 * 1024 + 1));
  for (const text of ["bin.dat:1", "big.txt:1", "src/a.mjs:999"]) {
    const [citation] = findCitations(text, root);
    assert.ok(citation, text);
    assert.equal(readExcerpt(root, citation), null, text);
  }
});

test("readExcerpt refuses a file swapped for a link after findCitations", (t) => {
  const root = repo(t);
  const outside = fs.realpathSync(makeTempDir("orch-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "a.mjs"), "SECRET OUTSIDE");
  const [citation] = findCitations("src/a.mjs:1", root);
  assert.equal(typeof readExcerpt(root, citation)?.excerpt, "string"); // positive control: readable before the swap
  fs.rmSync(path.join(root, "src", "a.mjs"));
  fs.symlinkSync(path.join(outside, "a.mjs"), path.join(root, "src", "a.mjs"));
  assert.equal(readExcerpt(root, citation), null);
});

test("readExcerpt refuses a parent folder swapped for a link to an outside folder", (t) => {
  const root = repo(t);
  const outside = fs.realpathSync(makeTempDir("orch-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "a.mjs"), "SECRET OUTSIDE");
  const [citation] = findCitations("src/a.mjs:1", root);
  assert.equal(typeof readExcerpt(root, citation)?.excerpt, "string"); // positive control: readable before the swap
  fs.rmSync(path.join(root, "src"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "src"));
  assert.equal(readExcerpt(root, citation), null);
});

test("readExcerpt returns at once for a named pipe", { skip: process.platform === "win32" }, (t) => {
  const root = repo(t);
  execFileSync("mkfifo", [path.join(root, "pipe.txt")], { env: process.env, timeout: 5000 });
  const [citation] = findCitations("pipe.txt:1", root);
  const started = Date.now();
  assert.equal(readExcerpt(root, citation), null);
  assert.ok(Date.now() - started < 1000);
});

test("a private key anywhere in a file holds back every excerpt of it, on both read paths", (t) => {
  const root = repo(t);
  const files = {
    // Lines 1-10 code, 11 BEGIN, 12-36 key body, 37 END, 38-80 code.
    "src/conf.mjs": [...codeLines(10), ...keyBlock("RSA PRIVATE KEY", 25), ...codeLines(43, 38)],
    // Lines 6-77 are the key: the window of line 40 holds neither its first nor its last line.
    "src/long.mjs": [...codeLines(5), ...keyBlock("OPENSSH PRIVATE KEY", 70), ...codeLines(5, 78)],
    // A first line without its END line.
    "src/half.mjs": [...codeLines(5), ...keyBlock("PRIVATE KEY", 3, { end: false }), ...codeLines(60, 10)],
    "src/pgp.mjs": [...codeLines(5), ...keyBlock("PGP PRIVATE KEY BLOCK", 25), ...codeLines(40, 33)],
    // Only body and END lines: the start of the key was cut off.
    "src/tail.mjs": [...keyBlock("EC PRIVATE KEY", 10, { begin: false }), ...codeLines(40, 12)]
  };
  for (const [name, lines] of Object.entries(files)) fs.writeFileSync(path.join(root, name), lines.join("\n"));
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  // conf.mjs:34 is a body line (its window starts at line 14) and conf.mjs:38
  // the first line after END. The other windows hold no key line at all.
  for (const text of ["src/conf.mjs:34", "src/conf.mjs:38", "src/conf.mjs:75", "src/long.mjs:40", "src/half.mjs:50", "src/pgp.mjs:60", "src/tail.mjs:45"]) {
    const [citation] = findCitations(text, root);
    assert.deepEqual(readExcerpt(root, citation), { outcome: "withheld_secret" }, text);
    assert.deepEqual(readCheckedExcerpt(root, citation, { mode: "blob", commit: head }), { outcome: "withheld_secret" }, text);
  }
  // Positive control: a clean file of the same commit is read on both paths.
  const [clean] = findCitations("src/a.mjs:5", root);
  assert.match(readExcerpt(root, clean).excerpt, /^5: line 5$/m);
  assert.match(readCheckedExcerpt(root, clean, { mode: "blob", commit: head }).excerpt, /^5: line 5$/m);
});

test("readExcerpt never reads a file that git ignores; a tracked file and a new file that git does not ignore are read", (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "local/\n*.local.mjs\n");
  fs.mkdirSync(path.join(root, "local"));
  for (const name of ["local/conf.mjs", "src/db.local.mjs", "src/new.mjs", "src/kept.local.mjs"]) fs.writeFileSync(path.join(root, name), "a\nb\nc");
  // git ignores only files it does not track, so a tracked file that matches
  // an ignore rule is still read.
  git(["add", "-f", "src/kept.local.mjs"], root);
  for (const text of ["local/conf.mjs:2", "src/db.local.mjs:2"]) {
    const [citation] = findCitations(text, root);
    assert.ok(citation, text);
    assert.equal(readExcerpt(root, citation), null, text);
  }
  for (const text of ["src/a.mjs:2", "src/new.mjs:2", "src/kept.local.mjs:2"]) {
    const [citation] = findCitations(text, root);
    assert.equal(typeof readExcerpt(root, citation)?.excerpt, "string", text);
  }
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

// A folder with a git stand-in. "git check-ignore" runs the given shell
// command; every other git command goes to the real git.
function ignoreCheckStandIn(t, command) {
  const bin = makeTempDir("orch-fake-git-");
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\nif [ "$1" = "check-ignore" ]; then ${command}; fi\nexec '${realGit()}' "$@"\n`, { mode: 0o755 });
  return bin;
}

// Runs findCitations and readExcerpt in a child Node (started through
// process.execPath) whose PATH starts with the given folder. Returns the
// result and the child's stderr.
function readWithGitFrom(t, root, text, bin) {
  const home = makeTempDir("orch-git-home-");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const evidence = path.join(ROOT, "scripts", "lib", "evidence.mjs");
  const script = `import { findCitations, readExcerpt } from ${JSON.stringify(evidence)}; const root = ${JSON.stringify(root)}; const [c] = findCitations(${JSON.stringify(text)}, root); process.stdout.write(JSON.stringify(readExcerpt(root, c)));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home }, encoding: "utf8", timeout: 20000 });
  assert.equal(run.status, 0, run.stderr);
  return { result: JSON.parse(run.stdout), stderr: run.stderr };
}

test("readExcerpt reads nothing when the ignore check fails or is killed, and says so on stderr", { skip: process.platform === "win32" }, (t) => {
  const root = repo(t);
  // Positive control: a stand-in that answers "not ignored" lets the read through,
  // so the stand-in hands the other git commands on correctly.
  const passed = readWithGitFrom(t, root, "src/a.mjs:5", ignoreCheckStandIn(t, "exit 1"));
  assert.match(passed.result.excerpt, /^5: line 5$/m);
  assert.equal(passed.stderr, "");
  for (const [command, reason] of [["exit 128", "exit 128"], ["kill -KILL $$", "signal SIGKILL"]]) {
    const failed = readWithGitFrom(t, root, "src/a.mjs:5", ignoreCheckStandIn(t, command));
    assert.equal(failed.result, null, command);
    assert.equal(failed.stderr, `subagent-router triage: git check-ignore failed (${reason}), so src/a.mjs was not read\n`, command);
  }
});

test("both readers refuse a citation whose written path is a credential name, also when its real path is not", (t) => {
  const root = repo(t);
  // The same bytes as src/a.mjs, so the blob check of the job path passes on its own.
  fs.copyFileSync(path.join(root, "src", "a.mjs"), path.join(root, "deploy.pem"));
  commit(root);
  const head = git(["rev-parse", "HEAD"], root).trim();
  const own = { path: "src/a.mjs", written: "src/a.mjs", real: path.join(root, "src", "a.mjs"), start: 5, end: 5 };
  // Positive control: with its own written path the citation is read on both paths.
  assert.match(readExcerpt(root, own).excerpt, /^5: line 5$/m);
  assert.match(readCheckedExcerpt(root, own, { mode: "blob", commit: head }).excerpt, /^5: line 5$/m);
  const named = { ...own, written: "deploy.pem" };
  assert.equal(readExcerpt(root, named), null);
  assert.equal(readCheckedExcerpt(root, named, { mode: "blob", commit: head }), null);
});

test("repoState reports clean, dirty, unborn and plain folders", (t) => {
  const root = repo(t);
  const clean = repoState(root);
  assert.equal(clean.root, root);
  assert.match(clean.head, /^[0-9a-f]{40}$/);
  assert.equal(clean.dirty, false);
  assert.equal(clean.error, null);
  fs.writeFileSync(path.join(root, "new.txt"), "x");
  assert.equal(repoState(root).dirty, true);

  const unborn = repo(t, { withCommit: false });
  const state = repoState(unborn);
  assert.deepEqual({ ...state, commonDir: undefined }, { root: unborn, commonDir: undefined, head: null, dirty: null, error: "no_commit" });
  assert.equal(state.commonDir, fs.realpathSync(path.join(unborn, ".git")));

  const plain = fs.realpathSync(makeTempDir("orch-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(repoState(plain).error, "not_a_repo");
});

test("repoState reports git_missing when PATH holds no git", (t) => {
  const empty = makeTempDir("orch-nopath-");
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  // The child is started through process.execPath (the Volta rule); only its
  // own PATH lacks git.
  const script = `import { repoState } from ${JSON.stringify(path.join(ROOT, "scripts", "lib", "evidence.mjs"))}; process.stdout.write(repoState(${JSON.stringify(os.tmpdir())}).error);`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { PATH: empty, HOME: empty }, encoding: "utf8" });
  assert.equal(result.stdout, "git_missing");
});

test("one commit seen from two worktrees is one change group", (t) => {
  const root = repo(t);
  const second = path.join(fs.realpathSync(os.tmpdir()), `orch-wt-${process.pid}-${Date.now()}`);
  git(["worktree", "add", "-q", "--detach", second], root);
  t.after(() => fs.rmSync(second, { recursive: true, force: true }));
  const a = repoState(root);
  const b = repoState(second);
  assert.notEqual(a.root, b.root);
  assert.equal(a.commonDir, b.commonDir);
  assert.deepEqual(changeGroup(a, "s1", "x"), changeGroup(b, "s2", "y"));
  assert.equal(changeGroup(a, "s1", "x").eligible, true);
});

test("an unknown repository or commit gives an ineligible group unique to the agent", () => {
  const one = changeGroup({ head: null }, "s", "a");
  assert.equal(one.eligible, false);
  assert.notEqual(one.key, changeGroup({ head: null }, "s", "b").key);
});
