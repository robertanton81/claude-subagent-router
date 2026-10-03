import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { CONFIG_SPEC, DEFAULTS, loadConfig, parseSetting, settingSpec } from "../scripts/lib/config.mjs";
import { cleanEnv, makeTempDir, runNode } from "./helpers.mjs";

const COMMAND = "scripts/orch-config.mjs";

function setUp() {
  const tempDir = makeTempDir("orch-config-");
  const env = cleanEnv(tempDir, { ORCH_CODEX_ENABLED: "" });
  return { tempDir, env, file: path.join(tempDir, "data", "config.json") };
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// The spec exists so a tool can check a value before writing it. If it drifted
// from the loader, the tool would write values the loader then throws away in
// silence, which is the whole failure this test exists to prevent.
test("the spec and the loader agree on what every setting accepts", () => {
  const tempDir = makeTempDir("orch-config-spec-");
  try {
    const dataDir = path.join(tempDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "config.json");
    // Only the file matters here, so no variable may override it.
    const env = { ORCH_DATA_DIR: dataDir, HOME: tempDir, PATH: process.env.PATH };
    const loadWith = (key, value) => {
      fs.writeFileSync(file, JSON.stringify({ [key]: value }));
      return loadConfig(env);
    };

    for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
      // A value the spec accepts must survive the loader unchanged.
      const good =
        spec.kind === "choice"
          ? spec.values[spec.values.length - 1]
          : spec.kind === "flag"
            ? !DEFAULTS[key]
            : spec.kind === "number"
              ? spec.min
              : spec.kind === "textList"
                ? ["some-agent"]
                : spec.kind === "pathList"
                  ? ["/some/checkout"]
                  : spec.kind === "formatList"
                    ? [{ agentTypes: ["acme:review-bot"], labels: ["MUST-FIX"], emptyPhrases: ["no findings"] }]
                    : "something";
      assert.deepEqual(loadWith(key, good).config[key], good, `the loader dropped a value the spec accepts for ${key}`);

      // Both ends of a range, from the accepting side. Checking only the lower
      // end would miss the drift that matters most: a spec whose maximum is
      // loosened above the loader's own cap. The command would then accept the
      // value, print that it changed, and the loader would drop it in silence.
      if (spec.kind === "number") {
        assert.deepEqual(loadWith(key, spec.max).config[key], spec.max, `the loader refuses the highest value the spec allows for ${key}`);
        const middle = Math.round((spec.min + spec.max) / 2);
        assert.deepEqual(loadWith(key, middle).config[key], middle, `the loader refuses a value inside the range the spec allows for ${key}`);
      }

      // A value the spec refuses must also be refused by the loader, which
      // falls back to the default and says so.
      // A list has no wrong written form: any name is a list of one, so there is
      // nothing for the spec to refuse. The loader still refuses a bare string
      // in the file, which the "good" half above already covers by writing a
      // real array. Every other kind has values a person can get wrong.
      if (spec.kind === "textList") {
        continue;
      }
      const bad =
        spec.kind === "number"
          ? spec.max + 1
          : spec.kind === "flag"
            ? "maybe"
            : spec.kind === "choice"
              ? "nonsense"
              : spec.kind === "pathList"
                ? ["relative/path"]
                : spec.kind === "formatList"
                  ? [{ agentTypes: [], labels: ["X"] }]
                  : 42;
      assert.throws(() => parseSetting(key, bad), new RegExp(key), `the spec accepted a bad value for ${key}`);
      const loaded = loadWith(key, bad);
      // A bad value falls back to the default, except the mode, where the safe
      // reading is "shadow": a typing mistake must never start rewriting calls.
      const fallback = key === "mode" ? "shadow" : DEFAULTS[key];
      assert.deepEqual(loaded.config[key], fallback, `the loader kept a bad value for ${key}`);
      assert.match(loaded.warnings.join("\n"), new RegExp(key), `the loader said nothing about a bad ${key}`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseSetting reads the forms a person writes, and refuses the rest", () => {
  assert.equal(parseSetting("codexEnabled", "yes"), true);
  assert.equal(parseSetting("codexEnabled", "off"), false);
  assert.equal(parseSetting("limitGate", " 70 "), 70);
  // A choice is compared exactly, so this one fails without the trim, unlike a
  // number, which JavaScript would have converted anyway.
  assert.equal(parseSetting("mode", " shadow "), "shadow");
  assert.equal(parseSetting("mode", "shadow"), "shadow");
  assert.deepEqual(parseSetting("keepModelAgents", "a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseSetting("keepModelAgents", ""), [], "an empty value clears the list");
  assert.throws(() => parseSetting("mode", "enforcee"), /must be one of/);
  assert.throws(() => parseSetting("nope", "1"), /is not a setting/);
  assert.throws(() => parseSetting("limitGate", "high"), /must be a number from 0 to 100/);
});

// A plain object answers for names it inherits, so CONFIG_SPEC["constructor"]
// used to be truthy and those words passed as settings.
test("a name inherited from every object is not a setting", () => {
  for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
    assert.equal(settingSpec(key), undefined, `${key} must not look like a setting`);
    assert.throws(() => parseSetting(key, "x"), /is not a setting/, `${key} was accepted as a setting`);
  }
  assert.ok(settingSpec("limitGate"), "a real setting is still found");
});

// An empty value reads as the number 0, which is a real setting for several
// keys: promptLogChars 0 stops briefs being logged, limitGate 0 sends
// everything to Codex. The loader would fall back to the default instead, so
// writing 0 here would mean the file and the loader disagree.
test("an empty value is refused rather than read as zero", () => {
  for (const key of ["limitGate", "promptLogChars", "paceAfter", "kindGate"]) {
    assert.throws(() => parseSetting(key, ""), /needs a value/, `${key}= was accepted`);
    assert.throws(() => parseSetting(key, "   "), /needs a value/, `${key} with spaces was accepted`);
  }
  for (const key of ["mode", "completeRule", "codexEnabled", "jevModel"]) {
    assert.throws(() => parseSetting(key, ""), /needs a value/, `${key}= was accepted`);
  }
  assert.deepEqual(parseSetting("keepModelAgents", ""), [], "an empty list is still how a list is cleared");
});

test("show reports the defaults before a file exists, and the source of each value after", async () => {
  const { tempDir, env, file } = setUp();
  try {
    const first = await runNode(COMMAND, { args: ["show"], env });
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /not there yet, so every setting is at its default/);
    assert.match(first.stdout, /mode +"enforce" +default/);
    assert.ok(!fs.existsSync(file), "show writes nothing");

    await runNode(COMMAND, { args: ["set", "mode=shadow"], env });
    const second = await runNode(COMMAND, { args: ["show"], env });
    assert.match(second.stdout, /mode +"shadow" +file/, "a value from the file says so");
    assert.match(second.stdout, /limitGate +80 +default/);

    // A variable beats the file for one session, and the reader should see that.
    const third = await runNode(COMMAND, { args: ["show"], env: { ...env, ORCH_MODE: "off" } });
    assert.match(third.stdout, /mode +"off" +session/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("set writes only checked values, and one bad value changes nothing", async () => {
  const { tempDir, env, file } = setUp();
  try {
    const written = await runNode(COMMAND, { args: ["set", "codexEnabled=true", "limitGate=70"], env });
    assert.equal(written.code, 0, written.stderr);
    assert.match(written.stdout, /codexEnabled: false becomes true/);
    assert.deepEqual(readConfig(file), { codexEnabled: true, limitGate: 70 });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600, "the settings file is not world readable");

    // Two changes, the second impossible: the first must not land either.
    const refused = await runNode(COMMAND, { args: ["set", "mode=shadow", "limitGate=500"], env });
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /limitGate must be a number from 0 to 100/);
    assert.deepEqual(readConfig(file), { codexEnabled: true, limitGate: 70 }, "a refused command wrote nothing at all");

    const noPair = await runNode(COMMAND, { args: ["set", "modeshadow"], env });
    assert.equal(noPair.code, 2);
    assert.match(noPair.stderr, /is not a <key>=<value>/);
    // A setting this plugin does not have is a typing mistake, not a new setting.
    const unknown = await runNode(COMMAND, { args: ["set", "modus=shadow"], env });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /"modus" is not a setting/);
    assert.deepEqual(readConfig(file), { codexEnabled: true, limitGate: 70 });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("set triageProjects takes only checkout top folders, also as a JSON list, and says when a change applies", async () => {
  const { tempDir, env, file } = setUp();
  try {
    fs.mkdirSync(path.join(tempDir, "repo", "src"), { recursive: true });
    const repo = fs.realpathSync(path.join(tempDir, "repo"));
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "pipe" });
    const outside = path.join(tempDir, "plain");
    fs.mkdirSync(outside);
    const cases = [
      [path.join(tempDir, "nope"), /does not exist/],
      [outside, /is not inside a git checkout/],
      [path.join(repo, "src"), new RegExp(`is inside the checkout "${repo}"\\. List that top folder instead`)]
    ];
    for (const [entry, message] of cases) {
      const refused = await runNode(COMMAND, { args: ["set", "triageMode=log", `triageProjects=${entry}`], env });
      assert.equal(refused.code, 2, entry);
      assert.match(refused.stderr, message);
    }
    assert.equal(fs.existsSync(file), false, "a refused path wrote nothing, not even the other pair");

    const taken = await runNode(COMMAND, { args: ["set", `triageProjects=${JSON.stringify([repo])}`], env });
    assert.equal(taken.code, 0, taken.stderr);
    assert.deepEqual(readConfig(file).triageProjects, [repo]);
    assert.match(taken.stdout, /applies from the next subagent call/);
    assert.doesNotMatch(taken.stdout, /keeps its settings/);
    const unset = await runNode(COMMAND, { args: ["unset", "triageProjects"], env });
    assert.match(unset.stdout, /applies from the next subagent call/);

    // A symbolic link to the top folder is accepted, and its real path is stored.
    const link = path.join(tempDir, "link-to-repo");
    fs.symlinkSync(repo, link);
    const linked = await runNode(COMMAND, { args: ["set", `triageProjects=${link}`], env });
    assert.equal(linked.code, 0, linked.stderr);
    assert.deepEqual(readConfig(file).triageProjects, [repo]);

    // An inherited GIT_DIR makes git call any folder a top folder; it is ignored.
    const withGitDir = await runNode(COMMAND, { args: ["set", `triageProjects=${outside}`], env: { ...env, GIT_DIR: path.join(repo, ".git") } });
    assert.equal(withGitDir.code, 2);
    assert.match(withGitDir.stderr, /is not inside a git checkout/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a folder left open by an older version is tightened on the next write", async () => {
  const { tempDir, env, file } = setUp();
  try {
    await runNode(COMMAND, { args: ["set", "mode=shadow"], env });
    const folder = path.dirname(file);
    assert.equal(fs.statSync(folder).mode & 0o077, 0, "a folder this command creates is closed to others");

    // mkdirSync sets the mode only on folders it creates, so a folder that is
    // already there has to be tightened on purpose.
    fs.chmodSync(folder, 0o755);
    await runNode(COMMAND, { args: ["set", "mode=off"], env });
    assert.equal(fs.statSync(folder).mode & 0o077, 0, "an existing wide folder is tightened too");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("set keeps the keys it was not asked about, and unset puts one back to its default", async () => {
  const { tempDir, env, file } = setUp();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ limitGate: 70, somethingOfTheirOwn: "keep me" }));

    await runNode(COMMAND, { args: ["set", "mode=shadow"], env });
    assert.deepEqual(readConfig(file), { limitGate: 70, somethingOfTheirOwn: "keep me", mode: "shadow" }, "an unrelated key survives a write");

    const removed = await runNode(COMMAND, { args: ["unset", "limitGate"], env });
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /limitGate goes back to its default 80/);
    assert.deepEqual(readConfig(file), { somethingOfTheirOwn: "keep me", mode: "shadow" });

    const again = await runNode(COMMAND, { args: ["unset", "limitGate"], env });
    assert.match(again.stdout, /was not in the file/, "removing a key twice is not an error");
    const unknown = await runNode(COMMAND, { args: ["unset", "modus"], env });
    assert.equal(unknown.code, 2);

    // A good key followed by an unknown one: neither may land, the same way a
    // refused `set` writes nothing.
    const before = fs.readFileSync(file, "utf8");
    const mixed = await runNode(COMMAND, { args: ["unset", "mode", "modus"], env });
    assert.equal(mixed.code, 2);
    assert.equal(fs.readFileSync(file, "utf8"), before, "a refused unset wrote nothing at all");

    const shown = await runNode(COMMAND, { args: ["show"], env });
    assert.match(shown.stdout, /does not know, and ignores: somethingOfTheirOwn/);

    // A value the loader refuses is reported where somebody will see it.
    fs.writeFileSync(file, JSON.stringify({ limitGate: 900 }));
    const withProblem = await runNode(COMMAND, { args: ["show"], env });
    assert.match(withProblem.stdout, /Problems found while reading the settings:/);
    assert.match(withProblem.stdout, /- limitGate must be a number from 0 to 100/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a settings file that cannot be read is reported and never written over", async () => {
  const { tempDir, env, file } = setUp();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const damaged = '{"mode": "shadow",}';
    fs.writeFileSync(file, damaged);

    const shown = await runNode(COMMAND, { args: ["show"], env });
    assert.equal(shown.code, 0, "show still works, so the user can see what is wrong");
    assert.match(shown.stdout, /This file cannot be read/);

    for (const args of [["set", "mode=off"], ["unset", "mode"]]) {
      const result = await runNode(COMMAND, { args, env });
      assert.equal(result.code, 2);
      assert.match(result.stderr, /cannot be read/);
    }
    assert.equal(fs.readFileSync(file, "utf8"), damaged, "the damaged file is left exactly as it was");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a settings file that is valid JSON but not an object is refused too", async () => {
  const { tempDir, env, file } = setUp();
  try {
    // These all parse, so the syntax check above does not catch them. Writing
    // keys into an array or a string would quietly destroy the file.
    for (const contents of ["[1,2,3]", '"just a string"', "null", "42"]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);

      const shown = await runNode(COMMAND, { args: ["show"], env });
      assert.equal(shown.code, 0, `show should still work for ${contents}`);
      assert.match(shown.stdout, /This file cannot be read: the file is not a JSON object/);

      for (const args of [["set", "mode=off"], ["unset", "mode"]]) {
        const result = await runNode(COMMAND, { args, env });
        assert.equal(result.code, 2, `${args[0]} should refuse ${contents}`);
        assert.match(result.stderr, /cannot be read/);
      }
      assert.equal(fs.readFileSync(file, "utf8"), contents, `${contents} was changed`);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explain describes one setting or all of them, and changes nothing", async () => {
  const { tempDir, env, file } = setUp();
  try {
    const one = await runNode(COMMAND, { args: ["explain", "completeRule"], env });
    assert.equal(one.code, 0, one.stderr);
    assert.match(one.stdout, /allowed: one of shadow, enforce, off/);
    assert.match(one.stdout, /default: "shadow"/);

    // Every setting is listed next to its own description, not merely present
    // somewhere: a shifted column would still contain every name.
    const all = await runNode(COMMAND, { args: ["explain"], env });
    const lines = all.stdout.split("\n");
    for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
      const line = lines.find((entry) => entry.startsWith(key));
      assert.ok(line, `explain left out ${key}`);
      assert.ok(line.includes(spec.about), `explain paired ${key} with the wrong description`);
    }
    // The loop above compares each text with itself. These lines check what the
    // texts say: the user switch names the personal files and the project switch
    // the project files, both name every kind of brief that carries the snapshot,
    // and the credit switch names both Codex windows.
    const about = (key) => lines.find((entry) => entry.startsWith(key)) ?? "";
    assert.match(about("codexIncludeUserRules"), /send personal Claude instructions/);
    assert.match(about("codexIncludeProjectRules"), /send project and parent Claude instructions/);
    for (const key of ["codexIncludeUserRules", "codexIncludeProjectRules"]) {
      assert.match(about(key), /implement, custom review and consult briefs/, `${key} leaves out a kind of brief`);
    }
    assert.match(about("codexSpendCredits"), /the 5-hour or the weekly one/);
    const unknown = await runNode(COMMAND, { args: ["explain", "modus"], env });
    assert.equal(unknown.code, 2);
    assert.ok(!fs.existsSync(file), "explain writes nothing");

    const wrongCommand = await runNode(COMMAND, { args: ["destroy"], env });
    assert.equal(wrongCommand.code, 2);
    assert.match(wrongCommand.stderr, /"destroy" is not a command/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

// The "allowed" line was once built for four kinds only, and every other kind
// fell through to "a text value". The two list settings of the triage then told
// a person to write plain text where JSON or absolute paths are needed.
test("explain gives every setting that is not a text the rule of its own kind", async () => {
  const { tempDir, env } = setUp();
  try {
    const keys = Object.entries(CONFIG_SPEC)
      .filter(([, spec]) => spec.kind !== "text")
      .map(([key]) => key);
    const runs = await Promise.all(keys.map((key) => runNode(COMMAND, { args: ["explain", key], env })));
    runs.forEach((run, index) => {
      assert.equal(run.code, 0, run.stderr);
      assert.ok(!run.stdout.includes("a text value"), `explain ${keys[index]} says "a text value": ${run.stdout}`);
    });
    const allowed = (key) => runs[keys.indexOf(key)].stdout.split("\n").find((line) => line.trim().startsWith("allowed:")) ?? "";

    // The exact rule for each simple kind, built from the spec, so a setting
    // that gets the rule of another kind, or a wrong range, fails here.
    const expected = {
      choice: (spec) => `one of ${spec.values.join(", ")}`,
      number: (spec) => `a number from ${spec.min} to ${spec.max}`,
      flag: () => "true or false",
      textList: () => "a list of names, written as one comma-separated value"
    };
    const checked = {};
    for (const key of keys) {
      const spec = CONFIG_SPEC[key];
      if (!expected[spec.kind]) continue;
      assert.equal(allowed(key), `  allowed: ${expected[spec.kind](spec)}`, `explain ${key}`);
      checked[spec.kind] = (checked[spec.kind] ?? 0) + 1;
    }
    // Every kind above has at least one setting, so no check is empty.
    for (const kind of Object.keys(expected)) assert.ok(checked[kind] > 0, `no setting of the kind ${kind} was checked`);

    assert.match(allowed("triageProjects"), /absolute paths, as a JSON list or split by commas/);
    assert.match(allowed("triageProjects"), /a path that holds a comma needs the JSON form/);
    assert.match(allowed("triageProjects"), /top folder of a git checkout/);
    assert.match(allowed("reviewFormats"), /a JSON list of objects such as \[\{"agentTypes":\["my-reviewer"\],"labels":\["BLOCKING"\]\}\]/);
    assert.match(allowed("reviewFormats"), /no other key is allowed/);

    // A setting of the kind "text" keeps the plain answer.
    const text = await runNode(COMMAND, { args: ["explain", "jevModel"], env });
    assert.match(text.stdout, /allowed: a text value/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the triage settings default to off, an empty list and no projects", () => {
  const { config } = loadConfig({ ORCH_DATA_DIR: makeTempDir("orch-config-triage-"), PATH: process.env.PATH });
  assert.equal(config.triageMode, "off");
  assert.deepEqual(config.reviewFormats, []);
  assert.deepEqual(config.triageProjects, []);
  assert.equal(config.triageWorktrees, false);
});

function loadFile(values) {
  const dataDir = makeTempDir("orch-config-triage-");
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(values));
  return loadConfig({ ORCH_DATA_DIR: dataDir, PATH: process.env.PATH });
}

test("triageMode keeps log, and refuses annotate until it is built", () => {
  assert.equal(loadFile({ triageMode: "log" }).config.triageMode, "log");
  const annotate = loadFile({ triageMode: "annotate" });
  assert.equal(annotate.config.triageMode, "off");
  assert.match(annotate.warnings.join("\n"), /annotate.*not built yet/);
});

test("reviewFormats keeps good entries and drops each bad one with a warning", () => {
  const good = { agentTypes: ["acme:review-bot"], labels: ["MUST-FIX"], emptyPhrases: ["no findings"] };
  const { config, warnings } = loadFile({
    reviewFormats: [good, { agentTypes: [], labels: ["X"] }, { agentTypes: ["a"], labels: [3] }, { agentTypes: ["a"], labels: ["X"], extra: 1 }]
  });
  assert.deepEqual(config.reviewFormats, [good]);
  assert.equal(warnings.filter((w) => /reviewFormats/.test(w)).length, 3);
});

test("parseSetting reads reviewFormats as JSON and refuses bad JSON with a sentence", () => {
  assert.deepEqual(parseSetting("reviewFormats", '[{"agentTypes":["x"],"labels":["BLOCKING"]}]'), [{ agentTypes: ["x"], labels: ["BLOCKING"] }]);
  assert.throws(() => parseSetting("reviewFormats", "[{"), /reviewFormats must be JSON/);
});

test("triageProjects keeps absolute paths and drops the rest with a warning", () => {
  const { config, warnings } = loadFile({ triageProjects: ["/a/b", "rel/c"] });
  assert.deepEqual(config.triageProjects, ["/a/b"]);
  assert.match(warnings.join("\n"), /triageProjects/);
  assert.deepEqual(parseSetting("triageProjects", "/a,/b"), ["/a", "/b"]);
  // The JSON form, which a path with a comma needs.
  assert.deepEqual(parseSetting("triageProjects", '["/a,b", "/c"]'), ["/a,b", "/c"]);
  assert.throws(() => parseSetting("triageProjects", '["/a"'), /not valid JSON/);
  assert.throws(() => parseSetting("triageProjects", '["rel"]'), /absolute paths/);
});
