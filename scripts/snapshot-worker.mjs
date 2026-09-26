#!/usr/bin/env node
// Internal helper. The caller supplies the OS boundary before this starts.
import { snapshotTree } from "./lib/executable-grade.mjs";

try {
  process.stdout.write(snapshotTree(process.argv[2], process.argv[3] ?? null) + "\n");
} catch {
  process.stderr.write("snapshot rejected: changed, oversized, unreadable or linked files\n");
  process.exitCode = 1;
}
