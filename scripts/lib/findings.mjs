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

// A line of a worker result without the markdown that models like to add:
// bold or code marks, and a list mark at the start. "**Changed files:** none"
// and "- Changed files: none" then read like the plain line.
function plainLine(line) {
  return line.replace(/[*_`]/g, "").replace(/^[ \t]*[-+][ \t]+/, "").trim();
}

const NO_FILES = /^Changed files:\s*[([]?\s*(?:none|nothing|no files)\b/i;

// True when a worker result says that the worker changed no files.
// Used to decide who the author of the current change is.
export function reportsNoWrite(result) {
  if (typeof result !== "string") {
    return false;
  }
  return result.startsWith("CODEX_FAILED") || result.split("\n").some((line) => NO_FILES.test(plainLine(line)));
}

// The part of a worker result between "Verification:" and "Open problems:",
// or null when the result has no such line. Markdown around the two labels is
// allowed, for the same reason as above.
export function verificationText(result) {
  if (typeof result !== "string") {
    return null;
  }
  const lines = result.split("\n");
  const start = lines.findIndex((line) => /^Verification:/i.test(plainLine(line)));
  if (start === -1) {
    return null;
  }
  const collected = [plainLine(lines[start]).replace(/^Verification:\s*/i, "")];
  for (const line of lines.slice(start + 1)) {
    if (/^Open problems:/i.test(plainLine(line))) {
      break;
    }
    collected.push(line);
  }
  return collected.join("\n").trim();
}
