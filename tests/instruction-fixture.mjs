// Test-only filesystem isolation for instruction discovery. A temporary HOME
// alone does not hide instruction files in its ancestors, such as /tmp.
import fs from "node:fs";
import path from "node:path";

export function isolateInstructions(root) {
  const realpath = fs.realpathSync;
  const open = fs.openSync;
  const realRoot = realpath(root);
  const roots = [realRoot, path.resolve(root)];
  const violations = [];
  const inside = (file) => {
    return roots.some((candidate) => {
      const relative = path.relative(candidate, path.resolve(String(file)));
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    });
  };
  fs.realpathSync = (file, ...args) => {
    // Discovery may inspect ancestor metadata, but it sees no host rules.
    const candidate = path.resolve(String(file));
    const instruction = /(?:^|[/\\])CLAUDE(?:\.local)?\.md$|[/\\]\.claude[/\\]rules(?:[/\\]|$)/.test(candidate);
    if (instruction && !inside(candidate)) {
      throw Object.assign(new Error("Host instruction source hidden by fixture"), { code: "ENOENT" });
    }
    return realpath(file, ...args);
  };
  fs.realpathSync.native = fs.realpathSync;
  fs.openSync = (file, flags, ...args) => {
    // The collector opens resolved paths for reading. Fail if any source or
    // import escapes the fixture, including a target reached through a link.
    // Node must still load the program being tested. Source-module loading is
    // the only read exemption; a collector import of that file is not exempt.
    const moduleLoad = new Error().stack.split("\n").slice(2, 4).some((line) => line.includes("node:internal/modules/"));
    const reads = flags === undefined || (typeof flags === "number" ? (flags & 3) !== fs.constants.O_WRONLY : flags.startsWith("r") || flags.includes("+"));
    if (reads && !moduleLoad && !inside(realpath(file))) {
      violations.push(String(file));
      // The collector catches read errors. Persist the violation so the test
      // still fails even when the collector returns an omission instead.
      fs.writeFileSync(path.join(realRoot, ".instruction-read-violation"), "outside read attempted\n");
      throw new Error("Instruction fixture attempted to read outside its root");
    }
    return open(file, flags, ...args);
  };
  return () => {
    fs.realpathSync = realpath;
    fs.openSync = open;
    if (violations.length) throw new Error(`Instruction fixture blocked ${violations.length} outside reads`);
  };
}

if (process.env.ORCH_TEST_INSTRUCTION_ROOT) {
  isolateInstructions(process.env.ORCH_TEST_INSTRUCTION_ROOT);
}
