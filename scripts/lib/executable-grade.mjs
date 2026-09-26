import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkBoundary, gradingEnvironment, nodeRuntimeDirectory, wrapInvocation } from "./execution-boundary.mjs";

const MAX_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const LIBRARY = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_WORKER = path.resolve(LIBRARY, "../snapshot-worker.mjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function loadVerification(value, base, cwd) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !["script", "timeoutS"].includes(key)) ||
      typeof value.script !== "string" || !value.script.endsWith(".mjs")) {
    throw new Error("verify needs a trusted external .mjs script and optional timeoutS");
  }
  const script = fs.realpathSync(path.resolve(base, value.script));
  if (within(fs.realpathSync(cwd), script)) throw new Error("verify.script must be outside the worker source tree");
  const stat = fs.statSync(script);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("verify.script must be a file of at most 1 MiB");
  const timeoutS = value.timeoutS ?? 30;
  if (!Number.isFinite(timeoutS) || timeoutS <= 0 || timeoutS > 600) throw new Error("verify.timeoutS must be above 0 and at most 600");
  return { script, timeoutS, sha256: hash(fs.readFileSync(script)) };
}

// No symlinks, hard links, devices or sockets can cross the snapshot boundary.
// Limits keep a faulty worker from making the parent read unbounded output.
export function snapshotTree(root, destination = null) {
  if (!fs.lstatSync(root).isDirectory()) throw new Error("verification workspace is not a directory");
  const digest = createHash("sha256");
  let bytes = 0;
  let entries = 0;
  function visit(relative) {
    const directory = path.join(root, relative);
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = path.join(relative, name);
      const source = path.join(root, rel);
      const stat = fs.lstatSync(source);
      if (++entries > MAX_ENTRIES) throw new Error("verification workspace exceeds 10000 entries");
      if (stat.isDirectory()) {
        digest.update(JSON.stringify([rel, "directory"]) + "\n");
        if (destination) fs.mkdirSync(path.join(destination, rel), { mode: 0o700 });
        visit(rel);
      } else if (stat.isFile() && stat.nlink === 1) {
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw new Error("verification workspace exceeds 100 MiB");
        const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let contents;
        try {
          const opened = fs.fstatSync(fd);
          if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== stat.size || opened.nlink !== 1) throw new Error("workspace changed during snapshot");
          contents = Buffer.alloc(stat.size);
          let offset = 0;
          while (offset < contents.length) {
            const count = fs.readSync(fd, contents, offset, contents.length - offset, offset);
            if (count === 0) throw new Error("workspace changed during snapshot");
            offset += count;
          }
        } finally { fs.closeSync(fd); }
        digest.update(JSON.stringify([rel, stat.mode & 0o777, hash(contents)]) + "\n");
        if (destination) {
          const target = path.join(destination, rel);
          fs.writeFileSync(target, contents, { mode: stat.mode & 0o777, flag: "wx" });
          // Creation applies umask; the snapshot must retain the exact mode
          // hashed above, including group write permission.
          fs.chmodSync(target, stat.mode & 0o777);
        }
      } else {
        throw new Error("verification workspace contains a link or special file");
      }
    }
  }
  if (destination) fs.mkdirSync(destination, { mode: 0o700 });
  visit("");
  return digest.digest("hex");
}

// A worker may leave a process that changes paths during traversal. Copy and
// hash in a separate OS sandbox so even a directory-symlink race cannot make
// the parent read a host credential or copy it into the grading snapshot.
export function confinedSnapshot(workspace, control, destination = null) {
  if (!fs.lstatSync(workspace).isDirectory()) throw new Error("snapshot root is not a directory");
  const invocation = wrapInvocation({ argv: [process.execPath, SNAPSHOT_WORKER, workspace, ...(destination ? [destination] : [])],
    cwd: control, env: gradingEnvironment(control) }, {
    writable: destination ? [control] : [], readable: [workspace, control, path.dirname(LIBRARY), nodeRuntimeDirectory()], network: false
  });
  const result = spawnSync(invocation.argv[0], invocation.argv.slice(1), { cwd: invocation.cwd, env: invocation.env,
    encoding: "utf8", timeout: 30000, maxBuffer: 16384 });
  if (result.error || result.status !== 0 || !/^[a-f0-9]{64}\n$/.test(result.stdout)) throw new Error("confined snapshot failed");
  return result.stdout.trim();
}

export function prepareVerification(task, runDir, workspace, dataDir, { protectedRoot = path.join(runDir, "verification"), protectedScripts = [] } = {}) {
  runDir = fs.realpathSync(runDir);
  fs.mkdirSync(protectedRoot, { mode: 0o700, recursive: true });
  protectedRoot = fs.realpathSync(protectedRoot);
  const control = fs.mkdtempSync(path.join(protectedRoot, "grade-"));
  const scratch = path.join(runDir, "worker-tmp");
  const gradeScratch = path.join(control, "tmp");
  fs.mkdirSync(scratch, { mode: 0o700 });
  fs.mkdirSync(gradeScratch, { mode: 0o700 });
  const script = path.join(control, "grader.mjs");
  const source = fs.readFileSync(task.verify.script);
  if (hash(source) !== task.verify.sha256) throw new Error("verification script changed after loading the task set");
  fs.writeFileSync(script, source, { mode: 0o600, flag: "wx" });
  const emptyDirectory = path.join(runDir, "hidden");
  fs.mkdirSync(emptyDirectory, { mode: 0o700 });
  const workerOptions = { writable: [workspace, dataDir, scratch], deniedReads: [...new Set([protectedRoot, task.verify.script, ...protectedScripts])], emptyDirectory, network: true };
  const gradeOptions = { writable: [gradeScratch], readable: [control, nodeRuntimeDirectory()], network: false };
  const backend = checkBoundary(workerOptions, scratch);
  checkBoundary(gradeOptions, gradeScratch);
  snapshotTree(workspace);
  return { control, scratch, gradeScratch, script, workerOptions, backend };
}

export function boundWorker(invocation, prepared) {
  const env = {};
  // Keep runtime paths, subscription authentication and router settings. Do
  // not inherit unrelated service credentials or code-injection variables.
  for (const [name, value] of Object.entries(invocation.env)) {
    if (["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "CLAUDE_CODE_OAUTH_TOKEN", "TYPESAFE_API_KEY", "CLAUDE_PLUGIN_OPTION_TYPESAFE_API_KEY"].includes(name) ||
        name.startsWith("LC_") || name.startsWith("ORCH_") || ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"].includes(name)) env[name] = value;
  }
  Object.assign(env, { TMPDIR: prepared.scratch, TMP: prepared.scratch, TEMP: prepared.scratch });
  return wrapInvocation({ ...invocation, env }, prepared.workerOptions);
}

export async function verifyWorkspace(task, workspace, prepared, runProcess) {
  const evidence = { version: 1, status: "error", directory: prepared.control, grader_sha256: task.verify.sha256, timeout_s: task.verify.timeoutS, backend: prepared.backend };
  try {
    const snapshot = path.join(prepared.control, "workspace");
    evidence.workspace_sha256 = confinedSnapshot(workspace, prepared.control, snapshot);
    if (confinedSnapshot(workspace, prepared.control) !== evidence.workspace_sha256 || snapshotTree(snapshot) !== evidence.workspace_sha256) throw new Error("workspace changed during snapshot");
    const argv = [process.execPath, prepared.script, snapshot];
    const invocation = wrapInvocation({ argv, cwd: snapshot, env: gradingEnvironment(prepared.gradeScratch) }, {
      writable: [prepared.gradeScratch], readable: [prepared.control, nodeRuntimeDirectory()], network: false
    });
    const outcome = await runProcess(invocation, { timeoutMs: task.verify.timeoutS * 1000 });
    Object.assign(evidence, { command: argv, exit_code: outcome.code, signal: outcome.signal, timed_out: outcome.timedOut, duration_ms: outcome.durationMs,
      output_sha256: hash(`${outcome.stdout}\n${outcome.stderr}`) });
    if (snapshotTree(snapshot) !== evidence.workspace_sha256 || confinedSnapshot(workspace, prepared.control) !== evidence.workspace_sha256) evidence.status = "stale";
    else if (outcome.spawnError) evidence.status = "error";
    else evidence.status = outcome.code === 0 && !outcome.timedOut && !outcome.outputLimit ? "passed" : "failed";
  } catch {
    // Detailed file content and child output are intentionally absent. The
    // evidence remains an explicit infrastructure error, never a passing grade.
    evidence.status = "error";
    evidence.reason = "snapshot or grading setup failed; no verified result is available";
  }
  fs.writeFileSync(path.join(prepared.control, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return evidence;
}

export function gradeVerification(record, task) {
  const evidence = record.verification;
  if (!evidence || evidence.version !== 1 || evidence.grader_sha256 !== task.verify.sha256 || evidence.timeout_s !== task.verify.timeoutS) return { pass: false, detail: "missing or mismatched executable evidence" };
  try {
    const control = evidence.directory;
    if (hash(fs.readFileSync(task.verify.script)) !== evidence.grader_sha256 || confinedSnapshot(record.cwd, control) !== evidence.workspace_sha256) return { pass: false, detail: "stale executable evidence" };
  } catch { return { pass: false, detail: "executable evidence cannot be revalidated" }; }
  return { pass: evidence.status === "passed" && evidence.exit_code === 0 && !evidence.timed_out, detail: evidence.status };
}
