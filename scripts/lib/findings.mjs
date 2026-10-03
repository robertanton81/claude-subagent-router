import { hasCitationShape } from "./evidence.mjs";

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

export const PARSER_VERSION = 3;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const MD_HEADING = /^\s*#{1,6}\s+\S/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

function stripMarks(line) {
  return line.replace(/[*_`]/g, "").replace(/^\s*#{1,6}\s*/, "").trim();
}

// A line that is only a label, as a heading: "## MUST-FIX", "**MUST-FIX**", "MUST-FIX:".
function headingLabel(line, labels) {
  const bare = stripMarks(line).replace(/:$/, "").trim();
  return labels.find((label) => bare.toLowerCase() === label.toLowerCase()) ?? null;
}

// Any heading-shaped line: a markdown heading, or a line that is only bold text.
function isHeadingShape(line) {
  return MD_HEADING.test(line) || /^\s*\*\*[^*]+\*\*:?\s*$/.test(line);
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);

// A line that starts with a label and goes on: "[MUST-FIX] x", "**MUST-FIX**: x", "MUST-FIX: x".
function inlineLabel(line, labels) {
  const bare = stripMarks(line.replace(LIST_ITEM, ""));
  return labels.find((label) => new RegExp(`^\\[?${escapeRegex(label)}\\]?\\s*[:—-]?\\s+\\S`, "i").test(bare)) ?? null;
}

// A Codex review with no finding writes one short verdict and no [P*] tag, for
// example "No actionable regressions found in commit abc." Such a report is
// "empty" only when all of this holds: it opens with that verdict; the noun has
// no qualifier, or one that means "any" ("actionable", "discrete"), because
// "no blocking issues" leaves room for other issues; it is one short paragraph
// without a list item; it cites no path:line; and it holds no word that could
// reverse the verdict ("but", "apart from"). Every other untagged report stays
// "unparsed": an unknown format must never be counted as zero findings, and a
// clean review read as "unparsed" costs less than a finding read as nothing.
// The verdict must be complete: after the noun comes a full stop or the end,
// or a finding verb ("found") and then a full stop or a place ("in commit abc").
// "No issues were fixed" is not a verdict.
const CLEAN_VERDICT = /^(?:no|there (?:are|were|is|was) no)\s+(?:(?:actionable|discrete)\s+)?(?:defects?|issues?|findings?|regressions?|problems?|bugs?)\b(?:(?:\s+(?:was|were))?\s+(?:found|identified|detected|introduced)\b)?(?=\s*(?:[.;:]|$)|\s+(?:in|for|on|across|within)\b)/i;
const REVERSING_WORD = /\b(?:but|however|although|though|except|excepting|yet|apart from|aside from|other than|besides|save for|unless)\b/i;
const CLEAN_MAX_CHARS = 600;

function cleanVerdict(report) {
  const text = report.trim();
  return (
    text.length <= CLEAN_MAX_CHARS &&
    !/\n\s*\n/.test(text) &&
    !text.split("\n").some((line) => LIST_ITEM.test(line)) &&
    !hasCitationShape(text) &&
    CLEAN_VERDICT.test(text) &&
    !REVERSING_WORD.test(text)
  );
}

// format: { parser: "p_tags" } or { parser: "labelled", labels: [...], emptyPhrases: [...] }
// Item texts are complete. The caller redacts them first and cuts them after.
export function parseFindings(report, format) {
  const parser = format.parser;
  if (typeof report !== "string" || report.trim() === "") {
    return { state: "unavailable", parser, count: 0, items: [] };
  }
  const labels = format.labels ?? [];
  const items = [];
  let current = null;
  let heading = null;
  let fence = null;
  let leftover = false;
  let blank = false;
  for (const line of report.split("\n")) {
    if (fence) {
      // Only a line that holds the marker alone closes the fence.
      const close = line.match(CLOSING_FENCE)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      if (current) current.lines.push(line);
      continue;
    }
    const open = line.match(FENCE)?.[1];
    if (open) {
      fence = open;
      if (current) current.lines.push(line);
      continue;
    }
    if (line.trim() === "") {
      blank = true;
      if (current && parser === "p_tags") current.lines.push(line);
      continue;
    }
    const pTag = parser === "p_tags" ? stripMarks(line.replace(LIST_ITEM, "")).match(/^\[(P[0-3])\]\s+\S/) : null;
    const asHeading = parser === "labelled" ? headingLabel(line, labels) : null;
    const asInline = parser === "labelled" && !asHeading ? inlineLabel(line, labels) : null;
    if (pTag || asInline) {
      current = { label: pTag ? pTag[1] : asInline, lines: [line] };
      items.push(current);
    } else if (asHeading) {
      heading = asHeading;
      current = null;
    } else if (parser === "labelled" && isHeadingShape(line)) {
      // A heading that is not a label ends the labelled section.
      heading = null;
      current = null;
      if (items.length > 0) leftover = true;
    } else if (heading && LIST_ITEM.test(line) && !/^\s{2,}/.test(line)) {
      current = { label: heading, lines: [line] };
      items.push(current);
    } else if (current && (parser === "p_tags" || !blank || /^\s{2,}/.test(line))) {
      current.lines.push(line);
    } else if (items.length > 0) {
      leftover = true;
      current = null;
    }
    blank = false;
  }
  if (items.length === 0) {
    const empty = parser === "p_tags" ? cleanVerdict(report) : (format.emptyPhrases ?? []).some((phrase) => report.toLowerCase().includes(phrase.toLowerCase()));
    return { state: empty ? "empty" : "unparsed", parser, count: 0, items: [] };
  }
  return {
    state: leftover ? "partial" : "parsed",
    parser,
    count: items.length,
    items: items.map((item, index) => ({ index, label: item.label, text: item.lines.join("\n").trim() }))
  };
}
