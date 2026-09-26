// OS boundaries for executable evaluations. These wrap the whole child, not
// just its shell tool. Failure to start the sandbox never starts a bare child.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function real(directory) {
  return fs.realpathSync(directory);
}

function quote(value) {
  return JSON.stringify(value);
}

export function boundaryCommand(argv, { writable = [], readable = null, deniedReads = [], emptyDirectory, network = false, platform = process.platform }) {
  const writes = writable.map(real);
  const reads = readable?.map(real);
  if (platform === "darwin") {
    const rules = ["(version 1)", "(allow default)", "(deny file-write*)", "(deny signal)", "(allow signal (target same-sandbox))"];
    if (!network) rules.push("(deny network*)");
    if (reads) {
      rules.push("(deny file-read*)");
      // Runtime libraries and OS metadata. No home folder or broad /tmp read.
      for (const directory of ["/System", "/usr", "/bin", "/sbin", "/Library/Apple", "/private/var/db", "/dev", ...reads, ...writes]) {
        rules.push(`(allow file-read* (subpath ${quote(directory)}))`);
      }
      rules.push('(allow file-read* (literal "/") (literal "/private") (literal "/private/tmp") (literal "/etc/localtime"))');
      const ancestors = new Set();
      for (const directory of [...reads, ...writes]) {
        for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) ancestors.add(parent);
      }
      for (const directory of ancestors) rules.push(`(allow file-read-metadata (literal ${quote(directory)}))`);
    }
    for (const directory of writes) rules.push(`(allow file-write* (subpath ${quote(directory)}))`);
    for (const file of deniedReads) rules.push(`(deny file-read* (subpath ${quote(real(file))}))`);
    rules.push('(allow file-write* (literal "/dev/null"))');
    return { backend: "seatbelt", argv: ["/usr/bin/sandbox-exec", "-p", rules.join("\n"), ...argv] };
  }
  if (platform === "linux") {
    const bin = ["/usr/bin/bwrap", "/bin/bwrap"].find((file) => fs.existsSync(file));
    if (!bin) throw new Error("executable evaluation needs bubblewrap (bwrap); no unconfined fallback is allowed");
    const args = ["--die-with-parent", "--new-session", "--unshare-all"];
    if (network) args.push("--share-net");
    if (reads) {
      for (const directory of ["/usr", "/bin", "/sbin", "/lib", "/lib64", ...reads]) {
        if (fs.existsSync(directory)) args.push("--ro-bind", directory, directory);
      }
      args.push("--proc", "/proc", "--dev", "/dev");
    } else {
      args.push("--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev");
    }
    for (const directory of writes) args.push("--bind", directory, directory);
    for (const file of deniedReads) {
      const target = real(file);
      args.push("--ro-bind", fs.statSync(target).isDirectory() ? real(emptyDirectory) : "/dev/null", target);
    }
    return { backend: "bubblewrap", argv: [bin, ...args, "--", ...argv] };
  }
  throw new Error(`executable evaluation has no execution boundary for ${platform}`);
}

// The grader does not inherit credentials, NODE_OPTIONS, shell startup files,
// or provider configuration. PATH remains available for ordinary test tools.
export function gradingEnvironment(scratch, env = process.env) {
  return { PATH: env.PATH || "/usr/bin:/bin", HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch, LANG: "C", LC_ALL: "C" };
}

export function wrapInvocation(invocation, options) {
  const boundary = boundaryCommand(invocation.argv, options);
  return { ...invocation, argv: boundary.argv, boundary: boundary.backend };
}

export function checkBoundary(options, scratch) {
  const command = boundaryCommand([process.execPath, "-e", "process.exit(0)"], options);
  const check = spawnSync(command.argv[0], command.argv.slice(1), {
    cwd: scratch, env: gradingEnvironment(scratch), encoding: "utf8", timeout: 10000, maxBuffer: 16384
  });
  if (check.error || check.status !== 0) {
    // Do not echo arbitrary child output: it can contain local sensitive data.
    throw new Error(`execution boundary ${command.backend} is unavailable (exit ${check.status ?? "unknown"}); no worker was started`);
  }
  return command.backend;
}

export function nodeRuntimeDirectory() {
  return path.dirname(real(process.execPath));
}
