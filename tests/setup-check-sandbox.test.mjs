import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { copyProtection, workerEntries } from "../scripts/lib/protected-copy.mjs";
import { cleanEnv, makeTempDir, ROOT, runNode } from "./helpers.mjs";

// The setup check also reads the managed settings files. Where one exists, the
// rows depend on it, so these tests do not run there. They also need a
// checkout that gets no exclusion: one that a user owns, not root.
const MANAGED = ["/Library/Application Support/ClaudeCode/managed-settings.json", "/etc/claude-code/managed-settings.json"];
const managed = MANAGED.find((file) => fs.existsSync(file));
const protection = copyProtection(ROOT);
const skip = managed ? `${managed} exists, so the rows depend on it` : protection.kind ? `this checkout counts as protected (${protection.kind})` : false;

// A stand-in for `codex`, first on PATH. It answers only the two calls that the
// setup check makes, so the real `codex` never runs here.
const FAKE_CODEX = `#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.0.0-fake" ;;
  login) echo "Logged in using ChatGPT" >&2 ;;
  *) echo "unexpected call: $*" >&2; exit 2 ;;
esac
`;

const VARIABLE_ENTRY = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-codex.mjs" *';
const NO_EXCLUSION = `this copy (${ROOT}) gets no sandbox exclusion, because it is outside the Claude plugin cache`;

// Runs the setup check with HOME in a temp folder, so ~/.claude/settings.json
// is a temp file, with Codex on in config.json, and with a temp project folder
// as the working folder. `user` is the text of the user settings file, and
// `project` maps file names in the project's .claude folder to their text.
// `userMode` sets the mode of the user settings file. `projectDirs` names
// project settings paths that are folders, not files. `codexEnabled` goes into
// config.json. With `configDir`, CLAUDE_CONFIG_DIR names that folder under the
// temp folder, and the user settings file is written there instead of HOME.
async function runCheck({ user, userMode, project = {}, projectDirs = [], codexEnabled = true, configDir } = {}) {
  const tempDir = makeTempDir("orch-setup-sandbox-");
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify({ codexEnabled }));
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "codex"), FAKE_CODEX, { mode: 0o755 });
    const userDir = path.join(tempDir, configDir ?? ".claude");
    if (user !== undefined) {
      fs.mkdirSync(userDir);
      fs.writeFileSync(path.join(userDir, "settings.json"), user);
      if (userMode !== undefined) fs.chmodSync(path.join(userDir, "settings.json"), userMode);
    }
    const projectDir = path.join(tempDir, "project");
    fs.mkdirSync(path.join(projectDir, ".claude"), { recursive: true });
    for (const [name, text] of Object.entries(project)) {
      fs.writeFileSync(path.join(projectDir, ".claude", name), text);
    }
    for (const name of projectDirs) fs.mkdirSync(path.join(projectDir, ".claude", name));
    // config.json turns Codex on here, not the variable that cleanEnv sets.
    const env = cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "", ORCH_JEV_ENABLED: "", PATH: `${binDir}${path.delimiter}${process.env.PATH}`, ...(configDir ? { CLAUDE_CONFIG_DIR: userDir } : {}) });
    const result = await runNode("scripts/setup-check.mjs", { env, cwd: projectDir });
    assert.equal(result.code, 0, result.stderr);
    if (codexEnabled) assert.match(result.stdout, /^OK +Codex CLI: codex-cli 0\.0\.0-fake$/m, "the stand-in answered, not the real codex");
    // The check names a project file by the real path of its working folder.
    const projectSettings = path.join(fs.realpathSync(projectDir), ".claude");
    return { stdout: result.stdout, rows: result.stdout.split("\n").filter((line) => line.includes(" Codex worker sandbox: ")), projectSettings };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("with no entries in any settings file, this checkout gets no sandbox exclusion", { skip }, async () => {
  const { rows } = await runCheck();
  assert.equal(rows.length, 1, rows.join("\n"));
  assert.match(rows[0], /^OK +Codex worker sandbox: /);
  assert.ok(rows[0].includes(NO_EXCLUSION), rows[0]);
});

test("project entries that cover this checkout's worker calls get a warning to remove them", { skip }, async () => {
  const entries = workerEntries(ROOT);
  const { rows } = await runCheck({ project: { "settings.local.json": JSON.stringify({ sandbox: { excludedCommands: entries } }) } });
  assert.equal(rows.length, 1, rows.join("\n"));
  assert.match(rows[0], /^WARN +Codex worker sandbox: /);
  assert.ok(rows[0].includes(`these exclusion entries cover this copy (${ROOT}): ${entries.join(" ; ")}. But it is outside the Claude plugin cache`), rows[0]);
  assert.ok(rows[0].includes("Remove them: a session could change code that then runs with full access"), rows[0]);
});

test("a user entry with the variable text gets a warning that it matches no worker call", { skip }, async () => {
  const { rows } = await runCheck({ user: JSON.stringify({ sandbox: { excludedCommands: [VARIABLE_ENTRY] } }) });
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.match(rows[0], /^WARN +Codex worker sandbox: /);
  assert.ok(rows[0].includes(`the entry ${VARIABLE_ENTRY} matches no worker call`), rows[0]);
  assert.ok(rows[1].includes(NO_EXCLUSION), "the entry covers nothing, so the main row stays OK");
});

test("a project settings file that is not valid JSON gets a warning that names it and shows none of its text", { skip }, async () => {
  // A JSON parse error quotes the first 10 characters of the text, so this
  // short marker would show if the check printed the error.
  const marker = "TEXT-7F3A";
  const { stdout, rows, projectSettings } = await runCheck({ project: { "settings.json": `${marker} {"sandbox": {` } });
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.match(rows[0], /^WARN +Codex worker sandbox: /);
  assert.ok(rows[0].includes(`the settings file ${path.join(projectSettings, "settings.json")} could not be read as JSON`), rows[0]);
  assert.ok(rows[1].includes(NO_EXCLUSION), rows[1]);
  assert.ok(!stdout.includes(marker), "the check must not print the text of a settings file");
});

test("a settings file that this user may not read adds no row", { skip: skip || (process.getuid?.() === 0 ? "root reads every file" : false) }, async () => {
  const { rows } = await runCheck({ user: JSON.stringify({ sandbox: { excludedCommands: [VARIABLE_ENTRY] } }), userMode: 0o000 });
  assert.equal(rows.length, 1, rows.join("\n"));
  assert.ok(rows[0].includes(NO_EXCLUSION), rows[0]);
});

test("with Codex off, the check prints no sandbox row at all", { skip }, async () => {
  const entries = workerEntries(ROOT);
  const { stdout, rows } = await runCheck({ codexEnabled: false, project: { "settings.json": JSON.stringify({ sandbox: { excludedCommands: entries } }) } });
  assert.match(stdout, /^OK +Codex: off/m, "the check ran with Codex off");
  assert.deepEqual(rows, []);
});

test("a project settings path that cannot be read for another reason gets a warning with the error code", { skip }, async () => {
  const { rows, projectSettings } = await runCheck({ projectDirs: ["settings.local.json"] });
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.match(rows[0], /^WARN +Codex worker sandbox: /);
  assert.ok(rows[0].includes(`the settings file ${path.join(projectSettings, "settings.local.json")} could not be read (EISDIR)`), rows[0]);
  assert.ok(rows[1].includes(NO_EXCLUSION), rows[1]);
});

test("the user settings come from CLAUDE_CONFIG_DIR when it is set", { skip }, async () => {
  const { rows } = await runCheck({ configDir: "other-config", user: JSON.stringify({ sandbox: { excludedCommands: [VARIABLE_ENTRY] } }) });
  assert.equal(rows.length, 2, rows.join("\n"));
  assert.ok(rows[0].includes(`the entry ${VARIABLE_ENTRY} matches no worker call`), "the entry was read from the folder that CLAUDE_CONFIG_DIR names");
});
