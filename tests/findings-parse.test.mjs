import assert from "node:assert/strict";
import test from "node:test";

import { parseFindings } from "../scripts/lib/findings.mjs";

const P = { parser: "p_tags" };
const L = { parser: "labelled", labels: ["MUST-FIX", "NICE-TO-HAVE"], emptyPhrases: ["no findings"] };
const labels = (result) => result.items.map((item) => item.label);

test("p_tags: one item per tagged line; a tag inside the text starts none", () => {
  const result = parseFindings("- [P1] a — /x/a.mjs:10-12\n- [P2] b mentions [P3] inside\n- [P1] c", P);
  assert.equal(result.state, "parsed");
  assert.deepEqual(labels(result), ["P1", "P2", "P1"]);
  assert.match(result.items[1].text, /mentions \[P3\] inside/);
});

test("p_tags: only a whole short clean verdict is empty; every other untagged report is unparsed, never zero", () => {
  // The shapes Codex writes when it finds nothing.
  for (const clean of [
    "No actionable regressions found in commit 4a42ec6. Syntax checks passed for all three changed files. Tests were not run because the read-only environment prevents creating their temporary files.",
    "There are no findings.",
    "No issues found.",
    "No discrete defects were found."
  ]) {
    assert.deepEqual(parseFindings(clean, P), { state: "empty", parser: "p_tags", count: 0, items: [] }, clean);
  }
  const unknown = [
    // A finding in prose, or no verdict at all.
    "Authentication fails in src/auth.ts:42 because the token is ignored.",
    "No error handling in src/x.ts:10.",
    "The shared widget has the same build method as the removed one.",
    // The verdict is not the opening.
    "Reviewed the guard; there are no issues with the tests.",
    // A qualifier that leaves room for other findings, or more than one word before the noun.
    "No blocking defects found in the locking paths.",
    "No new bugs introduced; the existing race remains.",
    "No tests cover the defects.",
    // A citation, a list or a second paragraph after the verdict.
    "No actionable defect was found in the changed lines; they match guide/x.md:20.",
    "No actionable regressions found.\nsrc/a.ts:3 drops errors.",
    "No critical issues found.\n\n1. (P2) scripts/a.mjs:10 swallows the error.",
    "No issues found.\n\n- the retry loop never ends",
    "No issues found.\n\nThe retry loop never ends.",
    // An incomplete verdict, and a citation without a file extension (Codex review 20261002-194754-97d67d).
    "No issues were fixed. The retry loop still never terminates.",
    "No issues found in the application code. Dockerfile:12 copies the credentials into the final image.",
    // A Markdown link whose path the bare shape cannot read (a live Codex review, job 20261002-200419-728146).
    "No issues found in the application code. [Build script](scripts/build+release.mjs:12) copies credentials into the final image.",
    // Too long to be only a verdict.
    `No issues found. ${"The change only renames a helper. ".repeat(20)}`
  ];
  // Each word that can reverse the verdict.
  for (const word of ["but", "however", "although", "though", "except", "yet", "apart from", "aside from", "other than", "besides", "save for", "unless"]) {
    unknown.push(`No issues found, ${word} the retry loop never ends.`);
  }
  for (const text of unknown) {
    assert.equal(parseFindings(text, P).state, "unparsed", text);
  }
});

test("p_tags: an item runs across a blank line to the next tag", () => {
  const result = parseFindings("[P1] Heading\n\nExplanation with src/a.mjs:10", P);
  assert.equal(result.count, 1);
  assert.match(result.items[0].text, /Explanation with src\/a\.mjs:10/);
});

test("labelled: headings group list and numbered items", () => {
  const result = parseFindings("## MUST-FIX\n- one\n- two\n1. three\n## NICE-TO-HAVE\n- four", L);
  assert.equal(result.state, "parsed");
  assert.deepEqual(labels(result), ["MUST-FIX", "MUST-FIX", "MUST-FIX", "NICE-TO-HAVE"]);
});

test("labelled: the three inline shapes each give one item with its continuation line", () => {
  const result = parseFindings("**MUST-FIX**: text\n  more\n\n[MUST-FIX] t2\ncont\n\nMUST-FIX: t3\ncont", L);
  assert.equal(result.count, 3);
  for (const item of result.items) {
    assert.equal(item.text.split("\n").length, 2, item.text);
  }
});

test("labelled: a heading that is not a label ends the section", () => {
  const result = parseFindings("## MUST-FIX\n- one\n## Summary\n- s1\n- s2", L);
  assert.equal(result.count, 1);
  assert.equal(result.state, "partial");
});

test("labelled: a free paragraph between items makes the parse partial", () => {
  const result = parseFindings("MUST-FIX: a\n\nSome free paragraph.\n\nMUST-FIX: b", L);
  assert.equal(result.count, 2);
  assert.equal(result.state, "partial");
});

test("a label or tag inside a code fence starts no item", () => {
  assert.equal(parseFindings("```\nMUST-FIX: in fence\n```\nMUST-FIX: real", L).count, 1);
  const fenced = parseFindings("~~~\n[P1] x\n~~~\n````\n[P1] y\n```\n[P1] z\n````\n[P2] real", P);
  assert.deepEqual(labels(fenced), ["P2"]);
});

test("a fence closes only on a line that holds the marker alone", () => {
  const result = parseFindings("~~~markdown\n~~~js\n[P1] fake\n~~~\n[P2] real", P);
  assert.deepEqual(labels(result), ["P2"]);
});

test("an explicit empty phrase gives empty; nothing at all gives unavailable", () => {
  assert.equal(parseFindings("No findings.", L).state, "empty");
  assert.equal(parseFindings(null, L).state, "unavailable");
  assert.equal(parseFindings("   ", P).state, "unavailable");
});

test("item text is not cut here", () => {
  // The hook redacts first and cuts after, so a secret is never split at a limit.
  const long = "x".repeat(5000);
  assert.equal(parseFindings(`[P1] ${long}`, P).items[0].text.length, 5005);
});
