import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { ROOT, makeTempDir } from "./helpers.mjs";

// The README is the landing page. Details belong to a page in guide/, so the
// README has a word limit, and every relative link in the shipped Markdown
// files must reach an existing file and heading. A moved section then fails
// here instead of leaving a dead link on GitHub.
const README_WORD_LIMIT = 1500;

// Paths that the public copy leaves out (the same list as the export script).
// A link to one of them works in the private checkout and is dead in the
// public repository.
const PRIVATE_PATHS = [
  "docs/",
  ".claude/",
  ".agents/",
  "AGENTS.md",
  "tests/dev-hooks.test.mjs",
  "tests/simulator.test.mjs",
  "tests/walkthrough.test.mjs",
  "tests/eval-kits.test.mjs",
  "tests/dev-agents.test.mjs",
];

// AGENTS.md is the development rules file, which the public copy leaves out.
function shippedMarkdown() {
  const files = fs.readdirSync(ROOT).filter((name) => name.endsWith(".md") && name !== "AGENTS.md");
  for (const folder of ["guide", "agents"]) {
    const dir = path.join(ROOT, folder);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (name.endsWith(".md")) files.push(`${folder}/${name}`);
  }
  for (const skill of fs.readdirSync(path.join(ROOT, "skills"))) {
    const file = `skills/${skill}/SKILL.md`;
    if (fs.existsSync(path.join(ROOT, file))) files.push(file);
  }
  return files.sort();
}

// Lines outside fenced code blocks, with inline code removed, so a link
// written as an example inside code is not checked.
function proseLines(text) {
  const lines = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) lines.push(line.replace(/`[^`]*`/g, "``"));
  }
  return lines;
}

// GitHub's heading anchor: lower case, punctuation dropped (backticks too),
// each space becomes a hyphen, and a repeated anchor gets -1, -2 and so on.
function anchorsOf(text) {
  const anchors = new Set();
  const seen = new Map();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    const heading = !fenced && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!heading) continue;
    const base = heading[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
      .replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    anchors.add(count === 0 ? base : `${base}-${count}`);
    seen.set(base, count + 1);
  }
  return anchors;
}

// Every "](" in prose must be a link of the plain form [text](target). A link
// in another form (a title in single quotes, angle brackets, a space in the
// path, a reference definition, an HTML href or src, an autolink to a file)
// is reported, so it can never pass without being checked.
const OTHER_LINK_FORMS = [/^\s*\[[^\]]+\]:/g, /\]\[/g, /\b(?:href|src)\s*=/g, /<[^\s<>]+\.md(?:#[^\s<>]*)?>/g];

function linksIn(text) {
  const links = [];
  let unparsed = 0;
  for (const line of proseLines(text)) {
    const parsed = [...line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)];
    unparsed += line.split("](").length - 1 - parsed.length;
    for (const form of OTHER_LINK_FORMS) unparsed += [...line.matchAll(form)].length;
    for (const match of parsed) if (!/^[a-z][a-z0-9+.-]*:/i.test(match[1])) links.push(match[1]);
  }
  return { links, unparsed };
}

function brokenLinks(root, file) {
  const broken = [];
  const { links, unparsed } = linksIn(fs.readFileSync(path.join(root, file), "utf8"));
  if (unparsed) broken.push(`${unparsed} link(s) in a form the test cannot parse`);
  for (const target of links) {
    const [pathPart, anchor] = target.split("#");
    const resolved = pathPart === "" ? path.join(root, file) : path.resolve(path.dirname(path.join(root, file)), decodeURIComponent(pathPart));
    const relative = path.relative(root, resolved).split(path.sep).join("/");
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      broken.push(`${target} (outside the repository)`);
      continue;
    }
    if (PRIVATE_PATHS.some((entry) => (entry.endsWith("/") ? `${relative}/`.startsWith(entry) : relative === entry))) {
      broken.push(`${target} (a path that the public copy leaves out)`);
      continue;
    }
    if (!fs.existsSync(resolved)) {
      broken.push(`${target} (no such file)`);
      continue;
    }
    if (anchor === undefined) continue;
    if (!resolved.endsWith(".md")) {
      broken.push(`${target} (an anchor into a file that is not Markdown)`);
      continue;
    }
    if (!anchorsOf(fs.readFileSync(resolved, "utf8")).has(anchor)) broken.push(`${target} (no such heading)`);
  }
  return broken;
}

test("the anchor rule matches GitHub's for the headings these docs use", () => {
  const text = [
    "## Turn on Codex (optional)",
    "### Why was a call not rerouted?",
    "### Direct calls to the plugin's workers",
    "## The `codex:codex-rescue` redirect",
    "## Log records",
    "## Log records",
    "## Log records",
    "```",
    "## not a heading inside code",
    "```",
  ].join("\n");
  assert.deepEqual(
    [...anchorsOf(text)],
    ["turn-on-codex-optional", "why-was-a-call-not-rerouted", "direct-calls-to-the-plugins-workers", "the-codexcodex-rescue-redirect", "log-records", "log-records-1", "log-records-2"],
  );
});

test("each kind of broken link is reported, and good links and links inside code are not", () => {
  // The public export refuses any file whose text holds the private notes
  // folder followed by a slash and a letter, so the folder name is joined in.
  const DOCS = "docs";
  const root = makeTempDir("docs-links-");
  try {
    fs.mkdirSync(path.join(root, DOCS));
    fs.writeFileSync(path.join(root, DOCS, "notes.md"), "# Notes\n");
    fs.mkdirSync(path.join(root, ".claude-plugin"));
    fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), "{}\n");
    fs.writeFileSync(path.join(root, "b.md"), "# Real heading\n");
    fs.writeFileSync(path.join(root, "c.txt"), "text\n");
    fs.mkdirSync(path.join(root, "tests"));
    fs.writeFileSync(path.join(root, "tests", "walkthrough.test.mjs"), "\n");
    fs.writeFileSync(
      path.join(root, "a.md"),
      [
        "# Own heading",
        "[ok](b.md#real-heading) [self](#own-heading) [web](https://example.com/x#y) [manifest](.claude-plugin/plugin.json)",
        "[gone](missing.md)",
        "[no heading](b.md#other)",
        "[dead self](#nope)",
        "[out](../../..)",
        `[private](${DOCS}/notes.md)`,
        "[rules](AGENTS.md)",
        "[copies](.agents/x.md)",
        "[dev test](tests/walkthrough.test.mjs)",
        "[text anchor](c.txt#a)",
        "[titled](b.md 'title')",
        "[ref]: missing.md",
        "[tight]:missing.md",
        "<a href = \"missing.md\">html</a>",
        "`[code](missing.md)`",
        "```",
        "[fenced](missing.md)",
        "```",
      ].join("\n"),
    );
    assert.deepEqual(brokenLinks(root, "a.md"), [
      "4 link(s) in a form the test cannot parse",
      "missing.md (no such file)",
      "b.md#other (no such heading)",
      "#nope (no such heading)",
      "../../.. (outside the repository)",
      `${DOCS}/notes.md (a path that the public copy leaves out)`,
      "AGENTS.md (a path that the public copy leaves out)",
      ".agents/x.md (a path that the public copy leaves out)",
      "tests/walkthrough.test.mjs (a path that the public copy leaves out)",
      "c.txt#a (an anchor into a file that is not Markdown)",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every relative link in the shipped Markdown files reaches a file and a heading", () => {
  const files = shippedMarkdown();
  for (const file of ["README.md", "guide/setup.md", "agents/implementer.md", "skills/setup/SKILL.md"]) assert.ok(files.includes(file), `${file} is checked`);
  const broken = files.flatMap((file) => brokenLinks(ROOT, file).map((entry) => `${file}: ${entry}`));
  assert.deepEqual(broken, []);
});

// A script or a skill can name a guide page, and a section of it, as plain
// text: `guide/setup.md ... section "Add the status line log (optional)"`.
function citedPages(text) {
  const pages = [...text.matchAll(/guide\/[\w./-]+\.md/g)].map((match) => ({ page: match[0] }));
  const sections = [...text.matchAll(/(guide\/[\w./-]+\.md)[^"\n]*?section "([^"\n]+)"/g)].map((match) => ({ page: match[1], section: match[2] }));
  return [...pages, ...sections];
}

function missingCitations(root, file) {
  return citedPages(fs.readFileSync(path.join(root, file), "utf8"))
    .filter(({ page, section }) => {
      const target = path.join(root, page);
      if (!fs.existsSync(target)) return true;
      return section !== undefined && ![...anchorsOf(`# ${section}`)].every((anchor) => anchorsOf(fs.readFileSync(target, "utf8")).has(anchor));
    })
    .map(({ page, section }) => (section === undefined ? page : `${page} section "${section}"`));
}

test("a plain-text citation of a guide page or of its section is told apart from a good one", () => {
  const root = makeTempDir("docs-links-");
  try {
    fs.mkdirSync(path.join(root, "guide", "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "guide", "setup.md"), "# Setup\n\n## Add the status line log (optional)\n");
    fs.writeFileSync(path.join(root, "guide", "sub", "Deep_Page.md"), "# Deep\n");
    fs.writeFileSync(
      path.join(root, "script.mjs"),
      [
        "row(`See guide/setup.md in the plugin folder, section \"Add the status line log (optional)\"`);",
        "row(`See guide/setup.md, section \"Turn on Jev\"`);",
        "// guide/sub/Deep_Page.md and guide/sub/Gone_Page.md",
      ].join("\n"),
    );
    assert.deepEqual(missingCitations(root, "script.mjs"), ["guide/sub/Gone_Page.md", 'guide/setup.md section "Turn on Jev"']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every guide page and section that a script or a skill names as plain text exists", () => {
  const sources = [
    ...fs.readdirSync(path.join(ROOT, "scripts")).filter((name) => name.endsWith(".mjs")).map((name) => `scripts/${name}`),
    ...fs.readdirSync(path.join(ROOT, "scripts", "lib")).filter((name) => name.endsWith(".mjs")).map((name) => `scripts/lib/${name}`),
    ...shippedMarkdown().filter((file) => file.startsWith("skills/") || file.startsWith("agents/")),
  ];
  assert.ok(citedPages(fs.readFileSync(path.join(ROOT, "skills/setup/SKILL.md"), "utf8")).length > 0, "the setup skill names a guide page");
  assert.ok(citedPages(fs.readFileSync(path.join(ROOT, "scripts/setup-check.mjs"), "utf8")).some(({ section }) => section), "the setup check names a guide section");
  assert.deepEqual(sources.flatMap((file) => missingCitations(ROOT, file).map((entry) => `${file}: ${entry}`)), []);
});

test(`the README stays at or under ${README_WORD_LIMIT} words`, () => {
  const words = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").split(/\s+/).filter(Boolean).length;
  assert.ok(words <= README_WORD_LIMIT, `README.md has ${words} words; the limit is ${README_WORD_LIMIT}. Put the details on a page in guide/ and link it from the README.`);
});
