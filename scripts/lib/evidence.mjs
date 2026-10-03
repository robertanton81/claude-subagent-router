// scripts/lib/evidence.mjs
// Finds the code that a review finding cites and reads a small excerpt of it.
// Only regular files inside the session's git root, never a credential file,
// and never a file that holds a private key.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { holdsPrivateKey, isSensitivePath, redactSecrets } from "./secret-patterns.mjs";

// Version 3: a private key anywhere in a file holds back every excerpt of it,
// the SubagentStop path never reads a file that git ignores, more credential
// file names are refused, and more secret assignments are masked. Also: the
// whole file is masked before the window is cut, a citation of a credential
// file holds back its whole finding, and a file with a NUL byte anywhere is
// not read.
// Version 4: the type of an annotated assignment is masked too. Version 3 ran
// live for about an hour on 2026-10-03, so its results must not pool with
// these.
export const EVIDENCE_VERSION = 4;
const CONTEXT_LINES = 20;
const MAX_LINES = 120;
const MAX_BYTES = 1024 * 1024;

// Delimited targets may hold spaces: [text](path:line) and `path:line`.
const LINKED = /\]\(([^)\n]+?):(\d+)(?:\s*[-–]\s*(\d+))?\)/g;
const TICKED = /`([^`\n]+?):(\d+)(?:\s*[-–]\s*(\d+))?`/g;
// Bare targets have no spaces, and need no file extension (Dockerfile:10).
const BARE = /(?:^|[\s(\[,'"—])((?:\/|\.{1,2}\/)?[\w.@/-]*[\w@-]):(\d+)(?:\s*[-–]\s*(\d+))?(?![\w/])/g;

// Git reads its location from variables such as GIT_DIR and GIT_COMMON_DIR
// before it looks at the folder. One of them, inherited by a hook, would make
// every folder look like the same repository, so the consent check would pass
// for code the user never listed. Every GIT_ variable is left out.
// A repository's own settings can also make git run a program (for example
// core.fsmonitor during git status), and git runs before consent is checked.
// So no key reaches git either: no plugin option and no API key variable.
const KEY_VARIABLE = /^(CLAUDE_PLUGIN_OPTION_|.*_API_KEY$)/;

function gitEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") && !KEY_VARIABLE.test(name)));
}

// True when the text holds anything that findCitations could read as a
// location: a Markdown link, a ticked path or a bare one, also a file name
// without an extension (Dockerfile:12).
export function hasCitationShape(text) {
  return [LINKED, TICKED, BARE].some((pattern) => new RegExp(pattern.source).test(text));
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitError(error) {
  if (error?.code === "ENOENT") return "git_missing";
  if (error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM") return "timeout";
  const stderr = String(error?.stderr ?? "");
  if (/not a git repository/i.test(stderr)) return "not_a_repo";
  if (/unknown revision|ambiguous argument 'HEAD'|does not have any commits|Needed a single revision/i.test(stderr)) return "no_commit";
  return "failed";
}

// gitError's reason, with the exit code or the signal when it only says "failed".
function gitFailure(error) {
  const reason = gitError(error);
  if (reason !== "failed") return reason;
  if (error?.signal) return `signal ${error.signal}`;
  if (Number.isInteger(error?.status)) return `exit ${error.status}`;
  return reason;
}

export function repoState(cwd) {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"], cwd);
  } catch (error) {
    return { root: null, commonDir: null, head: null, dirty: null, error: gitError(error) };
  }
  let commonDir = null;
  try {
    // Shared by every worktree of one repository, so it names the repository.
    commonDir = fs.realpathSync(path.resolve(root, git(["rev-parse", "--git-common-dir"], root)));
    const head = git(["rev-parse", "--verify", "HEAD"], root);
    const dirty = git(["status", "--porcelain"], root) !== "";
    return { root: fs.realpathSync(root), commonDir, head, dirty, error: null };
  } catch (error) {
    // A repository without a commit still has a root, so citations still work.
    return { root, commonDir, head: null, dirty: null, error: gitError(error) };
  }
}

// The top folder and the repository of a folder, without the commit or the
// status, for the consent check. Both are real paths. On any git failure both
// are null and `error` says why. A null never allows a send, and the callers
// that freeze a population refuse it with that reason.
export function repoIdentity(cwd) {
  try {
    const root = git(["rev-parse", "--show-toplevel"], cwd);
    const commonDir = fs.realpathSync(path.resolve(root, git(["rev-parse", "--git-common-dir"], root)));
    return { root: fs.realpathSync(root), commonDir, error: null };
  } catch (error) {
    return { root: null, commonDir: null, error: gitError(error) };
  }
}

// The full id of a commit, or null with the reason. A value that looks like an
// option is never passed to git.
export function resolveCommitWithReason(cwd, rev) {
  if (typeof rev !== "string" || rev === "" || rev.startsWith("-")) return { id: null, error: "bad_revision" };
  try {
    const id = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], cwd);
    return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) ? { id, error: null } : { id: null, error: "failed" };
  } catch (error) {
    return { id: null, error: gitError(error) };
  }
}

export function resolveCommit(cwd, rev) {
  return resolveCommitWithReason(cwd, rev).id;
}

// True when the checkout has uncommitted changes, null when git cannot say.
export function worktreeDirty(cwd) {
  try {
    return git(["status", "--porcelain"], cwd) !== "";
  } catch {
    return null;
  }
}

// The worktrees that git itself registered for a checkout, as real paths, the
// main one included. A folder whose .git file merely names the repository (a
// copy of a worktree, or a hand-made link) is not among them. Empty on failure.
export function registeredWorktrees(root) {
  try {
    return git(["worktree", "list", "--porcelain", "-z"], root)
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => {
        const folder = field.slice("worktree ".length);
        try {
          return fs.realpathSync(folder);
        } catch {
          return folder;
        }
      });
  } catch {
    return [];
  }
}

// One commit of one repository is one group, whatever the worktree. A report
// without a known repository and commit gets its own group, which is never
// eligible for an evaluation sample.
export function changeGroup(repo, sessionId, agentId) {
  const eligible = Boolean(repo?.commonDir && repo?.head);
  const key = eligible ? `commit:${repo.commonDir}:${repo.head}` : `unknown:${sessionId}:${agentId}`;
  return { key: createHash("sha256").update(key).digest("hex").slice(0, 16), eligible };
}

function insideRoot(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Candidates in the order they appear. Existence and type are checked when the
// excerpt is read, so the caller tries them one by one.
// A citation of a credential file (by its written path or by its real path)
// is not dropped. It comes back marked, as { refused: "credential_name", path,
// start, end }, with nothing to read, also when the file does not exist: the
// finding may describe that file's secret either way. A caller must never read
// a marked citation, and must hold its whole finding back.
export function findCitations(text, root) {
  if (!root) return [];
  const source = String(text);
  const hits = [];
  // Delimited targets first. Their spans are then blanked, so the bare pattern
  // cannot match a tail such as "file.mjs:2" inside "[x](src/my file.mjs:2)".
  let rest = source;
  for (const pattern of [LINKED, TICKED]) {
    for (const match of source.matchAll(pattern)) {
      hits.push({ at: match.index, written: match[1].trim(), start: Number(match[2]), end: Number(match[3] ?? match[2]) });
      rest = rest.slice(0, match.index) + " ".repeat(match[0].length) + rest.slice(match.index + match[0].length);
    }
  }
  for (const match of rest.matchAll(BARE)) {
    hits.push({ at: match.index, written: match[1].trim(), start: Number(match[2]), end: Number(match[3] ?? match[2]) });
  }
  hits.sort((a, b) => a.at - b.at);
  const found = [];
  const seen = new Set();
  for (const hit of hits) {
    if (hit.start < 1) continue;
    const end = Math.max(hit.start, hit.end);
    const absolute = path.isAbsolute(hit.written) ? hit.written : path.join(root, hit.written);
    let real = null;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      // No such file: no candidate to read, but its name may still mark it.
    }
    if (isSensitivePath(absolute) || (real !== null && isSensitivePath(real))) {
      const written = path.relative(root, path.resolve(absolute));
      const key = `refused:${written}:${hit.start}-${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ refused: "credential_name", path: written, start: hit.start, end });
      }
      continue;
    }
    if (real === null || !insideRoot(root, real)) continue;
    const key = `${real}:${hit.start}-${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path: path.relative(root, real), written: path.relative(root, path.resolve(absolute)), real, start: hit.start, end });
  }
  return found;
}

// The rules of every read. The path is resolved once. It must be canonical (no link in any part) both
// before and after the open, and the open file must be the same file that path
// names now. So a file or a parent folder swapped for a link cannot lead
// outside the root. The open is non-blocking, so a named pipe cannot hang the
// hook, and the type and size are checked on the open file.
//
// readBytes opens and reads the whole file under these rules. Returns the bytes and
// the file's status before and after the read (both from the open handle), or
// null when a rule refuses the file. Neither the written path nor the real
// path may name a credential file.
function readBytes(root, citation) {
  if (typeof citation.written !== "string" || isSensitivePath(path.join(root, citation.written))) return null;
  let real;
  try {
    real = fs.realpathSync(citation.real);
  } catch {
    return null;
  }
  if (real !== citation.real || !insideRoot(root, real) || isSensitivePath(real)) return null;
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return null;
  }
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) return null;
    if (fs.realpathSync(real) !== real) return null;
    const now = fs.statSync(real);
    if (now.ino !== before.ino || now.dev !== before.dev) return null;
    const buffer = Buffer.alloc(before.size);
    fs.readSync(fd, buffer, 0, before.size, 0);
    const after = fs.fstatSync(fd);
    return { buffer, before, after };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// How many masks the lines hold.
function masks(lines) {
  return lines.reduce((sum, line) => sum + line.split("<redacted>").length - 1, 0);
}

// The excerpt of a file that was read, as { excerpt, redactions }, { outcome }
// or null. In this order:
// 1. The whole file is checked for a private key before the window is cut:
//    the window around the cited lines may lie inside the key, or hold only
//    its last lines, and then no later check of the excerpt could see that it
//    is a key. Such a file gives "withheld_secret" for every citation of it.
// 2. A file with a NUL byte anywhere is not read. It is binary, or text in
//    UTF-16, where no secret rule would match, since every ASCII character
//    comes with a NUL byte.
// 3. The whole file is masked, and only then is the window cut and numbered.
//    A mask of the window alone would miss a value whose name stands on a
//    line before the window, and on numbered lines the name rule could take
//    the next line's number for the value. Masking keeps every line break, so
//    the numbers still match the file; a file whose line count changed anyway
//    is not read.
// The excerpt is not cut to a character limit here: the caller masks again
// first, then cuts. `redactions` counts the masks inside the window.
function excerptOf(buffer, citation) {
  const text = buffer.toString("utf8");
  if (holdsPrivateKey(text)) return { outcome: "withheld_secret" };
  if (buffer.includes(0)) return null;
  const masked = redactSecrets(text);
  if (masked.withheld) return { outcome: "withheld_secret" };
  const lines = masked.text.split("\n");
  const original = text.split("\n");
  if (lines.length !== original.length) {
    process.stderr.write(`subagent-router triage: masking changed the line count of ${citation.path}, so it was not read\n`);
    return null;
  }
  if (citation.start > lines.length) return null;
  const from = Math.max(1, citation.start - CONTEXT_LINES);
  const to = Math.min(lines.length, citation.end + CONTEXT_LINES, from + MAX_LINES - 1);
  const out = [];
  for (let n = from; n <= to; n += 1) out.push(`${n}: ${lines[n - 1]}`);
  const redactions = Math.max(0, masks(lines.slice(from - 1, to)) - masks(original.slice(from - 1, to)));
  return { excerpt: out.join("\n"), redactions };
}

// A file in a nested repository or a submodule belongs to another checkout,
// which the user may not have listed, so it is never read for an excerpt.
function inOwnCheckout(root, file) {
  const own = repoIdentity(path.dirname(file));
  try {
    return own.root !== null && own.root === fs.realpathSync(root);
  } catch {
    // The checkout's own path cannot be resolved: no excerpt is read, so
    // nothing leaves the machine.
    return false;
  }
}

// True only when git says the file is not ignored (exit code 1 of
// "git check-ignore"). Ignored files are where local credentials usually live.
// Exit code 0 (ignored), any other exit code, a timeout or a missing git all
// give false: when git cannot say, the file is not read. That failure is
// written to stderr in one line, so it stays visible. A file that git tracks
// is never ignored, even when it matches an ignore rule.
function notIgnored(root, file) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relative], { cwd: root, env: gitEnv(), timeout: 2000, stdio: "ignore" });
    return false;
  } catch (error) {
    if (error?.status === 1 && !error.signal) return true;
    process.stderr.write(`subagent-router triage: git check-ignore failed (${gitFailure(error)}), so ${relative} was not read\n`);
    return false;
  }
}

// For the SubagentStop path: the excerpt of the working tree file. Returns
// { excerpt, redactions }, { outcome: "withheld_secret" } when the file holds
// a private key or the citation is marked as a credential file, or null when
// the file cannot be read or git ignores it (or cannot say). A new file that
// git does not ignore is read: a review of uncommitted work cites such files.
export function readExcerpt(root, citation) {
  if (citation?.refused) return { outcome: "withheld_secret" };
  if (!inOwnCheckout(root, citation.real)) return null;
  if (!notIgnored(root, citation.real)) return null;
  const read = readBytes(root, citation);
  return read ? excerptOf(read.buffer, citation) : null;
}

// git's id for these exact bytes, in the id format of the expected id
// (40 hex characters for SHA-1, 64 for SHA-256).
function blobId(buffer, expected) {
  const algorithm = expected.length === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
}

// For a finished Codex job: the excerpt only when its bytes provably equal the
// code that was reviewed. Returns { excerpt, redactions }, { outcome } when a
// check fails, or null when the file cannot be read at all.
//   check.mode "blob": the bytes must have the blob id of <check.commit>:<path>
// The cited path must be exactly the written path: no symbolic link in any
// part, and the same letter case as on disk. The file must belong to the
// checkout itself, not to a nested repository or a submodule. A file that
// holds a private key, or a citation marked as a credential file, gives
// "withheld_secret", whatever the blob check says, so a key file always holds
// back its whole finding.
export function readCheckedExcerpt(root, citation, check) {
  if (citation?.refused) return { outcome: "withheld_secret" };
  if (typeof citation.written !== "string" || citation.written === "" || citation.written.startsWith("..") || path.isAbsolute(citation.written)) {
    return { outcome: "stale_evidence" };
  }
  let expected;
  try {
    expected = path.join(fs.realpathSync.native(root), citation.written);
    if (fs.realpathSync.native(expected) !== expected) return { outcome: "stale_evidence" };
  } catch {
    return { outcome: "stale_evidence" };
  }
  if (!inOwnCheckout(root, expected)) return { outcome: "outside_checkout" };
  const read = readBytes(root, citation);
  if (!read) return null;
  const result = excerptOf(read.buffer, citation);
  if (result?.outcome) return result;
  if (check.mode === "blob") {
    let id;
    try {
      id = git(["rev-parse", "--verify", "--quiet", `${check.commit}:${citation.written.split(path.sep).join("/")}`], root);
    } catch {
      return { outcome: "stale_evidence" };
    }
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(id) || blobId(read.buffer, id) !== id) return { outcome: "stale_evidence" };
  } else {
    return { outcome: "stale_evidence" };
  }
  return result;
}
