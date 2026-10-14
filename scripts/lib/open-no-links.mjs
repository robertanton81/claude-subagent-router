// Opens a file for reading only when no part of its path is a symbolic link at
// the moment of the open. A command outside the sandbox checks a path, then
// opens it; a concurrent process can swap a folder of that path for a link in
// between, and O_NOFOLLOW covers only the last part. So the open itself must
// see the swap:
// - macOS 11 and later: O_NOFOLLOW_ANY makes the open fail with ELOOP when any
//   part of the path is a link. It is not combined with O_NOFOLLOW: the kernel
//   refuses that pair with EINVAL.
// - Linux: there is no such flag, but /proc/self/fd/<n> names the file that the
//   descriptor really opened. A swapped folder shows there as another path.
// Any other system, or an older macOS, gets no open at all.

import fs from "node:fs";
import os from "node:os";

// From sys/fcntl.h of the macOS SDK. Node does not export it.
const O_NOFOLLOW_ANY = 0x20000000;

function refuse(message, code) {
  return Object.assign(new Error(message), { code });
}

// The descriptor of `file`, opened read-only and without blocking on a pipe.
// Throws with code ELOOP (macOS) or PATH_CHANGED (Linux) when a link was in the
// path, and NO_SAFE_OPEN on a system that cannot tell. `procFd` is the folder
// that names open descriptors on Linux; tests point it elsewhere.
export function openWithoutLinks(file, { platform = process.platform, darwinMajor = Number(os.release().split(".")[0]), procFd = "/proc/self/fd" } = {}) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (platform === "darwin") {
    // Darwin 20 is macOS 11, the first with O_NOFOLLOW_ANY. An older kernel
    // could ignore the flag, which would be the unsafe open again.
    if (!(darwinMajor >= 20)) throw refuse("this macOS is older than 11, so the file cannot be opened safely", "NO_SAFE_OPEN");
    return fs.openSync(file, O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY);
  }
  if (platform === "linux") {
    const fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const opened = fs.readlinkSync(`${procFd}/${fd}`);
      if (opened !== file) throw refuse(`the opened file is ${opened}, not ${file}`, "PATH_CHANGED");
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      if (error.code === "PATH_CHANGED") throw error;
      throw refuse(`the opened file cannot be checked (${error.code ?? error.message})`, "NO_SAFE_OPEN");
    }
  }
  throw refuse(`${platform} has no safe open for this check`, "NO_SAFE_OPEN");
}

// True when a real path is a system temp folder, or lies in one. Only real temp
// folders count, not their parents: on macOS /private/tmp and a per-user
// /private/var/folders/<x>/<y>/T (its sibling C/ is a cache with app state); on
// Linux /tmp and /var/tmp. /run/user is no temp folder: it holds runtime files
// such as a container registry login.
export function systemTempFolder(real, platform = process.platform) {
  const under = (base) => real === base || real.startsWith(`${base}/`);
  if (platform === "darwin") return under("/private/tmp") || /^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/.test(real);
  if (platform === "linux") return under("/tmp") || under("/var/tmp");
  return false;
}

// The text for a --brief file that openWithoutLinks refused.
export function briefOpenRefusal(error, file) {
  if (error?.code === "ELOOP" || error?.code === "PATH_CHANGED") {
    return `--brief: a folder in the path of ${file} changed into a link while it was opened, so it was not read`;
  }
  if (error?.code === "NO_SAFE_OPEN") {
    return `--brief: ${error.message}. Give the text on stdin instead`;
  }
  return `--brief: the file ${file} cannot be read: ${error?.message ?? error}`;
}
