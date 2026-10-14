// A sandbox exclusion entry lets a command run with the owner's full access.
// It is safe only for a plugin copy that no sandboxed command can change. Two
// kinds of copy pass:
// - a copy in the plugin cache of the Claude config folder. The Claude sandbox
//   denies writes to that folder for every session, whatever its working folder.
// - a copy that root owns, with every folder above it and every script it
//   loads, and that no group or other user can write.
// A working checkout fails both, because a session in it can change the code.
// These checks read file modes and paths only. They run no program.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The worker commands that need to leave the sandbox. The agent files run
// `node "${CLAUDE_PLUGIN_ROOT}/scripts/orch-codex.mjs" run <request id>`, and
// Claude Code fills in the root before the model writes the command. So an
// entry must hold the filled-in path. An entry with the variable text matches
// no worker call.
const WORKER_COMMANDS = ["run", "wait", "cancel"];

// The cache counts only in the default config folder. CLAUDE_CONFIG_DIR is an
// environment value, so it must not choose which folder is trusted. A copy in
// another config folder then counts as not protected, which only stops the
// worker.
const REAL_FS = {
  lstat: (file) => fs.lstatSync(file),
  readdir: (dir) => fs.readdirSync(dir),
  realpath: (file) => fs.realpathSync(file),
  configDir: () => path.join(os.homedir(), ".claude")
};

// A root-owned copy is walked whole, .git included. More entries than this
// means the copy is not checked, so not protected.
const MAX_ENTRIES = 50000;

// The exclusion entries for the worker commands of the copy at `root`, with
// the same quoting as the agent call.
export function workerEntries(root) {
  const script = path.join(root, "scripts", "orch-codex.mjs");
  return WORKER_COMMANDS.map((command) => `node "${script}" ${command} *`);
}

// { kind, problem }: kind is "cache" or "root" for a protected copy, and null
// with the reason in `problem` otherwise. A copy that cannot be checked is not
// protected.
export function copyProtection(root, files = REAL_FS) {
  try {
    const real = files.realpath(root);
    if (real !== path.resolve(root)) return { kind: null, problem: `${root} goes through a symbolic link` };
    if (inPluginCache(real, files)) {
      // The cache is write-denied for sandboxed commands, but a link in it to a
      // checkout, or a file that others can write, would undo that.
      const problem = walk(real, files, (file) => linkOrShared(file, files));
      return problem ? { kind: null, problem: `it is in the Claude plugin cache, but ${problem}` } : { kind: "cache", problem: null };
    }
    // A folder above the copy that someone else can write could swap the copy.
    for (let dir = real; ; dir = path.dirname(dir)) {
      const problem = unsafe(dir, files);
      if (problem) return { kind: null, problem: `it is outside the Claude plugin cache, and ${problem}` };
      if (path.dirname(dir) === dir) break;
    }
    // Every file and folder in the copy: the scripts, but also package.json,
    // which Node reads when it loads them, and anything a later file could load.
    const problem = walk(real, files, (file) => unsafe(file, files));
    return problem ? { kind: null, problem: `it is outside the Claude plugin cache, and ${problem}` } : { kind: "root", problem: null };
  } catch (error) {
    return { kind: null, problem: `it cannot be checked (${error.code ?? error.message})` };
  }
}

// True when the real path of the copy lies in <config folder>/plugins/cache/.
function inPluginCache(real, files) {
  let cache;
  try {
    cache = files.realpath(path.join(files.configDir(), "plugins", "cache"));
  } catch {
    return false;
  }
  return real.startsWith(cache + path.sep);
}

// The first problem that `check` finds in the copy, walking every folder, or
// null. More entries than MAX_ENTRIES count as a problem.
function walk(real, files, check) {
  const pending = [real];
  let seen = 0;
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const name of files.readdir(dir)) {
      seen += 1;
      if (seen > MAX_ENTRIES) return `it holds more than ${MAX_ENTRIES} files, so it was not checked`;
      const file = path.join(dir, name);
      const problem = check(file);
      if (problem) return problem;
      if (files.lstat(file).isDirectory()) pending.push(file);
    }
  }
  return null;
}

function linkOrShared(file, files) {
  const stat = files.lstat(file);
  if (stat.isSymbolicLink()) return `${file} is a symbolic link`;
  if ((stat.mode & 0o022) !== 0) return `${file} can be written by its group or by other users`;
  return null;
}

function unsafe(file, files) {
  const shared = linkOrShared(file, files);
  if (shared) return shared;
  if (files.lstat(file).uid !== 0) return `${file} is not owned by root`;
  return null;
}

// True for the two errors that a refused write gives: EPERM (the Claude
// sandbox denies it) and EACCES (the file modes deny it). Any other error, and
// a value that is not an error, gives false.
export function isPermissionError(error) {
  return error?.code === "EPERM" || error?.code === "EACCES";
}

// The text for a `run` whose request claim failed with a permission error.
// The rename failed, so the request file is unchanged and the same command
// works later. It names entries only for a protected copy: it never tells the
// owner to exclude a copy that a session can change.
export function claimRefusedMessage(id, code, root, files = REAL_FS) {
  const { kind, problem } = copyProtection(root, files);
  const lines = [
    `the request ${id} could not be claimed (${code}), so no Codex job started and the request is unchanged.`,
    "The likely cause: this command ran inside the Claude sandbox, which does not let it write the router's data folder. Other file permissions can cause the same error."
  ];
  if (kind) {
    lines.push(
      `This plugin copy (${root}) is protected. The owner can let the worker commands leave the sandbox with these entries in sandbox.excludedCommands:`,
      ...workerEntries(root).map((entry) => `  ${entry}`)
    );
    if (kind === "cache") lines.push("The entries name this version's folder, so they need the new path after each plugin update.");
  } else {
    lines.push(`This plugin copy (${root}) must not leave the sandbox, because ${problem}. An excluded command runs with full access, so an entry is safe only for a copy that no session can change. See guide/codex.md, section "The Claude sandbox".`);
  }
  lines.push("Do not retry outside the sandbox. Use a Claude worker for this task now. After the owner's fix, the same run command works.");
  return lines.join("\n");
}

// True when an excludedCommands entry matches a call. Entries use the syntax of
// a Bash(...) permission rule: "*" matches any text, and a trailing " *" also
// matches the command with no arguments.
export function entryMatches(entry, call) {
  const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  let source = entry.split("*").map(escape).join(".*");
  if (entry.endsWith(" *")) source = `${source.slice(0, -" .*".length)}(?: .*)?`;
  return new RegExp(`^${source}$`, "s").test(call);
}

// For run, wait and cancel: a sample call of the copy at `root`, and the
// entries of the list that match it, broad ones included. Only the run call
// needs the claim; wait and cancel follow it.
export function workerCoverage(root, excludedCommands) {
  const listed = Array.isArray(excludedCommands) ? excludedCommands.filter((entry) => typeof entry === "string") : [];
  const script = path.join(root, "scripts", "orch-codex.mjs");
  const samples = { run: "req-0123456789ab", wait: "20261014-120000-abcdef", cancel: "20261014-120000-abcdef" };
  return workerEntries(root).map((entry, index) => {
    const command = WORKER_COMMANDS[index];
    const call = `node "${script}" ${command} ${samples[command]}`;
    return { command, entry, coveredBy: listed.filter((item) => entryMatches(item, call)) };
  });
}

// Entries that also let implement, review or consult of the copy at `root`
// leave the sandbox. These commands take a task text and a file from the
// session, so the guide keeps them inside; a broad entry lets them out.
export function broadEntries(root, excludedCommands) {
  const listed = Array.isArray(excludedCommands) ? excludedCommands.filter((entry) => typeof entry === "string") : [];
  const script = path.join(root, "scripts", "orch-codex.mjs");
  const calls = ["implement --brief brief.md", "review --custom --brief brief.md", "consult --brief brief.md"].map((rest) => `node "${script}" ${rest}`);
  return listed.filter((entry) => calls.some((call) => entryMatches(entry, call)));
}

// Entries that hold the unexpanded variable: they match no worker call.
export function deadVariableEntries(excludedCommands) {
  return (Array.isArray(excludedCommands) ? excludedCommands : []).filter((entry) => typeof entry === "string" && entry.includes("${CLAUDE_PLUGIN_ROOT}") && entry.includes("orch-codex.mjs"));
}

// The rows of the "Codex worker sandbox" check in setup-check, as
// [status, detail] pairs. It reads no file: `kind` and `problem` come from
// copyProtection, `coverage` from workerCoverage and `dead` from
// deadVariableEntries and `broad` from broadEntries. `unreadable` lists the
// settings files that exist but could not be used, as { file, json: true } for
// text that is not valid JSON, or { file, code } for a read error.
export function sandboxRows({ root, kind, problem, coverage, dead = [], broad = [], unreadable = [] }) {
  const rows = [];
  for (const { file, json, code } of unreadable) {
    const how = json ? "as JSON" : `(${code})`;
    rows.push(["WARN", `the settings file ${file} could not be read ${how}, so this check counted none of its sandbox.excludedCommands entries`]);
  }
  for (const entry of dead) {
    rows.push(["WARN", `the entry ${entry} matches no worker call, because Claude Code fills in the path before the worker writes its command. Remove it`]);
  }
  // On a copy that a session can change, the covering row below says it all.
  if (kind && broad.length > 0) {
    rows.push(["WARN", `these entries also let implement, review or consult leave the sandbox: ${broad.join(" ; ")}. Those commands send a text and a file that the session chooses, so keep only the entries for run, wait and cancel`]);
  }
  // Entries are patterns, so a broad one (node "<copy>/scripts/orch-codex.mjs" *)
  // covers the worker calls too.
  const covering = [...new Set(coverage.flatMap((item) => item.coveredBy))];
  const missing = coverage.filter((item) => item.coveredBy.length === 0).map((item) => item.entry);
  if (!kind && covering.length > 0) {
    rows.push(["WARN", `these exclusion entries cover this copy (${root}): ${covering.join(" ; ")}. But ${problem}. Remove them: a session could change code that then runs with full access`]);
  } else if (!kind) {
    rows.push(["OK", `this copy (${root}) gets no sandbox exclusion, because ${problem}. In a session with the Claude sandbox on, Codex workers stop and say so. guide/codex.md, section "The Claude sandbox", names the copies that can be excluded`]);
  } else if (missing.length > 0) {
    rows.push(["WARN", `this copy is protected, but these sandbox.excludedCommands entries are missing: ${missing.join(" ; ")}. In a session with the Claude sandbox on, Codex workers stop until they are added`]);
  } else {
    const strength = kind === "cache" ? "in the plugin cache, so as safe as the sandbox of every session and every program that runs with your rights" : "owned by root";
    rows.push(["OK", `this copy is protected (${strength}), and the entries for run, wait and cancel are in the settings. This reads the settings only. In Manual mode, a prompt titled "Bash command (unsandboxed)" confirms an entry`]);
  }
  return rows;
}
