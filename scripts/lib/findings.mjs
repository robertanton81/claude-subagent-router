// Counts priority tags such as [P1] in a review result.
export function countFindings(text) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  if (typeof text !== "string") {
    return counts;
  }
  for (const match of text.matchAll(/\[(P[0-3])\]/g)) {
    counts[match[1]] += 1;
  }
  return counts;
}

// True when a worker result says that the worker changed no files.
// Used to decide who the author of the current change is.
export function reportsNoWrite(result) {
  if (typeof result !== "string") {
    return false;
  }
  return result.startsWith("CODEX_FAILED") || /^Changed files:\s*none\b/im.test(result);
}
