import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { holdsPrivateKey, isSensitivePath, redactSecrets } from "../scripts/lib/secret-patterns.mjs";
import { ROOT } from "./helpers.mjs";

// Key lines are built at run time, so this file holds no literal key line and
// a review that cites it can still be triaged.
const DASHES = "-".repeat(5);
const pem = (edge, label) => `${DASHES}${edge} ${label}${DASHES}`;

test("credential files and folders count as sensitive", () => {
  for (const name of ["a/.ssh/config", "x/.aws/credentials", "/h/.config/gh/hosts.yml", ".env", ".env.local", "id_ed25519", "deploy.pem", "site.key", "infra.tfvars", ".npmrc"]) {
    assert.equal(isSensitivePath(name), true, name);
  }
});

test("more credential file names count as sensitive, in any letter case", () => {
  const names = [
    "config/secrets.env",
    "prod.env",
    ".env-local",
    "keys/AuthKey_ABC123.p8",
    "secrets.yml",
    "config/secrets.json",
    "serviceAccount.json",
    "serviceAccountKey.json",
    "keys/service-account-prod.json",
    "SERVICE-ACCOUNT.JSON",
    "gcp/service_account.json",
    ".my.cnf",
    "home/.s3cfg"
  ];
  for (const name of names) {
    assert.equal(isSensitivePath(name), true, name);
  }
});

test("ordinary source and docs files are not sensitive", () => {
  // The last names are close to the credential names above and must stay readable.
  for (const name of ["src/app.mjs", "README.md", "guide/keys.md", "src/environment.ts", "src/env.mjs", "notes/secretsauce.md", "src/service.json", "src/account.json", "my.cnf.md", "p8.txt"]) {
    assert.equal(isSensitivePath(name), false, name);
  }
});

test("known token shapes are masked and counted", () => {
  const cases = {
    openai: `key sk-${"a".repeat(24)} end`,
    github: `ghp_${"b".repeat(30)}`,
    githubPat: `github_pat_${"c".repeat(30)}`,
    aws: `AKIA${"D".repeat(16)}`,
    slack: `xoxb-${"e".repeat(14)}`,
    jwt: `eyJ${"f".repeat(10)}.${"g".repeat(10)}.${"h".repeat(10)}`
  };
  for (const [name, text] of Object.entries(cases)) {
    const result = redactSecrets(text);
    assert.equal(result.count, 1, name);
    assert.match(result.text, /<redacted>/, name);
    assert.doesNotMatch(result.text, /a{24}|b{30}|c{30}|D{16}|e{14}|f{10}/, name);
    assert.equal(result.withheld, false, name);
  }
});

test("the value after a secret-like name is masked, the name stays", () => {
  for (const [input, output] of [["password = hunter2", "password = <redacted>"], ['api_key: "zzz"', "api_key: <redacted>"], ["TOKEN=abc", "TOKEN=<redacted>"]]) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false });
  }
});

test("a quoted value with an escaped quote is masked whole, in both quote styles", () => {
  assert.equal(redactSecrets('password = "ab\\"cd" rest').text, "password = <redacted> rest");
  assert.equal(redactSecrets("secret: 'ab\\'cd' rest").text, "secret: <redacted> rest");
  assert.equal(redactSecrets('DB_PASSWORD="ab\\"cd" rest').text, "DB_PASSWORD=<redacted> rest");
});

test("a name that holds a secret word with a prefix or a suffix is masked, and the whole name stays", () => {
  const cases = [
    ["DB_PASSWORD=x", "DB_PASSWORD=<redacted>"],
    ["AWS_SECRET_ACCESS_KEY=x", "AWS_SECRET_ACCESS_KEY=<redacted>"],
    ["GITHUB_TOKEN=x", "GITHUB_TOKEN=<redacted>"],
    ['client_secret: "x"', "client_secret: <redacted>"],
    ["secret_key: x", "secret_key: <redacted>"],
    ["auth_token = x", "auth_token = <redacted>"],
    ["export GITHUB_TOKEN=abc", "export GITHUB_TOKEN=<redacted>"],
    ["run --api-key=abc now", "run --api-key=<redacted> now"],
    ["foo: password=abc", "foo: password=<redacted>"]
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("a quoted JSON name keeps its quotes, and only the value is masked", () => {
  assert.deepEqual(redactSecrets('{"db_password": "x", "apiKey": "y", "name": "z"}'), { text: '{"db_password": <redacted>, "apiKey": <redacted>, "name": "z"}', count: 2, withheld: false });
});

test("prose, and a property of a value with a secret name, are not masked", () => {
  for (const text of ["the token count grew", "return tokens.length;", "password.length = 5"]) {
    assert.deepEqual(redactSecrets(text), { text, count: 0, withheld: false }, text);
  }
});

test("a long run of name characters is checked in linear time", () => {
  // A name pattern that may start again after every "_" takes quadratic time
  // on such a run: seconds for this text, minutes for a line of 1 MB.
  // The second text holds a secret word at every step.
  for (const text of ["a_".repeat(50000), "secret_".repeat(28000)]) {
    const started = Date.now();
    assert.equal(redactSecrets(text).text, text);
    const ms = Date.now() - started;
    assert.ok(ms < 1000, `${text.slice(0, 7)}: took ${ms} ms`);
  }
});

// The fake values are repeated letters, built at run time.
const FAKE = "Q".repeat(16);

test("an assignment with a type annotation masks the type too, since a secret can stand where a type stands", () => {
  const cases = [
    // Python and TypeScript annotations: the type is lost, which costs nothing.
    [`api_key: str = "${FAKE}"`, "api_key: <redacted> = <redacted>"],
    [`const apiKey: string = "${FAKE}";`, "const apiKey: <redacted> = <redacted>;"],
    [`token: str | None = "${FAKE}"`, "token: <redacted> = <redacted>"],
    [`secret: Optional[str] = '${FAKE}'`, "secret: <redacted> = <redacted>"],
    // YAML or prose where the "type" is the secret itself.
    [`password: ${FAKE} = ignored`, "password: <redacted> = <redacted>"],
    [`token: ${FAKE} := x`, "token: <redacted> := <redacted>"],
    [`secret: ${FAKE} : x`, "secret: <redacted> : <redacted>"]
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 2, withheld: false }, input);
  }
  // Text that is already masked is not masked or counted again.
  assert.deepEqual(redactSecrets("api_key: <redacted> = <redacted>"), { text: "api_key: <redacted> = <redacted>", count: 0, withheld: false });
});

test("an assignment with := and no annotation masks only the value", () => {
  for (const [input, output] of [
    // Go and Makefile.
    [`apiToken := "${FAKE}"`, "apiToken := <redacted>"],
    [`API_TOKEN := ${FAKE}`, "API_TOKEN := <redacted>"]
  ]) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("a YAML value with a colon or an equals sign in it is still masked whole", () => {
  // Without a space before "=", the start of the value is not read as a type.
  const cases = [
    ["secret: QUJDRA==", "secret: <redacted>"],
    [`token: abc:${FAKE}`, "token: <redacted>"],
    [`{"password": "${FAKE}"}`, '{"password": <redacted>}']
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("more secret names are masked: passphrase, private key, credentials", () => {
  const cases = [
    [`passphrase = ${FAKE}`, "passphrase = <redacted>"],
    [`PRIVATE_KEY=${FAKE}`, "PRIVATE_KEY=<redacted>"],
    [`privateKey: "${FAKE}"`, "privateKey: <redacted>"],
    [`private-key: ${FAKE}`, "private-key: <redacted>"],
    [`credentials = ${FAKE}`, "credentials = <redacted>"],
    [`aws_credential: ${FAKE}`, "aws_credential: <redacted>"]
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("the short words pass and pwd are no secret names", () => {
  for (const text of ["pwd = /home/x", "pass: through", "bypass = true"]) {
    assert.deepEqual(redactSecrets(text), { text, count: 0, withheld: false }, text);
  }
});

test("the password in a URL is masked, and the scheme, the user and the host stay", () => {
  const cases = [
    [`postgres://admin:${FAKE}@db.example.invalid:5432/app`, "postgres://admin:<redacted>@db.example.invalid:5432/app"],
    [`see https://ci-bot:${FAKE}@git.example.invalid/x.git now`, "see https://ci-bot:<redacted>@git.example.invalid/x.git now"]
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("a URL without a password is not masked", () => {
  for (const text of ["https://user@host.example.invalid/path", "https://host.example.invalid:8443/x", "mailto:someone@example.invalid"]) {
    assert.deepEqual(redactSecrets(text), { text, count: 0, withheld: false }, text);
  }
});

test("the credential of an Authorization header is masked, and its scheme word stays", () => {
  const cases = [
    [`Authorization: Bearer ${FAKE}`, "Authorization: Bearer <redacted>"],
    [`{"Authorization": "Basic ${FAKE}"}`, '{"Authorization": "Basic <redacted>"}'],
    [`headers.authorization = 'token ${FAKE}';`, "headers.authorization = 'token <redacted>';"]
  ];
  for (const [input, output] of cases) {
    assert.deepEqual(redactSecrets(input), { text: output, count: 1, withheld: false }, input);
  }
});

test("an Authorization header without a credential is not masked", () => {
  for (const text of ["Authorization: none", "the Authorization header is missing"]) {
    assert.deepEqual(redactSecrets(text), { text, count: 0, withheld: false }, text);
  }
});

test("a value that is already masked is not masked or counted again", () => {
  // The excerpt readers mask first; prepareFinding masks the excerpt a second time.
  for (const text of ["Authorization: Bearer <redacted>", "postgres://admin:<redacted>@db.example.invalid/app"]) {
    assert.deepEqual(redactSecrets(text, [], { assignments: false }), { text, count: 0, withheld: false }, text);
  }
});

test("without assignments, only the registered values and the token shapes are masked", () => {
  // The second pass over a numbered excerpt: the name rule would mask the next line's number.
  const text = `2: const apiKey =\n3:   <redacted>;\n4: uses ${FAKE} and sk-${"a".repeat(24)}`;
  assert.deepEqual(redactSecrets(text, [FAKE], { assignments: false }), { text: "2: const apiKey =\n3:   <redacted>;\n4: uses <redacted> and <redacted>", count: 2, withheld: false });
  // Positive control: with assignments the rule would eat the number "3:".
  assert.match(redactSecrets(text).text, /apiKey =\n<redacted>/);
});

test("the JWT shape is checked in linear time, and a JWT is still masked", () => {
  // The old \b form could start again after every "-" of such a run.
  const text = "eyJaaaaa-".repeat(23000);
  const started = Date.now();
  assert.equal(redactSecrets(text).text, text);
  const ms = Date.now() - started;
  assert.ok(ms < 1000, `took ${ms} ms`);
  assert.equal(redactSecrets(`token eyJ${"f".repeat(10)}.${"g".repeat(10)}.${"h".repeat(10)} end`).text, "token <redacted> end");
});

// Each new pattern with a repeated part, on about 200 KB of hostile input.
const HOSTILE = {
  "URL: a long scheme-like run": "a.".repeat(100000),
  "URL: a long password without @": `x://u:${"p:".repeat(100000)}`,
  "URL: many short URLs": "a://".repeat(50000),
  "Authorization: spaces after the colon": `Authorization:${" ".repeat(200000)}x`,
  "Authorization: spaces after the scheme word": `Authorization: Bearer${" ".repeat(200000)}`,
  "Authorization: many headers": "Authorization: Bearer ".repeat(9000),
  "assignment: a long type": `secret: ${"a.".repeat(100000)}`,
  "assignment: a long union type": `token: a${" | a".repeat(50000)}`,
  "assignment: spaces before :=": `token${" ".repeat(200000)}:`,
  "assignment: many annotations": "token: str ".repeat(20000),
  "key: a long PuTTY version": `PuTTY-User-Key-File-${"1".repeat(200000)}`,
  "key: a long SSH2 label": `${"-".repeat(4)} BEGIN SSH2 ${"A ".repeat(100000)}`,
  "key: one long base64 run": "A".repeat(200000),
  "key: many base64 runs": `${"B".repeat(40)} `.repeat(5000)
};
for (const [name, text] of Object.entries(HOSTILE)) {
  test(`linear time on hostile input: ${name}`, () => {
    const started = Date.now();
    redactSecrets(text);
    const ms = Date.now() - started;
    assert.ok(ms < 1000, `took ${ms} ms`);
  });
}

test("text without a secret is unchanged and counts nothing", () => {
  // Positive control for the masks above: an ordinary sentence must pass through.
  assert.deepEqual(redactSecrets("plain text, no secret"), { text: "plain text, no secret", count: 0, withheld: false });
});

test("a private key block withholds the whole text", () => {
  assert.deepEqual(redactSecrets(`x\n${pem("BEGIN", "OPENSSH PRIVATE KEY")}\nabc`), { text: "", count: 0, withheld: true });
});

test("any private key line withholds the whole text: a lone END line, a header without END, a PGP block", () => {
  const texts = [
    `the key ends here:\n${pem("END", "RSA PRIVATE KEY")}`,
    `${pem("BEGIN", "PRIVATE KEY")}\nMIIE and no end line`,
    `${pem("BEGIN", "ENCRYPTED PRIVATE KEY")}`,
    `${pem("BEGIN", "PGP PRIVATE KEY BLOCK")}\n\nlQOYBF`,
    `${pem("END", "PGP PRIVATE KEY BLOCK")}`,
    // A key kept in a JSON string is one line with escaped line breaks.
    `"key": "${pem("BEGIN", "EC PRIVATE KEY")}\\nMHcC"`
  ];
  for (const text of texts) {
    assert.deepEqual(redactSecrets(text), { text: "", count: 0, withheld: true }, text);
  }
});

test("a public key or a certificate is not withheld", () => {
  // Positive control for the key check: only private keys hold a text back.
  for (const text of [pem("BEGIN", "PUBLIC KEY"), pem("BEGIN", "CERTIFICATE"), pem("END", "PGP PUBLIC KEY BLOCK")]) {
    assert.equal(redactSecrets(text).withheld, false, text);
  }
});

test("a PuTTY key, an SSH2 private key and a base64-encoded private key withhold the whole text", () => {
  // Every key line is built from parts at run time.
  const putty = `${["PuTTY", "User", "Key", "File", "3"].join("-")}: ssh-ed25519`;
  const ssh2 = (edge) => `${"-".repeat(4)} ${edge} SSH2 ENCRYPTED PRIVATE KEY ${"-".repeat(4)}`;
  const encoded = Buffer.from([pem("BEGIN", "RSA PRIVATE KEY"), "A".repeat(64), pem("END", "RSA PRIVATE KEY")].join("\n")).toString("base64");
  const texts = [
    `${putty}\nEncryption: none`,
    // A key kept in a JSON string on one line.
    `{"ppk": "${putty}\\nEncryption: none"}`,
    `${ssh2("BEGIN")}\nAAAA`,
    `the key ends here:\n${ssh2("END")}`,
    // A Kubernetes secret keeps the key in base64.
    `tls.key: ${encoded}`,
    // The same, wrapped at 64 characters.
    `key: |\n${encoded.match(/.{1,64}/g).join("\n")}`,
    // A run that starts one character before the encoded key.
    `x${encoded}`
  ];
  for (const text of texts) {
    assert.equal(holdsPrivateKey(text), true, text);
    assert.deepEqual(redactSecrets(text), { text: "", count: 0, withheld: true }, text);
  }
});

test("a long ordinary base64 run, such as an image, is not withheld", () => {
  // Positive control for the base64 check: bytes that are not a key.
  const image = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7 + 13) % 256)).toString("base64");
  const encodedPublic = Buffer.from(pem("BEGIN", "PUBLIC KEY")).toString("base64");
  for (const text of [`data:image/png;base64,${image}`, `pub: ${encodedPublic}`]) {
    assert.equal(holdsPrivateKey(text), false);
    assert.equal(redactSecrets(text).withheld, false);
  }
});

test("a PuTTY key file counts as sensitive, in any letter case", () => {
  for (const name of ["keys/server.ppk", "HOME.PPK"]) {
    assert.equal(isSensitivePath(name), true, name);
  }
  assert.equal(isSensitivePath("notes/ppk.md"), false);
});

test("the rule files themselves hold no private key line, so a review that cites them can be triaged", () => {
  for (const name of ["secret-patterns.mjs", "evidence.mjs", "triage-core.mjs"]) {
    assert.equal(holdsPrivateKey(fs.readFileSync(path.join(ROOT, "scripts", "lib", name), "utf8")), false, name);
  }
});

test("each registered secret is masked and counted", () => {
  const result = redactSecrets("uses test-key-not-a-secret here and test-key-not-a-secret again", ["test-key-not-a-secret"]);
  assert.equal(result.text, "uses <redacted> here and <redacted> again");
  assert.equal(result.count, 2);
});

test("a replacement text with dollar signs is not read as a pattern", () => {
  // String.replace reads "$&" in a replacement string; the masks use functions.
  assert.equal(redactSecrets("password=$&$1").text, "password=<redacted>");
});
