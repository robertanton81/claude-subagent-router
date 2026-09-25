import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { claudeRules } from "../scripts/lib/claude-rules.mjs";
import { isolateInstructions } from "./instruction-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

function fixture(t) {
  const root = fs.realpathSync(makeTempDir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(isolateInstructions(root));
  const home = path.join(root, "home");
  const project = path.join(home, "project");
  const cwd = path.join(project, "src");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(project, ".git"));
  const warnings = [];
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const collect = (config = {}) => claudeRules(cwd, { codexIncludeUserRules: true, codexIncludeProjectRules: true, ...config }, { home, warn: (s) => warnings.push(s) });
  return { root, home, project, cwd, warnings, write, collect };
}

test("rules include user, parent, local and nested rule files in broad-to-specific order", (t) => {
  const { home, project, cwd, write, collect } = fixture(t);
  write(path.join(home, ".claude/CLAUDE.md"), "PERSONAL MAIN");
  write(path.join(home, ".claude/rules/nested/style.md"), "PERSONAL STYLE");
  write(path.join(home, "CLAUDE.md"), "PARENT MAIN");
  write(path.join(project, "CLAUDE.md"), "PROJECT MAIN");
  write(path.join(project, ".claude/CLAUDE.md"), "PROJECT DOT");
  write(path.join(project, ".claude/rules/testing.md"), "PROJECT TESTS");
  write(path.join(project, "CLAUDE.local.md"), "PROJECT LOCAL");
  write(path.join(cwd, "CLAUDE.md"), "CHILD MAIN");
  const result = collect();
  const markers = ["PERSONAL MAIN", "PERSONAL STYLE", "PARENT MAIN", "PROJECT MAIN", "PROJECT DOT", "PROJECT TESTS", "PROJECT LOCAL", "CHILD MAIN"];
  let previous = -1;
  for (const marker of markers) {
    const index = result.text.indexOf(marker);
    assert.ok(index > previous, `${marker} is missing or out of order`);
    previous = index;
  }
  assert.equal(result.text.split("PERSONAL MAIN").length, 2, "home is not loaded twice as an ancestor");
  const projectOnly = collect({ codexIncludeUserRules: false }).text;
  assert.ok(!projectOnly.includes("PERSONAL MAIN") && !projectOnly.includes("PERSONAL STYLE"));
  assert.ok(projectOnly.includes("PROJECT LOCAL"));
  const userOnly = collect({ codexIncludeProjectRules: false }).text;
  assert.ok(userOnly.includes("PERSONAL STYLE") && !userOnly.includes("PROJECT MAIN"));
  assert.equal(collect({ codexIncludeUserRules: false, codexIncludeProjectRules: false }).text, "");
});

test("relative imports expand in place and keep the containing rule's path condition", (t) => {
  const { project, write, collect } = fixture(t);
  write(path.join(project, ".claude/rules/api.md"), '---\npaths: ["src/api/**"]\n---\nAPI ONLY\n@../../guides/api.md\n');
  write(path.join(project, "guides/api.md"), "API DETAIL @./more.md");
  write(path.join(project, "guides/more.md"), "MORE DETAIL");
  const { text } = collect();
  assert.ok(text.includes('paths: ["src/api/**"]'));
  assert.ok(text.includes(`Rule base directory: ${project}.`));
  const start = text.indexOf("API ONLY");
  const detail = text.indexOf("MORE DETAIL");
  const end = text.indexOf("[End rules from", start);
  assert.ok(start < detail && detail < end, "import stays within the conditional rule section");
});

test("imports skip code examples and report cycles, missing files and depth limits", (t) => {
  const { project, write, collect, warnings } = fixture(t);
  write(path.join(project, "CLAUDE.md"), "@one.md\n`@literal.md`\n```md\n@literal.md\n```\n@missing.md\n@depth0.md");
  write(path.join(project, "one.md"), "INCLUDED ONCE\n@CLAUDE.md");
  write(path.join(project, "literal.md"), "MUST NOT EXPAND");
  for (let i = 0; i < 6; i++) write(path.join(project, `depth${i}.md`), `DEPTH ${i}\n@depth${i + 1}.md`);
  const result = collect();
  assert.equal(result.text.split("INCLUDED ONCE").length, 2);
  assert.ok(!result.text.includes("MUST NOT EXPAND"));
  assert.ok(result.text.includes("DEPTH 3") && !result.text.includes("DEPTH 4"));
  assert.ok(result.notes.some((n) => n.includes("circular import")));
  assert.ok(result.notes.some((n) => n.includes("missing.md: NOT included (ENOENT)")));
  assert.ok(warnings.some((n) => n.includes("import depth exceeds four hops")));
  write(path.join(project, "CLAUDE.md"), "~~~md\n@literal.md\n");
  assert.ok(!collect().text.includes("MUST NOT EXPAND"), "an unclosed fence stays literal");
});

test("project imports and rule symlinks cannot escape through parents or credentials", (t) => {
  const { home, project, write, collect, warnings } = fixture(t);
  write(path.join(home, "outside.md"), "OUTSIDE MUST NOT TRAVEL");
  write(path.join(project, ".env"), "FIXTURE MUST NOT TRAVEL");
  write(path.join(project, "CLAUDE.md"), "@../outside.md\n@~/.claude/private.md\n@.env\n@alias.md\n@inside.md");
  write(path.join(home, ".claude/private.md"), "HOME MUST NOT TRAVEL");
  write(path.join(project, "inside.md"), "INSIDE IS INCLUDED");
  fs.symlinkSync(path.join(home, "outside.md"), path.join(project, "alias.md"));
  fs.mkdirSync(path.join(project, ".claude/rules"), { recursive: true });
  fs.symlinkSync(path.join(home, "outside.md"), path.join(project, ".claude/rules/escape.md"));
  const { text, notes } = collect();
  assert.ok(text.includes("INSIDE IS INCLUDED"));
  for (const marker of ["OUTSIDE MUST NOT TRAVEL", "HOME MUST NOT TRAVEL", "FIXTURE MUST NOT TRAVEL"]) assert.ok(!text.includes(marker));
  assert.ok(notes.some((n) => n.includes("credential file")));
  assert.ok(warnings.some((n) => n.includes("points outside the project folder")));
});

test("user imports support home and absolute paths, and rule directory cycles terminate", (t) => {
  const { home, write, collect } = fixture(t);
  write(path.join(home, ".claude/CLAUDE.md"), `@~/personal.md\n@${home}/absolute.md`);
  write(path.join(home, "personal.md"), "HOME IMPORT");
  write(path.join(home, "absolute.md"), "ABSOLUTE IMPORT");
  write(path.join(home, ".claude/rules/a.md"), "RULE ONCE");
  fs.symlinkSync(path.join(home, ".claude/rules"), path.join(home, ".claude/rules/loop"));
  fs.symlinkSync(path.join(home, "missing.md"), path.join(home, ".claude/rules/0-broken.md"));
  const { text, notes } = collect();
  assert.ok(text.includes("HOME IMPORT") && text.includes("ABSOLUTE IMPORT"));
  assert.equal(text.split("RULE ONCE").length, 2);
  assert.ok(notes.some((n) => n.includes("0-broken.md: NOT included (ENOENT)")), "a broken link is reported and other rules still load");
});

test("rules reads and forwarded text are bounded and truncation is visible", (t) => {
  const { project, write, collect, warnings } = fixture(t);
  write(path.join(project, "CLAUDE.md"), "x".repeat(20000) + "TAIL MUST NOT TRAVEL");
  for (let i = 0; i < 12; i++) write(path.join(project, `.claude/rules/${i}.md`), "y".repeat(16000));
  const { text, notes } = collect();
  assert.ok(!text.includes("TAIL MUST NOT TRAVEL"));
  assert.ok(text.length < 140000, `bounded text length: ${text.length}`);
  assert.ok(notes.some((n) => n.includes("cut after 16000 characters")));
  assert.ok(warnings.some((n) => n.includes("limit reached")));
});

test("missing prose references stay literal and sentence punctuation does not hide an import", (t) => {
  const { project, write, collect } = fixture(t);
  write(path.join(project, "CLAUDE.md"), "Use @param and @team. See @guide.md.\nA stray ` tick.\n\n@guide.md!");
  write(path.join(project, "guide.md"), "ACTUAL GUIDE");
  const { text } = collect();
  assert.ok(text.includes("Use @param and @team."));
  assert.equal(text.split("ACTUAL GUIDE").length, 3, "both imports expand, including after a blank line");
});

test("imports cannot forward common credential stores or git metadata", (t) => {
  const { project, write, collect } = fixture(t);
  const names = [".git/config", ".npmrc", ".netrc", ".git-credentials", ".pypirc", "credentials", "id_ecdsa", "id_dsa"];
  for (const name of names) write(path.join(project, name), "FORBIDDEN FIXTURE CONTENT");
  write(path.join(project, "CLAUDE.md"), names.map((name) => `@${name}`).join("\n"));
  const { text, notes } = collect();
  assert.ok(!text.includes("FORBIDDEN FIXTURE CONTENT"));
  for (const name of names) assert.ok(notes.some((n) => n.includes(`${name}: NOT included (credential file`)), name);
});

test("many failed imports cannot amplify output or diagnostics without a bound", (t) => {
  const { project, write, collect, warnings } = fixture(t);
  write(path.join(project, "CLAUDE.md"), " @missing.md".repeat(1300));
  const { text, notes } = collect();
  assert.ok(text.length <= 160000);
  assert.ok(notes.length <= 129);
  assert.ok(warnings.length <= 129);
  assert.ok(text.includes("import count limit reached"));
  assert.ok(notes.some((n) => n.includes("diagnostic limit reached")));
});

test("the final output cap includes expanded section labels, not only file contents", (t) => {
  const { project, write, collect } = fixture(t);
  for (let i = 0; i < 200; i++) {
    write(path.join(project, `.claude/rules/${String(i).padStart(3, "0")}-${"long-name-".repeat(10)}.md`), "z".repeat(600));
  }
  const { text, notes } = collect();
  assert.equal(text.length, 160000);
  assert.ok(text.endsWith("[Instruction snapshot cut at the final output limit.]\n"));
  // Included-file notes may fill the diagnostic budget before this cut. The
  // final marker must remain visible even when only the summary note fits.
  assert.ok(notes.some((n) => n.includes("diagnostic limit reached") || n.includes("final output limit reached")));
});

test("code spans, credential documentation and literal references survive forwarding", (t) => {
  const { project, write, collect } = fixture(t);
  write(path.join(project, "CLAUDE.md"), "```code```\n@credentials.md\nLook in @src and keep @. @...\n" + " @nobody".repeat(280) + " KEEP @last");
  write(path.join(project, "credentials.md"), "DOCUMENTATION IS INCLUDED");
  const { text } = collect();
  assert.ok(text.includes("DOCUMENTATION IS INCLUDED"));
  assert.ok(text.includes("Look in @src and keep @. @..."));
  assert.ok(text.includes("KEEP @last"));
  assert.equal(text.split("@nobody").length, 281);
});

test("the test guard reports swallowed violations and preserves native realpath", (t) => {
  const root = fs.realpathSync(makeTempDir());
  const outside = fs.realpathSync(makeTempDir());
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, "test-only.txt"), "FIXTURE OUTSIDE CONTENT");
  const restore = isolateInstructions(root);
  try {
    assert.equal(fs.realpathSync.native(root), root);
    assert.throws(() => fs.openSync(path.join(outside, "test-only.txt"), "r"), /outside its root/);
  } finally {
    assert.throws(restore, /blocked 1 outside reads/);
  }
  assert.ok(fs.existsSync(path.join(root, ".instruction-read-violation")));
});
