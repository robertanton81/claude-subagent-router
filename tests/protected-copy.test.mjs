import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { broadEntries, claimRefusedMessage, copyProtection, deadVariableEntries, entryMatches, isPermissionError, sandboxRows, workerCoverage, workerEntries } from "../scripts/lib/protected-copy.mjs";
import { ROOT } from "./helpers.mjs";

const COPY = "/opt/release/subagent-router";
const DIRS = ["/", "/opt", "/opt/release", COPY, `${COPY}/scripts`, `${COPY}/scripts/lib`, `${COPY}/scripts/lib/deep`, `${COPY}/.git`];
const FILES = [`${COPY}/package.json`, `${COPY}/scripts/orch-codex.mjs`, `${COPY}/scripts/lib/evidence.mjs`, `${COPY}/scripts/lib/deep/inner.mjs`, `${COPY}/.git/config`];

// A fake file tree: every path is a folder or file with an owner and a mode.
// `changes` overrides single paths, for example a folder that the user owns.
function tree(changes = {}, { configDir = "/home/u/.claude", links = {} } = {}) {
  const entries = {};
  for (const dir of DIRS) entries[dir] = { uid: 0, mode: 0o40755, link: false };
  for (const file of FILES) entries[file] = { uid: 0, mode: 0o100644, link: false };
  for (const [file, change] of Object.entries(changes)) entries[file] = { ...entries[file], ...change };
  return {
    lstat(file) {
      const entry = entries[file];
      if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { uid: entry.uid, mode: entry.mode, isSymbolicLink: () => entry.link, isDirectory: () => (entry.mode & 0o170000) === 0o40000 };
    },
    readdir(dir) {
      if (!entries[dir]) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return Object.keys(entries).filter((file) => file !== "/" && path.dirname(file) === dir).map((file) => path.basename(file));
    },
    realpath(file) {
      if (links[file]) return links[file];
      if (entries[file] || file.startsWith("/home/u/.claude")) return file;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    configDir: () => configDir
  };
}

test("a copy that root owns all the way up is protected", () => {
  assert.deepEqual(copyProtection(COPY, tree()), { kind: "root", problem: null });
});

// A fake cache copy that the user owns, under the fake config folder.
const CACHED = "/home/u/.claude/plugins/cache/m/subagent-router/0.4.4";
function cacheTree(changes = {}) {
  const entries = {
    [CACHED]: { mode: 0o40755 },
    [`${CACHED}/scripts`]: { mode: 0o40755 },
    [`${CACHED}/scripts/orch-codex.mjs`]: { mode: 0o100644 },
    [`${CACHED}/scripts/lib`]: { mode: 0o40755 },
    [`${CACHED}/scripts/lib/config.mjs`]: { mode: 0o100644 }
  };
  for (const [file, change] of Object.entries(changes)) entries[file] = { ...entries[file], ...change };
  return {
    lstat(file) {
      const entry = entries[file];
      if (!entry) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { uid: 501, mode: entry.mode, isSymbolicLink: () => Boolean(entry.link), isDirectory: () => (entry.mode & 0o170000) === 0o40000 };
    },
    readdir(dir) {
      return Object.keys(entries).filter((file) => path.dirname(file) === dir).map((file) => path.basename(file));
    },
    realpath: (file) => file,
    configDir: () => "/home/u/.claude"
  };
}

test("a copy in the Claude plugin cache is protected, whoever owns it", () => {
  assert.deepEqual(copyProtection(CACHED, cacheTree()), { kind: "cache", problem: null });
  // A folder that only starts with the cache name is not inside it.
  assert.equal(copyProtection("/home/u/.claude/plugins/cache-other/x", cacheTree()).kind, null);
});

test("a cache copy with a link in it, or with a file that others can write, is not protected", () => {
  const linked = copyProtection(CACHED, cacheTree({ [`${CACHED}/scripts/lib/config.mjs`]: { link: true } }));
  assert.equal(linked.kind, null);
  assert.match(linked.problem, /in the Claude plugin cache, but .*config\.mjs is a symbolic link/);
  const shared = copyProtection(CACHED, cacheTree({ [`${CACHED}/scripts/orch-codex.mjs`]: { mode: 0o100666 } }));
  assert.equal(shared.kind, null);
  assert.match(shared.problem, /orch-codex\.mjs can be written by its group or by other users/);
});

test("the cache counts only in the default config folder, not in one that CLAUDE_CONFIG_DIR names", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  // The real path, so a temp folder behind a symbolic link (macOS /var, /tmp) does not decide the result.
  const elsewhere = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orch-config-dir-")));
  const copy = path.join(elsewhere, "plugins", "cache", "m", "subagent-router", "0.4.4");
  fs.mkdirSync(path.join(copy, "scripts", "lib"), { recursive: true });
  try {
    process.env.CLAUDE_CONFIG_DIR = elsewhere;
    const result = copyProtection(copy);
    assert.equal(result.kind, null, "a cache in a folder that the environment names is not trusted");
    assert.match(result.problem, /outside the Claude plugin cache/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a copy is not protected when anything that it loads or any folder above it can be changed", () => {
  const cases = [
    [{ [COPY]: { uid: 501 } }, `${COPY} is not owned by root`],
    [{ "/opt/release": { uid: 501 } }, "/opt/release is not owned by root"],
    [{ "/opt": { mode: 0o40777 } }, "/opt can be written by its group or by other users"],
    [{ [`${COPY}/scripts/lib/evidence.mjs`]: { mode: 0o100664 } }, `${COPY}/scripts/lib/evidence.mjs can be written by its group`],
    [{ [`${COPY}/scripts/orch-codex.mjs`]: { uid: 501 } }, `${COPY}/scripts/orch-codex.mjs is not owned by root`],
    [{ [`${COPY}/scripts/lib/evidence.mjs`]: { link: true } }, `${COPY}/scripts/lib/evidence.mjs is a symbolic link`],
    // Node reads package.json when it loads the scripts.
    [{ [`${COPY}/package.json`]: { uid: 501 } }, `${COPY}/package.json is not owned by root`],
    // The walk goes into every folder, not only scripts/ and scripts/lib/.
    [{ [`${COPY}/scripts/lib/deep/inner.mjs`]: { mode: 0o100666 } }, `${COPY}/scripts/lib/deep/inner.mjs can be written`],
    [{ [`${COPY}/.git/config`]: { uid: 501 } }, `${COPY}/.git/config is not owned by root`],
    // Each write bit counts alone: a check of the group bit only lets these pass.
    [{ [`${COPY}/scripts/lib/evidence.mjs`]: { mode: 0o100646 } }, `${COPY}/scripts/lib/evidence.mjs can be written by its group or by other users`],
    [{ "/opt/release": { mode: 0o40757 } }, "/opt/release can be written by its group or by other users"],
    // The walk checks the owner of each folder in the copy, not only of its files.
    [{ [`${COPY}/scripts`]: { uid: 501 } }, `${COPY}/scripts is not owned by root`]
  ];
  for (const [changes, expected] of cases) {
    const result = copyProtection(COPY, tree(changes));
    assert.equal(result.kind, null, `expected no protection for ${JSON.stringify(changes)}`);
    assert.ok(result.problem.includes(expected), `${result.problem} should name: ${expected}`);
  }
});

test("a copy reached through a symbolic link, or one that cannot be read, is not protected", () => {
  const linked = copyProtection("/opt/link", tree({}, { links: { "/opt/link": COPY } }));
  assert.equal(linked.kind, null);
  assert.match(linked.problem, /symbolic link/);
  const missing = copyProtection("/nowhere", tree());
  assert.equal(missing.kind, null);
  assert.match(missing.problem, /cannot be checked \(ENOENT\)/);
});

test("the worker entries match the command that the shipped agent files run", () => {
  const [run, wait, cancel] = workerEntries(COPY);
  assert.equal(wait, `node "${COPY}/scripts/orch-codex.mjs" wait *`);
  assert.equal(cancel, `node "${COPY}/scripts/orch-codex.mjs" cancel *`);
  for (const agent of ["codex-reviewer.md", "codex-implementer.md"]) {
    const line = fs.readFileSync(path.join(ROOT, "agents", agent), "utf8").split("\n").find((text) => text.includes("orch-codex.mjs\" run"));
    assert.ok(line, `${agent} has no run command`);
    // Claude Code fills in the root before the model writes the command.
    const call = line.trim().replace("${CLAUDE_PLUGIN_ROOT}", COPY).replace("<request id>", "req-0123456789ab");
    assert.equal(call.replace(/req-[0-9a-f]{12}$/, "*"), run, `${agent} runs a command that the entry does not match`);
  }
});

test("worker coverage counts exact and broad entries, and an entry with the variable text counts for nothing", () => {
  const exact = `node "${COPY}/scripts/orch-codex.mjs" run *`;
  const variable = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-codex.mjs" *';
  const covered = (listed) => workerCoverage(COPY, listed).map((item) => item.coveredBy.length > 0);
  assert.deepEqual(covered([exact, variable, 42]), [true, false, false]);
  assert.deepEqual(covered(undefined), [false, false, false]);
  // A broad entry for the whole script covers all three commands.
  assert.deepEqual(covered([`node "${COPY}/scripts/orch-codex.mjs" *`]), [true, true, true]);
  assert.deepEqual(covered(["node *"]), [true, true, true]);
  // An entry for another copy, or with another quoting, covers nothing.
  assert.deepEqual(covered([`node "/opt/other/scripts/orch-codex.mjs" *`, `node ${COPY}/scripts/orch-codex.mjs *`]), [false, false, false]);
  assert.deepEqual(deadVariableEntries([variable, exact, 7]), [variable]);
});

test("entryMatches follows the Bash rule syntax", () => {
  assert.equal(entryMatches("docker *", "docker"), true, "a trailing space and star also matches no arguments");
  assert.equal(entryMatches("docker *", "docker compose up"), true);
  assert.equal(entryMatches("docker", "docker ps"), false, "no star means an exact match");
  assert.equal(entryMatches("a.b *", "axb c"), false, "a dot is a dot, not any character");
  assert.equal(entryMatches("node \"/x/*/s.mjs\" run *", "node \"/x/../../evil/s.mjs\" run req-1"), true, "a star inside the path matches ../ too");
});

test("the claim message names entries only for a protected copy", () => {
  const safe = claimRefusedMessage("req-0123456789ab", "EPERM", COPY, tree());
  assert.match(safe, /^the request req-0123456789ab could not be claimed \(EPERM\), so no Codex job started and the request is unchanged\./);
  for (const entry of workerEntries(COPY)) assert.ok(safe.includes(entry), `missing entry: ${entry}`);
  assert.match(safe, /Use a Claude worker for this task now/);

  const checkout = claimRefusedMessage("req-0123456789ab", "EPERM", COPY, tree({ [COPY]: { uid: 501 } }));
  assert.match(checkout, /must not leave the sandbox, because it is outside the Claude plugin cache/);
  assert.ok(!checkout.includes("orch-codex.mjs\" run *"), "a copy that a session can change must get no entry to paste");

  assert.match(claimRefusedMessage("req-0123456789ab", "EPERM", CACHED, cacheTree()), /new path after each plugin update/);
});

test("isPermissionError is true for EPERM and EACCES only", () => {
  assert.equal(isPermissionError({ code: "EPERM" }), true);
  assert.equal(isPermissionError({ code: "EACCES" }), true);
  assert.equal(isPermissionError({ code: "ENOENT" }), false);
  assert.equal(isPermissionError(null), false);
});

// The setup check rows for a list of entries, with the result of the
// protection check given, so each branch can be chosen.
const NOT_PROTECTED = `it is outside the Claude plugin cache, and ${COPY} is not owned by root`;
const UNPROTECTED_OK = `this copy (${COPY}) gets no sandbox exclusion, because ${NOT_PROTECTED}. In a session with the Claude sandbox on, Codex workers stop and say so. guide/codex.md, section "The Claude sandbox", names the copies that can be excluded`;
function rowsFor(listed, protection, extra = {}) {
  return sandboxRows({ root: COPY, ...protection, coverage: workerCoverage(COPY, listed), dead: deadVariableEntries(listed), broad: broadEntries(COPY, listed), ...extra });
}

test("the sandbox rows warn about an entry with the variable text, and still give the main row", () => {
  const variable = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-codex.mjs" *';
  assert.deepEqual(rowsFor([variable], { kind: null, problem: NOT_PROTECTED }), [
    ["WARN", `the entry ${variable} matches no worker call, because Claude Code fills in the path before the worker writes its command. Remove it`],
    ["OK", UNPROTECTED_OK]
  ]);
});

test("the sandbox rows tell an unprotected copy to remove the entries that cover it, broad ones included", () => {
  const [run] = workerEntries(COPY);
  const broad = `node "${COPY}/scripts/orch-codex.mjs" *`;
  assert.deepEqual(rowsFor([run, broad, "git *"], { kind: null, problem: NOT_PROTECTED }), [
    ["WARN", `these exclusion entries cover this copy (${COPY}): ${run} ; ${broad}. But ${NOT_PROTECTED}. Remove them: a session could change code that then runs with full access`]
  ]);
});

test("the sandbox rows say that an unprotected copy without covering entries gets no exclusion", () => {
  assert.deepEqual(rowsFor(["git *"], { kind: null, problem: NOT_PROTECTED }), [["OK", UNPROTECTED_OK]]);
  assert.deepEqual(rowsFor([], { kind: null, problem: NOT_PROTECTED }), [["OK", UNPROTECTED_OK]]);
});

test("the sandbox rows name only the entries that a protected copy still misses", () => {
  const [run, wait, cancel] = workerEntries(COPY);
  for (const kind of ["root", "cache"]) {
    assert.deepEqual(rowsFor([run], { kind, problem: null }), [
      ["WARN", `this copy is protected, but these sandbox.excludedCommands entries are missing: ${wait} ; ${cancel}. In a session with the Claude sandbox on, Codex workers stop until they are added`]
    ]);
  }
});

test("the sandbox rows confirm a protected copy with every entry, and say how strong the protection is", () => {
  const complete = (strength) => [
    ["OK", `this copy is protected (${strength}), and the entries for run, wait and cancel are in the settings. This reads the settings only. In Manual mode, a prompt titled "Bash command (unsandboxed)" confirms an entry`]
  ];
  assert.deepEqual(rowsFor(workerEntries(COPY), { kind: "root", problem: null }), complete("owned by root"));
  // One broad entry covers all three commands, but it also lets implement,
  // review and consult out, which the guide keeps inside the sandbox.
  const broad = `node "${COPY}/scripts/orch-codex.mjs" *`;
  assert.deepEqual(rowsFor([broad], { kind: "cache", problem: null }), [
    ["WARN", `these entries also let implement, review or consult leave the sandbox: ${broad}. Those commands send a text and a file that the session chooses, so keep only the entries for run, wait and cancel`],
    ...complete("in the plugin cache, so as safe as the sandbox of every session and every program that runs with your rights")
  ]);
});

test("broadEntries finds the entries that also cover implement, review or consult", () => {
  const [run, wait, cancel] = workerEntries(COPY);
  const script = `node "${COPY}/scripts/orch-codex.mjs"`;
  assert.deepEqual(broadEntries(COPY, [run, wait, cancel]), [], "the three worker entries cover no other command");
  assert.deepEqual(broadEntries(COPY, [`${script} *`, `${script} consult *`, `${script} implement *`, `${script} review *`, "node *", 3]), [`${script} *`, `${script} consult *`, `${script} implement *`, `${script} review *`, "node *"]);
  assert.deepEqual(broadEntries(COPY, [`node "/opt/other/scripts/orch-codex.mjs" *`]), [], "an entry for another copy does not count");
});

test("the sandbox rows name each settings file that could not be used, before the other rows", () => {
  const unreadable = [
    { file: "/p/.claude/settings.json", json: true },
    { file: "/p/.claude/settings.local.json", code: "EISDIR" }
  ];
  assert.deepEqual(rowsFor([], { kind: null, problem: NOT_PROTECTED }, { unreadable }), [
    ["WARN", "the settings file /p/.claude/settings.json could not be read as JSON, so this check counted none of its sandbox.excludedCommands entries"],
    ["WARN", "the settings file /p/.claude/settings.local.json could not be read (EISDIR), so this check counted none of its sandbox.excludedCommands entries"],
    ["OK", UNPROTECTED_OK]
  ]);
});
