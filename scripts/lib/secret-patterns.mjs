// scripts/lib/secret-patterns.mjs
// One place for what counts as a secret, used by the Codex instruction
// snapshots and by the finding triage. Best effort: a filter like this finds
// known shapes, not every secret.
import path from "node:path";

// Conventional credential files and folders. A path counts when the written
// path or its real path matches; callers test both. Names are compared in any
// letter case: .env, .env.local, .env-local, prod.env, secrets.yml,
// serviceAccount.json, service-account-ci.json, service_account.json, .my.cnf, .s3cfg, key files
// such as *.pem, *.p8 and *.ppk (PuTTY), and more.
export function isSensitivePath(name) {
  const segments = String(name).split(path.sep);
  return (
    segments.some((part) => [".git", ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure"].includes(part)) ||
    /[/\\]\.config[/\\](?:gh|gcloud)[/\\]/.test(name) ||
    /^(?:\.env(?:[.-].*)?|\.envrc|\.credentials(?:\..*)?|credentials(?:\.(?:json|toml|ya?ml|ini|xml))?|secrets\..+|service[-_]?account.*\.json|\.npmrc|\.netrc|\.git-credentials|\.pypirc|\.pgpass|\.htpasswd|\.dockercfg|\.vault-token|\.my\.cnf|\.s3cfg|id_(?:rsa|ed25519|ecdsa|dsa))$|\.(?:env|pem|key|p8|p12|pfx|ppk|tfstate|tfvars|jks|keystore|kdbx|gpg)$/i.test(path.basename(name))
  );
}

// The first or the last line of a private key, of any type, and the PGP form
// "PRIVATE KEY BLOCK". Not anchored to a line start, so a key kept in a JSON
// string on one line is found too.
const PRIVATE_KEY = /-----(?:BEGIN|END) [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
// Two more key formats: the first line of a PuTTY key file (.ppk), which
// holds the private key too, and the first or the last line of an SSH2 private
// key, which has four dashes and spaces. Not anchored either, for the same
// reason. Each match can start only at a fixed word, so the time stays linear.
const OTHER_KEY = /\bPuTTY-User-Key-File-\d+:|---- (?:BEGIN|END) SSH2 [A-Z ]*PRIVATE KEY ----/;
// A run of 40 or more base64 characters, for a key kept in base64 (as in a
// Kubernetes secret). A run starts only where no base64 character stands
// before it, so the time stays linear. At most 200 runs are decoded, so the
// time stays bounded.
const BASE64_RUN = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}/g;
const MAX_BASE64_RUNS = 200;

function holdsKeyLine(text) {
  return PRIVATE_KEY.test(text) || OTHER_KEY.test(text);
}

// True when a base64 run decodes to a key line. A run may start a few
// characters before the encoded key (glued to other base64 characters), so
// each of the four positions in a base64 group is tried.
function holdsEncodedKey(text) {
  let runs = 0;
  for (const [run] of text.matchAll(BASE64_RUN)) {
    for (let offset = 0; offset < 4; offset += 1) {
      if (holdsKeyLine(Buffer.from(run.slice(offset), "base64").toString("latin1"))) return true;
    }
    runs += 1;
    if (runs >= MAX_BASE64_RUNS) return false;
  }
  return false;
}

// True when the text holds the first or the last line of a private key, also
// in base64. The excerpt readers test the whole file with it: an excerpt is
// only a window of the file, and a window inside the key may hold neither line.
export function holdsPrivateKey(text) {
  const input = String(text ?? "");
  return holdsKeyLine(input) || holdsEncodedKey(input);
}

const MASK = "<redacted>";

// Each shape masks its whole match.
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bghp_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[bapr]-[A-Za-z0-9-]{10,}/g,
  // A JWT. It starts only where no token character stands before it. With \b,
  // a match could start again after every "-" of a long run, which takes
  // quadratic time. So a JWT right after a "-" is no longer matched.
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];
// Each shape keeps its first group and masks the second one, the secret.
const KEEP_PREFIX_SHAPES = [
  // The password in the user part of a URL: scheme://user:password@host keeps
  // scheme://user: and the host. The scheme starts only where no scheme
  // character stands before it, so the time stays linear.
  /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)(?=@)/gi,
  // The credential of an Authorization header, after its scheme word. Only a
  // space or a tab may stand between the parts, never a line break: on
  // numbered lines a mask must not reach the next line's number.
  /\b(Authorization["']?[ \t]*[:=][ \t]*["']?(?:Bearer|Basic|Token)[ \t]+)([^\s"',;]+)/gi
];
// A name that holds a secret word anywhere (DB_PASSWORD, client_secret,
// AWS_SECRET_ACCESS_KEY, "apiKey", privateKey), then the separator, then the
// value. The whole name stays and only the value is masked. A name may hold
// dots before the word (config.db_password), not after it, so
// password.length is no match. A harmless name such as max_tokens is masked
// too; that is accepted. The short words "pass" and "pwd" are left out: they
// stand in too many ordinary names.
// The separator is ":", "=" or ":=" (Go, Makefile), with an optional type
// annotation before "=" or ":=" (Python "api_key: str = ...", TypeScript
// "apiKey: string = ..."). The type is masked too: in YAML or prose such as
// "password: <secret> = x", the secret stands where a type would stand, and a
// lost type name costs nothing. The type must end with a space or a tab, and
// it never spans a line break. So in "secret: QUJDRA==" or "token: abc:def"
// the start of the value is not read as a type.
// A match starts only where a run of name characters starts, and each side of
// the word holds at most 100 characters: so the time stays linear, also on a
// long line of name characters. A quoted value may hold escaped characters,
// such as \" inside "...". The value never holds a line break, so a mask
// keeps the number of lines.
const ASSIGNMENT =
  /(?<![\w.-])([\w.-]{0,100}?(?:password|passwd|passphrase|secret|token|api[_-]?key|apikey|private[_-]?key|credentials?)[\w-]{0,100})(["']?\s*)(?:(:[ \t]*)([\w.<>\[\]?]+(?:[ \t]*\|[ \t]*[\w.<>\[\]?]+)*)([ \t]+))?((?::=|[:=])\s*)("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s,;]+)/gi;

// Returns { text, count, withheld }. `withheld` is true when the text holds a
// line of a private key: then the caller must not send or show it at all.
// Every mask is a function, so a "$" in the text is never read as a pattern.
// A value that is already "<redacted>" is neither masked nor counted again.
// With { assignments: false }, the name rule is skipped: only the token
// shapes and the `extra` values are masked. That is for a second pass over an
// excerpt whose file was masked whole before it was cut into numbered lines.
export function redactSecrets(text, extra = [], { assignments = true } = {}) {
  const input = String(text ?? "");
  if (holdsPrivateKey(input)) {
    return { text: "", count: 0, withheld: true };
  }
  let count = 0;
  let out = input;
  for (const shape of TOKEN_SHAPES) {
    out = out.replace(shape, () => {
      count += 1;
      return MASK;
    });
  }
  for (const shape of KEEP_PREFIX_SHAPES) {
    out = out.replace(shape, (match, kept, value) => {
      if (value === MASK) return match;
      count += 1;
      return `${kept}${MASK}`;
    });
  }
  if (assignments) {
    out = out.replace(ASSIGNMENT, (match, name, quote, colon, type, gap, sep, value) => {
      if (value === MASK) return match;
      let kept = `${name}${quote}`;
      if (type !== undefined) {
        if (type !== MASK) count += 1;
        kept += `${colon}${MASK}${gap}`;
      }
      count += 1;
      return `${kept}${sep}${MASK}`;
    });
  }
  for (const value of extra) {
    if (typeof value === "string" && value.length >= 8) {
      const parts = out.split(value);
      count += parts.length - 1;
      out = parts.join(MASK);
    }
  }
  return { text: out, count, withheld: false };
}
