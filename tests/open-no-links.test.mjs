import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { briefOpenRefusal, openWithoutLinks, systemTempFolder } from "../scripts/lib/open-no-links.mjs";
import { makeTempDir } from "./helpers.mjs";

const SUPPORTED = process.platform === "darwin" || process.platform === "linux";

// A real folder with a file, and a link to that folder. A path through the
// link is what the open sees when a concurrent process swaps a checked folder
// for a link: the race happens between two system calls, so the test sets up
// the swapped state directly instead of timing one.
function linkedFolder(t) {
  const base = fs.realpathSync(makeTempDir("orch-no-links-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const real = path.join(base, "real");
  fs.mkdirSync(real);
  const file = path.join(real, "brief.md");
  fs.writeFileSync(file, "Goal: a brief\n");
  fs.symlinkSync(real, path.join(base, "swapped"));
  return { base, file, throughLink: path.join(base, "swapped", "brief.md") };
}

test("a path with no link opens and reads the file", { skip: !SUPPORTED }, (t) => {
  const { file } = linkedFolder(t);
  const fd = openWithoutLinks(file);
  try {
    assert.equal(fs.readFileSync(fd, "utf8"), "Goal: a brief\n");
  } finally {
    fs.closeSync(fd);
  }
});

test("a folder of the path that is a link refuses the open", { skip: !SUPPORTED }, (t) => {
  const { throughLink } = linkedFolder(t);
  // Positive control: an ordinary open follows the folder link to the file, so
  // the refusal below comes from openWithoutLinks, not from a missing file.
  fs.closeSync(fs.openSync(throughLink, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW));
  assert.throws(() => openWithoutLinks(throughLink), (error) => error.code === (process.platform === "darwin" ? "ELOOP" : "PATH_CHANGED"));
});

test("a final link refuses the open too", { skip: !SUPPORTED }, (t) => {
  const { base, file } = linkedFolder(t);
  const link = path.join(base, "link.md");
  fs.symlinkSync(file, link);
  assert.throws(() => openWithoutLinks(link), (error) => error.code === "ELOOP");
});

// A stand-in for /proc/self/fd: a link for every descriptor number up to 255,
// all pointing at `target`, because the number of the next descriptor is not
// known in advance.
function fakeProcFd(t, target) {
  const dir = makeTempDir("orch-proc-fd-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (let fd = 0; fd < 256; fd += 1) fs.symlinkSync(target, path.join(dir, String(fd)));
  return dir;
}

test("on Linux the open is kept only when the descriptor names the expected file", { skip: process.platform === "win32" }, (t) => {
  const { file } = linkedFolder(t);
  const same = openWithoutLinks(file, { platform: "linux", procFd: fakeProcFd(t, file) });
  fs.closeSync(same);
  // A swapped folder shows as another path behind the descriptor.
  assert.throws(() => openWithoutLinks(file, { platform: "linux", procFd: fakeProcFd(t, "/elsewhere/brief.md") }), (error) => error.code === "PATH_CHANGED");
  // No usable /proc: nothing is opened.
  assert.throws(() => openWithoutLinks(file, { platform: "linux", procFd: path.join(makeTempDir("orch-no-proc-"), "missing") }), (error) => error.code === "NO_SAFE_OPEN");
});

test("a refused open becomes a --brief message that says why", () => {
  assert.match(briefOpenRefusal({ code: "ELOOP" }, "b.md"), /a folder in the path of b\.md changed into a link while it was opened, so it was not read/);
  assert.match(briefOpenRefusal({ code: "PATH_CHANGED" }, "b.md"), /changed into a link/);
  assert.equal(briefOpenRefusal({ code: "NO_SAFE_OPEN", message: "this macOS is older than 11, so the file cannot be opened safely" }, "b.md"), "--brief: this macOS is older than 11, so the file cannot be opened safely. Give the text on stdin instead");
  assert.equal(briefOpenRefusal({ code: "EACCES", message: "permission denied" }, "b.md"), "--brief: the file b.md cannot be read: permission denied");
});

test("the macOS version gate opens from Darwin 20, macOS 11, on", { skip: process.platform !== "darwin" }, (t) => {
  const { file } = linkedFolder(t);
  fs.closeSync(openWithoutLinks(file, { platform: "darwin", darwinMajor: 20 }));
});

test("a system with no safe open, or a macOS older than 11, opens nothing", (t) => {
  const { file } = SUPPORTED ? linkedFolder(t) : { file: "/no/such/file" };
  assert.throws(() => openWithoutLinks(file, { platform: "win32" }), (error) => error.code === "NO_SAFE_OPEN");
  assert.throws(() => openWithoutLinks(file, { platform: "darwin", darwinMajor: 19 }), (error) => error.code === "NO_SAFE_OPEN");
  assert.throws(() => openWithoutLinks(file, { platform: "darwin", darwinMajor: Number.NaN }), (error) => error.code === "NO_SAFE_OPEN");
});

test("only real system temp folders count, not their parents and not the runtime folder", () => {
  const darwin = (real) => systemTempFolder(real, "darwin");
  const linux = (real) => systemTempFolder(real, "linux");
  // macOS: /private/tmp and a per-user T folder, with what lies in them.
  for (const real of ["/private/tmp", "/private/tmp/claude-501/scratch", "/private/var/folders/ab/xyz123/T", "/private/var/folders/ab/xyz123/T/sub"]) {
    assert.equal(darwin(real), true, real);
  }
  // Not their parents, not the per-user cache folder C, not a look-alike name.
  for (const real of ["/private/var/folders", "/private/var/folders/ab", "/private/var/folders/ab/xyz123", "/private/var/folders/ab/xyz123/C/app", "/private/var/folders/ab/xyz123/Tmp", "/private/tmpx", "/opt/u", "/"]) {
    assert.equal(darwin(real), false, real);
  }
  for (const real of ["/tmp", "/tmp/x", "/var/tmp", "/var/tmp/y"]) assert.equal(linux(real), true, real);
  // /run/user holds runtime files such as a container registry login.
  for (const real of ["/run/user", "/run/user/1000", "/run/user/1000/containers/auth.json", "/home/u", "/tmpx", "/"]) {
    assert.equal(linux(real), false, real);
  }
  assert.equal(systemTempFolder("/tmp", "win32"), false);
});
