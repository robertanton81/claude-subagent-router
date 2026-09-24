#!/usr/bin/env node
// Reads and writes the plugin's settings file, so nobody has to hand-edit JSON.
// The skill orchestrator:configure drives this from a session, and a person can
// run it directly.
//
//   node scripts/orch-config.mjs show
//   node scripts/orch-config.mjs set codexEnabled=true limitGate=70
//   node scripts/orch-config.mjs unset limitGate
//   node scripts/orch-config.mjs explain completeRule
//
// Every value is checked before anything is written, and one bad value writes
// nothing at all. The file holds no secrets: the classifier key lives outside it,
// so nothing here prints or accepts a key.
//
// This file always runs its main function. It has no "am I the entry script"
// check, because such a check breaks for plugin paths with spaces and under
// symbolic links.

import fs from "node:fs";
import path from "node:path";

import { CONFIG_SPEC, DEFAULTS, dataDir, loadConfig, parseSetting, settingSpec } from "./lib/config.mjs";
import { ensurePrivateDir } from "./lib/log.mjs";

const USAGE = `Usage:
  node scripts/orch-config.mjs show
  node scripts/orch-config.mjs set <key>=<value> [<key>=<value> ...]
  node scripts/orch-config.mjs unset <key> [<key> ...]
  node scripts/orch-config.mjs explain [<key>]
`;

function configPath(env = process.env) {
  return path.join(dataDir(env), "config.json");
}

// The file as it stands. A file that cannot be read is reported rather than
// overwritten, because it may hold settings somebody meant to keep.
function readFile(file) {
  if (!fs.existsSync(file)) {
    return { exists: false, values: {} };
  }
  const raw = fs.readFileSync(file, "utf8");
  let values;
  try {
    values = JSON.parse(raw);
  } catch (error) {
    return { exists: true, unreadable: true, detail: error.message, values: {} };
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return { exists: true, unreadable: true, detail: "the file is not a JSON object", values: {} };
  }
  return { exists: true, values };
}

// Writes through a temporary file in the same folder, so an interrupted write
// cannot leave a half-written settings file behind.
function writeFile(file, values) {
  // `mkdirSync` sets the mode only on folders it creates, so a folder that is
  // already there with a wider mode would stay wide. The log hook uses the same
  // helper for the same reason.
  ensurePrivateDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// The variables that override the file for one session. Reading the settings
// once without them shows what the file alone would give, which is the only way
// to tell "this came from the file" from "a variable is overriding the file".
const SESSION_VARIABLES = ["ORCH_MODE", "ORCH_COMPLETE_RULE", "ORCH_JEV_TIMEOUT_MS", "ORCH_TYPESAFE_URL", "ORCH_CODEX_ENABLED", "ORCH_JEV_ENABLED", "ORCH_ROUTE_OTHER_AGENTS"];

function show(env) {
  const file = configPath(env);
  const onDisk = readFile(file);
  const { config, warnings } = loadConfig(env);
  const withoutSession = { ...env };
  for (const name of SESSION_VARIABLES) {
    delete withoutSession[name];
  }
  const fromFileOnly = loadConfig(withoutSession).config;
  const out = [`Settings file: ${file}${onDisk.exists ? "" : " (not there yet, so every setting is at its default)"}`];
  if (onDisk.unreadable) {
    out.push(`This file cannot be read: ${onDisk.detail}`);
    out.push("Nothing will be written over it. Fix it by hand, or move it aside and set the values again.");
  }
  out.push("");
  out.push("key                        in use        source    default");
  for (const key of Object.keys(CONFIG_SPEC)) {
    const value = JSON.stringify(config[key]);
    // A variable that overrides the file must not be reported as the file, or
    // someone would edit the file and wonder why nothing changed.
    const overridden = JSON.stringify(config[key]) !== JSON.stringify(fromFileOnly[key]);
    const inFile = Object.prototype.hasOwnProperty.call(onDisk.values, key);
    const source = overridden ? "session" : inFile ? "file" : "default";
    out.push(`${key.padEnd(26)} ${value.padEnd(13)} ${source.padEnd(9)} ${JSON.stringify(DEFAULTS[key])}`);
  }
  const unknown = Object.keys(onDisk.values).filter((key) => !settingSpec(key));
  if (unknown.length > 0) {
    out.push("");
    out.push(`Keys in the file that this plugin does not know, and ignores: ${unknown.join(", ")}`);
  }
  if (warnings.length > 0) {
    out.push("");
    out.push("Problems found while reading the settings:");
    for (const warning of warnings) {
      out.push(`- ${warning}`);
    }
  }
  return out.join("\n");
}

function explain(key) {
  if (key === undefined) {
    return Object.entries(CONFIG_SPEC)
      .map(([name, spec]) => `${name.padEnd(26)} ${spec.about}`)
      .join("\n");
  }
  const spec = settingSpec(key);
  if (!spec) {
    throw new Error(`"${key}" is not a setting of this plugin.`);
  }
  const allowed =
    spec.kind === "choice"
      ? `one of ${spec.values.join(", ")}`
      : spec.kind === "number"
        ? `a number from ${spec.min} to ${spec.max}`
        : spec.kind === "flag"
          ? "true or false"
          : spec.kind === "textList"
            ? "a list of names, written as one comma-separated value"
            : "a text value";
  return [`${key}`, `  ${spec.about}`, `  allowed: ${allowed}`, `  default: ${JSON.stringify(DEFAULTS[key])}`].join("\n");
}

function set(pairs, env) {
  if (pairs.length === 0) {
    throw new Error("give at least one <key>=<value>.");
  }
  const file = configPath(env);
  const onDisk = readFile(file);
  if (onDisk.unreadable) {
    throw new Error(`the settings file cannot be read (${onDisk.detail}), so nothing was changed. Fix it by hand, or move it aside.`);
  }
  // Check everything first. One bad value must not leave half the changes applied.
  const wanted = [];
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at < 1) {
      throw new Error(`"${pair}" is not a <key>=<value>.`);
    }
    const key = pair.slice(0, at).trim();
    wanted.push({ key, value: parseSetting(key, pair.slice(at + 1)) });
  }
  const values = { ...onDisk.values };
  const changes = [];
  for (const { key, value } of wanted) {
    const before = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : DEFAULTS[key];
    values[key] = value;
    changes.push(
      JSON.stringify(before) === JSON.stringify(value)
        ? `${key} stays ${JSON.stringify(value)}`
        : `${key}: ${JSON.stringify(before)} becomes ${JSON.stringify(value)}`
    );
  }
  writeFile(file, values);
  return [`Written to ${file}:`, ...changes.map((line) => `- ${line}`), "", "A session that is already open keeps its settings until it starts again."].join("\n");
}

function unset(keys, env) {
  if (keys.length === 0) {
    throw new Error("give at least one key.");
  }
  const file = configPath(env);
  const onDisk = readFile(file);
  if (onDisk.unreadable) {
    throw new Error(`the settings file cannot be read (${onDisk.detail}), so nothing was changed.`);
  }
  const values = { ...onDisk.values };
  const changes = [];
  for (const key of keys) {
    if (!settingSpec(key)) {
      throw new Error(`"${key}" is not a setting of this plugin.`);
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      delete values[key];
      changes.push(`${key} goes back to its default ${JSON.stringify(DEFAULTS[key])}`);
    } else {
      changes.push(`${key} was not in the file, so it already had its default ${JSON.stringify(DEFAULTS[key])}`);
    }
  }
  writeFile(file, values);
  return [`Written to ${file}:`, ...changes.map((line) => `- ${line}`)].join("\n");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const env = process.env;
  switch (command) {
    case "show":
    case undefined:
      process.stdout.write(`${show(env)}\n`);
      return;
    case "explain":
      process.stdout.write(`${explain(rest[0])}\n`);
      return;
    case "set":
      process.stdout.write(`${set(rest, env)}\n`);
      return;
    case "unset":
      process.stdout.write(`${unset(rest, env)}\n`);
      return;
    default:
      process.stderr.write(`orch-config: "${command}" is not a command.\n${USAGE}`);
      process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`orch-config: ${error?.message ?? error}\n`);
  process.exitCode = 2;
}
