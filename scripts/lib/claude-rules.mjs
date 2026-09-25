// Collect the Claude instructions that can travel with a Codex brief.
// This is a snapshot. It does not reproduce Claude's settings or on-demand loading.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkoutRoot } from "./writer-lock.mjs";

const FILE_CHARS = 16000;
const TOTAL_CHARS = 128000;
const MAX_FILES = 256;
const MAX_ENTRIES = 2048;
const IMPORT_DEPTH = 4;
const MAX_IMPORTS = 256;
const MAX_NOTES = 128;
const OUTPUT_CHARS = 160000;

function within(file, root) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Imports in examples are literal. Keep their text, but do not expand them.
function expandImports(text, expand) {
  let fence = null;
  let inline = null;
  return text.split(/(?<=\n)/).map((line) => {
    if (!line.trim()) inline = null;
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line.trimEnd());
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return line;
    }
    if (marker && !inline && (marker[1][0] !== "`" || !marker[2].includes("`"))) {
      fence = marker[1];
      return line;
    }
    return line.replace(/(`+)|(^|[\s(])@([^\s<>`"'),;]+)/g, (match, ticks, prefix, target) => {
      if (ticks) {
        if (!inline) inline = ticks;
        else if (ticks === inline) inline = null;
        return match;
      }
      return inline ? match : `${prefix}${expand(target)}`;
    });
  }).join("");
}

export function claudeRules(cwd, config, { home = os.homedir(), warn = (message) => process.stderr.write(message) } = {}) {
  const notes = [];
  const parts = [];
  const discovered = new Set();
  let remaining = TOTAL_CHARS;
  let files = 0;
  let entries = 0;
  let imports = 0;
  let importLimitReported = false;
  const note = (message, warning = false) => {
    if (notes.length > MAX_NOTES) return;
    const bounded = notes.length === MAX_NOTES ? "Further instruction notes omitted: diagnostic limit reached" : message.slice(0, 1024);
    notes.push(bounded);
    if (warning || notes.length > MAX_NOTES) warn(`subagent-router: ${bounded}\n`);
  };
  const report = (file, reason) => {
    note(`${file}: NOT included (${reason})`, true);
  };
  const omitted = (file, reason) => {
    report(file, reason);
    return `[Import omitted: ${reason}. Do not load the omitted target.]`;
  };

  // A project's import keeps the boundary of its original instruction file.
  // An imported file cannot grant itself access to a larger parent folder.
  function resolve(file, boundary) {
    const real = fs.realpathSync(file);
    if (boundary && !within(real, boundary)) {
      throw Object.assign(new Error("it points outside the project folder"), { code: "OUTSIDE" });
    }
    if (!fs.statSync(real).isFile()) {
      throw Object.assign(new Error("it is not a regular file"), { code: "NOT_FILE" });
    }
    return real;
  }

  function read(file, boundary, chain = [], depth = 0, original = null) {
    try {
      const real = resolve(file, boundary);
      if (depth > IMPORT_DEPTH) return omitted(file, "import depth exceeds four hops");
      if (files >= MAX_FILES || remaining <= 0) return omitted(file, "rules size or file limit reached");
      // Never follow an import to a conventional credential file, even inside
      // the project. Both the written path and a symlink's target are checked.
      const sensitive = (name) => {
        const segments = name.split(path.sep);
        return segments.some((part) => [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure"].includes(part)) ||
          /[/\\]\.config[/\\](?:gh|gcloud)[/\\]/.test(name) ||
          /^(?:\.env(?:\..*)?|\.envrc|\.credentials(?:\..*)?|credentials(?:\.(?:json|toml|ya?ml|ini|xml))?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.pgpass|\.htpasswd|\.dockercfg|\.vault-token|id_(?:rsa|ed25519|ecdsa|dsa))$|\.(?:pem|key|p12|pfx|tfstate|tfvars|jks|keystore|kdbx|gpg)$/i.test(path.basename(name));
      };
      if (sensitive(file) || sensitive(real)) return omitted(file, "credential file is not an instruction source");
      if (chain.includes(real)) return omitted(file, "circular import");
      files += 1;
      // Bound the read itself, rather than loading an arbitrarily large file.
      const fd = fs.openSync(real, "r");
      let text;
      let cut;
      try {
        const buffer = Buffer.alloc(Math.min(FILE_CHARS, remaining) * 4 + 4);
        const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const limit = Math.min(FILE_CHARS, remaining);
        text = buffer.subarray(0, count).toString("utf8");
        cut = text.length > limit || fs.fstatSync(fd).size > count;
        text = text.slice(0, limit);
      } finally {
        fs.closeSync(fd);
      }
      remaining -= text.length;
      const sourceChars = text.length;
      note(`${file}: included${cut ? `, cut after ${text.length} characters` : ""}`, cut);
      // Imports are expanded in place, so imports inside a conditional rule
      // remain inside that rule's section and keep its path conditions.
      text = expandImports(text, (rawTarget) => {
        if (++imports > MAX_IMPORTS) {
          if (!importLimitReported) {
            importLimitReported = true;
            report(file, "import count limit reached");
            return `[Further imports omitted: import count limit reached. Do not load them.] @${rawTarget}`;
          }
          return `@${rawTarget}`;
        }
        const target = rawTarget.replace(/[.:!?]+$/, "");
        if (!target) return `@${rawTarget}`;
        const punctuation = rawTarget.slice(target.length);
        const imported = target.startsWith("~/") ? path.join(home, target.slice(2)) : path.resolve(path.dirname(file), target);
        const content = read(imported, boundary, [...chain, real], depth + 1, `@${target}`);
        if (content === `@${target}`) return `@${rawTarget}`;
        return `\n[Imported instructions from ${imported}]\n${content}\n[End imported instructions]\n${punctuation}`;
      });
      if (cut) {
        const message = `This file was cut after ${sourceChars} characters.`;
        text += `\n[${message}]`;
      }
      return text.trim();
    } catch (error) {
      if (["ENOENT", "ENOTDIR", "NOT_FILE"].includes(error.code) && original) {
        // A missing @name can be prose (for example @param). Keep the words.
        // File-like references still get a note, without a warning per token.
        if (/[./]/.test(original)) note(`${file}: NOT included (${error.code})`);
        return original;
      }
      return omitted(file, ["OUTSIDE", "NOT_FILE"].includes(error.code) ? error.message : error.code ?? "read failed");
    }
  }

  function add(file, boundary, base, rule = false) {
    try {
      const real = resolve(file, boundary);
      if (discovered.has(real)) return;
      discovered.add(real);
    } catch (error) {
      if (error.code === "ENOENT") return;
      report(file, ["OUTSIDE", "NOT_FILE"].includes(error.code) ? error.message : error.code ?? "read failed");
      return;
    }
    if (files >= MAX_FILES || remaining <= 0) {
      report(file, "rules size or file limit reached");
      return;
    }
    const text = read(file, boundary);
    if (text) {
      const scope = rule ? `\nRule base directory: ${base}. If the YAML frontmatter has paths, apply this rule and its imports only to files matching those patterns. Keep that condition; do not treat it as a global rule.\n` : "";
      parts.push(`### Rules from ${file}${scope}\n\n${text}\n\n[End rules from ${file}]`);
    }
  }

  function rules(directory, boundary, base, seen = new Set(), depth = 0) {
    try {
      const real = fs.realpathSync(directory);
      if (depth > 32 || entries >= MAX_ENTRIES || files >= MAX_FILES || remaining <= 0) {
        report(directory, "rules traversal limit reached");
        return;
      }
      if (boundary && !within(real, boundary)) {
        report(directory, "it points outside the project folder");
        return;
      }
      if (seen.has(real)) return;
      seen.add(real);
      for (const entry of fs.readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++entries > MAX_ENTRIES) {
          report(directory, "rules traversal limit reached");
          break;
        }
        const file = path.join(directory, entry.name);
        // Symlink targets are checked before reading or descending into them.
        if (entry.isDirectory()) rules(file, boundary, base, seen, depth + 1);
        else if (entry.isSymbolicLink()) {
          try {
            const target = fs.realpathSync(file);
            if (boundary && !within(target, boundary)) report(file, "it points outside the project folder");
            else if (fs.statSync(target).isDirectory()) rules(file, boundary, base, seen, depth + 1);
            else if (entry.name.endsWith(".md")) add(file, boundary, base, true);
          } catch (error) {
            report(file, error.code ?? "cannot resolve rule link");
          }
        } else if (entry.name.endsWith(".md")) add(file, boundary, base, true);
      }
    } catch (error) {
      if (error.code !== "ENOENT") report(directory, error.code ?? "cannot list rules");
    }
  }

  const realCwd = fs.realpathSync(cwd);
  const projectRoot = checkoutRoot(realCwd);
  let realHome = path.resolve(home);
  try {
    realHome = fs.realpathSync(home);
  } catch (error) {
    if (error.code !== "ENOENT") report(home, error.code ?? "cannot resolve home");
  }
  const userDirectory = path.join(realHome, ".claude");
  if (config.codexIncludeUserRules) {
    add(path.join(userDirectory, "CLAUDE.md"), null, realCwd);
    rules(path.join(userDirectory, "rules"), null, realCwd);
  }
  if (config.codexIncludeProjectRules) {
    const parents = [];
    for (let current = realCwd; ; current = path.dirname(current)) {
      parents.unshift(current);
      if (path.dirname(current) === current) break;
    }
    for (const directory of parents) {
      // Within a checkout, sibling instruction files may be imported. An
      // ancestor outside it can import within that ancestor's own directory.
      const boundary = within(directory, projectRoot) ? projectRoot : directory;
      add(path.join(directory, "CLAUDE.md"), boundary, directory);
      // Personal sources must not re-enter through the project switch.
      if (path.join(directory, ".claude") !== userDirectory) {
        add(path.join(directory, ".claude", "CLAUDE.md"), boundary, directory);
        rules(path.join(directory, ".claude", "rules"), boundary, directory);
      }
      add(path.join(directory, "CLAUDE.local.md"), boundary, directory);
    }
  }
  let text = parts.length ? `\n\n---\nClaude instruction snapshot. Observe each rule's stated scope. Omitted imports are not authorized for loading by this snapshot.\n\n${parts.join("\n\n")}\n` : "";
  if (text.length > OUTPUT_CHARS) {
    report("Instruction snapshot", "final output limit reached");
    const marker = "\n[Instruction snapshot cut at the final output limit.]\n";
    text = text.slice(0, OUTPUT_CHARS - marker.length) + marker;
  }
  return { text, notes };
}
