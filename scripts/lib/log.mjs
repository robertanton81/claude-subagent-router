import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";

export const LOG_FILE_NAME = "dispatch-log.jsonl";

// The log holds briefs. So the data folder is private (mode 0700), the file is
// private (mode 0600), and the file is bounded: at the size limit it is renamed
// once, to `dispatch-log.1.jsonl`, and replaces the older one. So the log takes
// at most two files of that size. ORCH_LOG_MAX_BYTES changes the limit.
const DEFAULT_LOG_MAX_BYTES = 25 * 1024 * 1024;
const MIN_LOG_MAX_BYTES = 1024;

export function logFile(env = process.env) {
  return path.join(dataDir(env), LOG_FILE_NAME);
}

export function rotatedLogFile(env = process.env) {
  return rotatedName(logFile(env));
}

function rotatedName(file) {
  return file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}.1.jsonl` : `${file}.1`;
}

export function logMaxBytes(env = process.env) {
  const raw = env.ORCH_LOG_MAX_BYTES;
  if (raw === undefined || raw === "") {
    return DEFAULT_LOG_MAX_BYTES;
  }
  const bytes = Number(raw);
  if (Number.isFinite(bytes) && bytes >= MIN_LOG_MAX_BYTES) {
    return Math.floor(bytes);
  }
  process.stderr.write(`orchestrator: ORCH_LOG_MAX_BYTES="${raw}" is not a number of ${MIN_LOG_MAX_BYTES} or more, so ${DEFAULT_LOG_MAX_BYTES} is used\n`);
  return DEFAULT_LOG_MAX_BYTES;
}

// Makes a folder that only this user can enter. mkdirSync sets the mode only for
// the folders it creates, so an older folder with a wider mode is tightened too.
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((fs.statSync(dir).mode & 0o077) !== 0) {
    fs.chmodSync(dir, 0o700);
  }
}

// Takes the group and other permissions away from a file that exists. A file
// that does not exist is no error: the caller may not have written it yet.
export function makeFilePrivate(file) {
  try {
    if ((fs.statSync(file).mode & 0o077) !== 0) {
      fs.chmodSync(file, 0o600);
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

// The size of the file, or null when there is no file.
function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// A rotation lock older than this belongs to a hook that died between taking
// the lock and giving it back. A rotation takes milliseconds, so this is generous.
const ROTATE_LOCK_MAX_AGE_MS = 60 * 1000;

// Two hooks can append at the same moment, for example when two background
// workers stop together, and both can see the file at its limit. Without a lock
// the slower one renames the file that the faster one has just started anew, and
// a few records replace the fresh archive. So one hook takes a lock, looks at the
// size again under it, and rotates. The other hook skips the rotation, and its
// record goes into whichever file is current; the next append rotates when the
// file is still large.
function rotateIfLarge(file, maxBytes) {
  const size = sizeOf(file);
  if (size === null || size < maxBytes) {
    return;
  }
  const lock = `${file}.rotate.lock`;
  let handle;
  try {
    handle = fs.openSync(lock, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    removeStaleLock(lock);
    return;
  }
  try {
    const sizeNow = sizeOf(file);
    if (sizeNow !== null && sizeNow >= maxBytes) {
      try {
        fs.renameSync(file, rotatedName(file));
      } catch (error) {
        // The file went away between the look and the rename. Only something that
        // takes no lock can do that. The record then goes into the new file.
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  } finally {
    fs.closeSync(handle);
    removeLock(lock);
  }
}

function removeLock(lock) {
  try {
    fs.unlinkSync(lock);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function lockAge(lock) {
  return Date.now() - fs.statSync(lock).mtimeMs;
}

// Removes a lock that its holder can no longer give back. The rotation waits for
// the next append; a dead holder must not stop the rotation for good.
//
// The age is read and the path removed in two steps. Between them another hook
// could remove the same stale lock and a third could take a fresh one; the
// removal would then delete the fresh lock, and two hooks would rotate at once.
// So a stale lock is removed only under a second lock, the breaker, and its age
// is read again under it. While the breaker is held, no other hook removes the
// rotation lock, and a dead holder gives nothing back, so the second look and
// the removal see the same file. This is the protocol of the writer lock in
// writer-lock.mjs. One case stays, as there: a hook that dies inside this step
// leaves a breaker, and two hooks that then both judge that breaker stale can
// both enter. That needs two dead hooks and three at once.
function removeStaleLock(lock) {
  try {
    if (lockAge(lock) <= ROTATE_LOCK_MAX_AGE_MS) {
      return;
    }
  } catch (error) {
    // The holder gave the lock back in the meantime.
    if (error.code !== "ENOENT") {
      throw error;
    }
    return;
  }
  const breaker = `${lock}.break`;
  let handle;
  try {
    handle = fs.openSync(breaker, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    // Another hook is removing the stale lock now, or it died while doing so.
    try {
      if (lockAge(breaker) > ROTATE_LOCK_MAX_AGE_MS) {
        removeLock(breaker);
      }
    } catch (ageError) {
      if (ageError.code !== "ENOENT") {
        throw ageError;
      }
    }
    return;
  }
  try {
    try {
      if (lockAge(lock) > ROTATE_LOCK_MAX_AGE_MS) {
        removeLock(lock);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  } finally {
    fs.closeSync(handle);
    removeLock(breaker);
  }
}

// Secrets that must never reach a log line. The key is kept out of every record
// by design. This is the second guard, for the case that a new code path forgets it.
// Nothing else is masked: whatever a brief holds lands in the log, unless
// `promptLogChars` keeps the text of briefs out.
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) {
    secrets.add(value);
    // A key with a line break inside shows up in error texts in its escaped form.
    secrets.add(JSON.stringify(value).slice(1, -1));
  }
}

function withoutSecrets(line) {
  let clean = line;
  for (const secret of secrets) {
    clean = clean.split(secret).join("<hidden>");
  }
  return clean;
}

export function truncate(text, maxChars) {
  if (typeof text !== "string") {
    return text ?? null;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [+${text.length - maxChars} chars]`;
}

// Appends one JSON line. A log problem must never block a dispatch, so this
// function reports the problem on stderr (the Claude Code debug log) and returns false.
export function appendLog(record, env = process.env) {
  try {
    ensurePrivateDir(dataDir(env));
    const file = logFile(env);
    // A rotation that fails must not cost the record: it goes into the large file,
    // and the next append tries the rotation again.
    try {
      rotateIfLarge(file, logMaxBytes(env));
    } catch (error) {
      process.stderr.write(`orchestrator: cannot rotate the dispatch log: ${error.message}\n`);
    }
    fs.appendFileSync(file, `${withoutSecrets(JSON.stringify(record))}\n`, { encoding: "utf8", mode: 0o600 });
    // The mode above counts only for a new file. An older file may be wider.
    makeFilePrivate(file);
    return true;
  } catch (error) {
    process.stderr.write(`orchestrator: cannot write the dispatch log: ${error.message}\n`);
    return false;
  }
}

// Reads the last part of the log. Broken lines are skipped, because the first
// line of a tail is usually cut in the middle.
export function readLogTail(env = process.env, maxBytes = 256 * 1024) {
  const file = logFile(env);
  if (!fs.existsSync(file)) {
    return [];
  }
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const handle = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    fs.readSync(handle, buffer, 0, buffer.length, start);
    const records = [];
    for (const line of buffer.toString("utf8").split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        // A cut or damaged line. It carries no usable record.
      }
    }
    return records;
  } finally {
    fs.closeSync(handle);
  }
}
