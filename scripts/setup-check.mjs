#!/usr/bin/env node
// Prints a checklist of everything that the plugin needs but cannot ship itself.
// It never prints a secret: for the key it shows only where the key was found.

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { FIXED_MODEL_AGENTS, dataDir, loadConfig } from "./lib/config.mjs";
import { limitsFile, readLimitsState } from "./lib/context.mjs";
import { logFile, readLogTail } from "./lib/log.mjs";
import { codexPlatformSupported, codexState, describeTime } from "./lib/provider-state.mjs";
import { askJev, findApiKey } from "./lib/typesafe.mjs";

const live = process.argv.includes("--live");
const rows = [];

function row(status, name, detail) {
  rows.push(`${status.padEnd(7)} ${name}: ${detail}`);
}

// Returns { text, problem }. `codex login status` prints its answer on stderr,
// so both streams matter. The problem tells "not found" from "too slow".
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) {
    return { text: null, problem: result.error.code === "ETIMEDOUT" ? "it did not answer within 10 seconds" : `it could not start (${result.error.code ?? result.error.message})` };
  }
  return { text: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), status: result.status, problem: null };
}

function maskKeys(text) {
  return String(text).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<hidden>");
}

const { config, warnings } = loadConfig();

const major = Number(process.versions.node.split(".")[0]);
row(major >= 20 ? "OK" : "MISSING", "Node.js", `version ${process.versions.node}; the hooks need 20 or newer`);

// Codex is opt-in. While it is off, the Codex CLI and its login do not matter.
const codexVersion = config.codexEnabled && codexPlatformSupported() ? run("codex", ["--version"]) : null;
if (config.codexEnabled && !codexPlatformSupported()) {
  row("WARN", "Codex", "is on in config.json, but Codex jobs need macOS or Linux (they use `ps` and process groups). On this system all work runs on Claude workers");
} else if (!codexVersion) {
  row("OK", "Codex", 'off, so all work runs on Claude workers. To use Codex, set "codexEnabled": true in config.json');
} else if (codexVersion.problem) {
  row("MISSING", "Codex CLI", `the command \`codex\` did not run: ${codexVersion.problem}`);
} else {
  row("OK", "Codex CLI", codexVersion.text);
  const login = run("codex", ["login", "status"]);
  if (login.problem) {
    row("MISSING", "Codex login", `\`codex login status\` did not run: ${login.problem}`);
  } else if (/chatgpt/i.test(login.text)) {
    row("OK", "Codex login", "ChatGPT login, so usage counts toward the ChatGPT plan");
  } else if (/api key/i.test(login.text)) {
    row("WARN", "Codex login", "API key login, so OpenAI bills at API rates. The runner refuses to start jobs. Run `codex login` and choose ChatGPT");
  } else {
    row("MISSING", "Codex login", `no ChatGPT login was reported (exit status ${login.status}). The answer was: ${maskKeys(login.text).slice(0, 200) || "(empty)"}`);
  }
  // codexState() checks both signals of a used-up plan: the pause after a job that
  // failed with a usage limit, and the saved limit numbers at 100 percent. The hook
  // moves tasks away from Codex only in enforce mode. The runner checks in every mode.
  const codex = codexState(config);
  if (!codex.available) {
    const planUsedUp = codex.reason === "codex_plan_used_up";
    const why = planUsedUp
      ? `the saved Codex limit numbers show ${Math.round(codex.usedPercent)}% of the weekly allowance used, and codexSpendCredits is false`
      : "a Codex job failed with a usage limit";
    const routing = config.mode === "enforce" ? "the routing sends no tasks to Codex, and " : "";
    const runner = planUsedUp ? "the runner starts no Codex job" : "the runner starts no Codex job unless codexSpendCredits is true";
    row("WARN", "Codex capacity", `${why}. Until ${describeTime(codex.until)}, ${routing}${runner}`);
  }
}
for (const name of ["OPENAI_API_KEY", "CODEX_API_KEY"]) {
  if (process.env[name]) {
    row("WARN", name, "is set in this environment. The Codex runner removes it for its own jobs, but other Codex runs would be billed at API rates");
  }
}

const { key, source } = config.jevEnabled ? findApiKey() : { key: null, source: null };
if (!config.jevEnabled) {
  row("OK", "Jev", 'off, so the hook sends no brief to TypeSafe and changes no route. The workers keep the models of their agent files. To route with Jev, set "jevEnabled": true in config.json and add a TypeSafe key');
} else if (!key) {
  // Claude Code passes the plugin option only to hooks, so this check cannot see
  // it. The hook records where it found the key, so the last routed call answers.
  // Records from before 0.2.0 can name key places that are no longer read, so
  // only the two current places count.
  const last = readLogTail()
    .filter((record) => record.event === "dispatch" && (["plugin_option", "env"].includes(record.jev?.key_source) || record.reason === "error_no_key"))
    .at(-1);
  if (last?.jev?.key_source) {
    row("OK", "TypeSafe key", `the hook found it in the ${last.jev.key_source === "plugin_option" ? "plugin option" : last.jev.key_source} on its last routed call, ${last.ts}. This check cannot see the plugin option itself, so --live cannot test the key`);
  } else {
    const when = last ? `the hook had no key on its last routed call, ${last.ts}` : "no routed call that used a current key place has been logged yet";
    row("MISSING", "TypeSafe key", `not in TYPESAFE_API_KEY, and ${when}. Copy the key, then run in a terminal: k=$(pbpaste) && claude plugin install orchestrator@llm-orchestrator --config "typesafe_api_key=$k"; unset k (add the --scope of your install). This check cannot see the plugin option itself; the next routed call shows whether the hook finds it`);
  }
} else {
  row("OK", "TypeSafe key", `found (source: ${source})`);
  if (live) {
    try {
      const sample = { description: "Find usages", prompt: "Goal: list every file that imports the module `auth`. Change no files." };
      const result = await askJev(sample, config, key);
      row("OK", "TypeSafe live call", `${result.latencyMs} ms, kind=${result.answers.kind}, confidence=${result.answers.kindConfidence.toFixed(2)}`);
    } catch (error) {
      row("MISSING", "TypeSafe live call", `failed with ${error.code ?? error.message}`);
    }
  }
}

const limits = readLimitsState(config);
if (limits.state === "ok" && limits.fiveHour === null && limits.sevenDay === null) {
  row("WARN", "Status line log", `${limitsFile()} is fresh but holds no percentage, so the limit rule is off. Check the variable names in the snippet`);
} else if (limits.state === "ok" && limits.fiveHourResetsAt === null && limits.sevenDayResetsAt === null) {
  row("WARN", "Status line log", `${limitsFile()} holds percentages but no reset time, so the pace rule cannot run. Paste the current scripts/statusline-snippet.sh again; it also reads RATE_5H_RESET and RATE_7D_RESET`);
} else if (limits.state === "ok") {
  row("OK", "Status line log", `5-hour ${limits.fiveHour ?? "?"}% (resets ${describeTime(limits.fiveHourResetsAt)}), 7-day ${limits.sevenDay ?? "?"}% (resets ${describeTime(limits.sevenDayResetsAt)}), ${Math.round(limits.ageMs / 1000)} s old`);
} else if (limits.state === "old") {
  row("WARN", "Status line log", `${limitsFile()} is ${Math.round(limits.ageMs / 60000)} minutes old, so the limit rule is off until the status line writes again`);
} else if (limits.state === "damaged") {
  row("WARN", "Status line log", `${limitsFile()} cannot be read (${limits.detail}), so the limit rule is off`);
} else {
  row("MISSING", "Status line log", `${limitsFile()} does not exist, so the limit rule is off. See README, section "Setup"`);
}

try {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.accessSync(dataDir(), fs.constants.W_OK);
  row("OK", "Data folder", `${dataDir()} (log: ${fs.existsSync(logFile()) ? "exists" : "not written yet"})`);
} catch (error) {
  row("MISSING", "Data folder", `${dataDir()} is not writable: ${error.message}`);
}

row(
  warnings.length === 0 ? "OK" : "WARN",
  "Routing mode",
  `${config.mode}; gate ${config.kindGate}, Codex gate ${config.selfContainedGate}, limit gate ${config.limitGate}%, pace rule ${config.pacing ? `on after ${Math.round(config.paceAfter * 100)}% of a window` : "off"}`
);
row(
  "OK",
  "Completeness rule",
  config.completeRule === "shadow"
    ? `watching only at gate ${config.completeGate}: no route changes, and the log records what it would change. Read it with "node scripts/orch-report.mjs"`
    : config.completeRule === "enforce"
      ? `in force at gate ${config.completeGate}: a search whose answer needs every match keeps sonnet`
      : "off: the rule neither changes a route nor records one"
);
row(
  "OK",
  "Other agent types",
  !config.jevEnabled
    ? "they pass unchanged while Jev is off"
    : config.routeOtherAgents
      ? `the hook can set their model, so their briefs go to TypeSafe too. Agent types it leaves alone: ${[...FIXED_MODEL_AGENTS, ...config.keepModelAgents].join(", ")}`
      : "they pass unchanged, because routeOtherAgents is false"
);
for (const warning of warnings) {
  row("WARN", "Config", warning);
}

process.stdout.write(`${rows.join("\n")}\n`);
