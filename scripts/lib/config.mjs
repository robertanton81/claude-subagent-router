import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PLUGIN = "subagent-router";

// Up to version 0.2.3 the plugin was named "orchestrator", and the dispatch log
// kept from that time names the workers "orchestrator:<worker>". Readers of the
// log map such a name to the current one, so old records still count.
const LEGACY_WORKER = /^orchestrator:([a-z-]+)$/;

export function currentAgentName(name) {
  const match = typeof name === "string" ? LEGACY_WORKER.exec(name) : null;
  return match ? `${PLUGIN}:${match[1]}` : name;
}

// A lookup table without inherited keys. With a plain object, a name such as
// "constructor" would find a function on Object.prototype and count as a match.
export function table(entries) {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

export const WORKERS = Object.freeze({
  searcher: `${PLUGIN}:searcher`,
  completeSearcher: `${PLUGIN}:complete-searcher`,
  implementer: `${PLUGIN}:implementer`,
  debugger: `${PLUGIN}:debugger`,
  reviewer: `${PLUGIN}:reviewer`,
  codexImplementer: `${PLUGIN}:codex-implementer`,
  codexReviewer: `${PLUGIN}:codex-reviewer`
});

export const WORKER_SET = new Set(Object.values(WORKERS));

// The model that each worker runs on when the call names no model.
// Keep this in sync with the `model:` line of the agent files.
export const DEFAULT_MODEL = table({
  [WORKERS.searcher]: "haiku",
  [WORKERS.completeSearcher]: "sonnet",
  [WORKERS.implementer]: "sonnet",
  [WORKERS.debugger]: "opus",
  [WORKERS.reviewer]: "sonnet",
  [WORKERS.codexImplementer]: "haiku",
  [WORKERS.codexReviewer]: "haiku"
});

// The effort each worker runs at, from the `effort:` line of its agent file.
// Without that line a worker inherits the session's effort, so a session at
// `max` would run every worker at `max`. Each value is the default of the
// worker's own model: Sonnet 5 `high`, Opus 5.5 `medium`. The one exception
// is the complete searcher: Sonnet at `low`, because a complete listing needs a
// careful reader more than long thinking. Haiku 4.5 takes no effort, so the Haiku workers
// have no line (null). The line stays when the hook
// changes the model: an implementer moved to Opus runs at `high`, a debugger
// capped at Sonnet runs at `medium`. The variable CLAUDE_CODE_EFFORT_LEVEL
// overrides the line. Source: https://code.claude.com/docs/en/model-config,
// checked 2026-09-23. Keep this in sync with the agent files.
export const DEFAULT_EFFORT = table({
  [WORKERS.searcher]: null,
  [WORKERS.completeSearcher]: "low",
  [WORKERS.implementer]: "high",
  [WORKERS.debugger]: "medium",
  [WORKERS.reviewer]: "high",
  [WORKERS.codexImplementer]: null,
  [WORKERS.codexReviewer]: null
});

// Workers that change files, and the model family that writes the change.
export const WRITER_FAMILY = table({
  [WORKERS.implementer]: "claude",
  [WORKERS.debugger]: "claude",
  [WORKERS.codexImplementer]: "codex"
});

export const REVIEWER_SET = new Set([WORKERS.reviewer, WORKERS.codexReviewer]);

// The thin Codex workers, and the kind of Codex job that each one starts.
export const CODEX_JOB_KIND = table({
  [WORKERS.codexImplementer]: "implement",
  [WORKERS.codexReviewer]: "review"
});

// Agent types from other plugins that would go around the routing of our workers.
export const REDIRECTS = table({
  "codex:codex-rescue": WORKERS.codexImplementer
});

// Helper agents of Claude Code that run on a fixed model. The hook never sets
// their model. Source: https://code.claude.com/docs/en/sub-agents, checked 2026-09-21.
export const FIXED_MODEL_AGENTS = new Set(["statusline-setup", "claude-code-guide"]);

const MODES = new Set(["enforce", "shadow", "off"]);
// The completeness rule has its own switch, so it can be watched in a session
// whose routing is already in force. "shadow" changes no route and records what
// it would have changed, "enforce" changes the route, "off" does neither.
const COMPLETE_RULES = new Set(["shadow", "enforce", "off"]);

export const DEFAULTS = Object.freeze({
  mode: "enforce",
  kindGate: 0.6,
  difficultyGate: 0.5,
  selfContainedGate: 0.7,
  limitGate: 80,
  // The pace rule: a window also counts as tight when the usage so far, continued
  // at the same speed, reaches 100 percent before the window resets. It counts
  // only after `paceAfter` of the window has passed, because a projection from
  // the first minutes is noise.
  pacing: true,
  paceAfter: 0.2,
  // A search whose answer must name every match does not go to the small model.
  // New on 2026-09-22 and in "shadow" until the log says what it would do.
  completeRule: "shadow",
  completeGate: 0.6,
  limitsMaxAgeMs: 10 * 60 * 1000,
  // The classifier is opt-in, like Codex. While this is false, the hook sends no
  // brief to TypeSafe and does not even look for a key, so a key that exists on
  // this machine for another purpose is never used without a yes.
  jevEnabled: false,
  jevTimeoutMs: 5000,
  jevModel: "jev-latest",
  jevUrl: "https://api.typesafe.ai/v1/systemone",
  promptLogChars: 20000,
  resultLogChars: 4000,
  // Codex is opt-in. While this is false, the plugin sends no task to Codex and
  // starts no Codex job: tasks for the Codex workers run on Claude workers.
  codexEnabled: false,
  // Send a snapshot of Claude instruction files with implement and custom
  // review briefs. Codex does not discover these Claude sources itself.
  codexIncludeUserRules: true,
  codexIncludeProjectRules: true,
  // When the weekly Codex allowance is used up, Codex goes on and pays from bought
  // credits. "Subscriptions only" means no, unless the user says yes here.
  codexSpendCredits: false,
  // For an agent type that is not one of our workers, the hook can set the model.
  // It never changes the agent type. The briefs of these calls then go to Jev too.
  routeOtherAgents: true,
  // Agent types whose model the hook leaves alone, by exact name. Jev sees only the
  // brief, so it cannot know that an agent runs on a small model on purpose.
  keepModelAgents: Object.freeze([])
});

// One fixed folder for the log, the Codex jobs and the limits file.
// The Bash tool does not receive CLAUDE_PLUGIN_DATA of this plugin, and another
// plugin may export its own value, so that variable is not used here.
export function dataDir(env = process.env) {
  return env.ORCH_DATA_DIR || path.join(os.homedir(), ".claude", "orchestrator");
}

// Returns { values, unusable }. `unusable` is true when the file exists but
// cannot be used. The caller then must not fall back to a mode that rewrites calls.
function readConfigFile(env, warnings) {
  const file = path.join(dataDir(env), "config.json");
  if (!fs.existsSync(file)) {
    return { values: {}, unusable: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const key of Object.keys(parsed)) {
        if (!(key in DEFAULTS)) {
          warnings.push(`config.json has the unknown key "${key}", so it was ignored. Known keys: ${Object.keys(DEFAULTS).join(", ")}`);
        }
      }
      return { values: parsed, unusable: false };
    }
    warnings.push("config.json is not a JSON object, so it was ignored and the mode is \"shadow\"");
  } catch (error) {
    warnings.push(`config.json could not be read, so it was ignored and the mode is "shadow": ${error.message}`);
  }
  return { values: {}, unusable: true };
}

function text(name, value, fallback, warnings) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "string") {
    return value;
  }
  warnings.push(`${name} must be a text value, so the default was used`);
  return fallback;
}

function flag(name, value, fallback, warnings) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  warnings.push(`${name} must be true or false without quotes, so the default ${fallback} was used`);
  return fallback;
}

// A setting that may hold only one of a few words. An unknown word falls back to
// the default, which for every such setting is the one that changes no route.
function oneOf(name, value, allowed, fallback, warnings) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "string" && allowed.has(value)) {
    return value;
  }
  warnings.push(`${name} must be one of ${[...allowed].join(", ")}, so "${fallback}" was used`);
  return fallback;
}

function textList(name, value, fallback, warnings) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry !== "")) {
    return value;
  }
  warnings.push(`${name} must be a list of agent type names, so the default was used`);
  return fallback;
}

// A variable that turns a switch on or off for one session, like ORCH_MODE does for the mode.
function envFlag(name, value, fallback, warnings) {
  if (value === undefined || value === "") {
    return fallback;
  }
  if (["1", "true"].includes(value)) {
    return true;
  }
  if (["0", "false"].includes(value)) {
    return false;
  }
  warnings.push(`${name} must be 1, 0, true or false, so the value ${fallback} was used`);
  return fallback;
}

function numberInRange(name, value, fallback, min, max, warnings) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const number = Number(value);
  if (Number.isFinite(number) && number >= min && number <= max) {
    return number;
  }
  warnings.push(`${name} must be a number from ${min} to ${max}, so the default ${fallback} was used`);
  return fallback;
}

// What each setting may hold. `loadConfig` below checks the same things while it
// reads a file; this table is what a tool needs in order to check one value
// before writing it, and to explain the setting to someone. The test
// "the spec and the loader agree" keeps the two in step: a value this table
// rejects must also be refused by the loader.
export const CONFIG_SPEC = Object.freeze({
  mode: { kind: "choice", values: [...MODES], about: "enforce rewrites confident routes, shadow only logs what it would do, off asks the classifier nothing" },
  kindGate: { kind: "number", min: 0, max: 1, about: "the confidence the classifier needs in the kind of task before a call is rewritten" },
  difficultyGate: { kind: "number", min: 0, max: 1, about: "the confidence needed in the difficulty before the difficulty counts" },
  selfContainedGate: { kind: "number", min: 0, max: 1, about: "how self-contained a brief must be before Codex gets the task" },
  limitGate: { kind: "number", min: 0, max: 100, about: "the percentage of a usage window from which the table prefers Codex" },
  completeRule: { kind: "choice", values: [...COMPLETE_RULES], about: "what to do with a search that is only answered correctly by a complete list" },
  completeGate: { kind: "number", min: 0, max: 1, about: "how sure the classifier must be that an answer needs every match" },
  pacing: { kind: "flag", about: "also count a window as full when the usage so far is on pace to reach 100 percent before the reset" },
  paceAfter: { kind: "number", min: 0, max: 1, about: "how much of a window must pass before the pace rule counts" },
  limitsMaxAgeMs: { kind: "number", min: 0, max: 24 * 3600 * 1000, about: "how long a usage sample stays usable, in milliseconds" },
  jevEnabled: { kind: "flag", about: "let the hooks send briefs, and the verification part of worker answers, to the TypeSafe classifier Jev, which the routing needs" },
  jevTimeoutMs: { kind: "number", min: 100, max: 8000, about: "how long to wait for the classifier, in milliseconds" },
  jevModel: { kind: "text", about: "the classifier version; pin an exact version while measuring" },
  jevUrl: { kind: "text", about: "where the classifier request goes" },
  promptLogChars: { kind: "number", min: 0, max: 200000, about: "how much of a brief the log keeps; 0 keeps briefs out of the log" },
  resultLogChars: { kind: "number", min: 0, max: 200000, about: "how much of a worker answer the log keeps" },
  codexEnabled: { kind: "flag", about: "let the plugin use Codex at all" },
  codexIncludeUserRules: { kind: "flag", about: "send personal Claude instructions and imports with implement and custom review briefs" },
  codexIncludeProjectRules: { kind: "flag", about: "send project and parent Claude instructions and imports with implement and custom review briefs" },
  codexSpendCredits: { kind: "flag", about: "let a Codex job pay from bought credits once the weekly allowance is used up" },
  routeOtherAgents: { kind: "flag", about: "let the hook set the model of agent types that are not the plugin's own workers" },
  keepModelAgents: { kind: "textList", about: "agent types whose model the hook never changes, by exact name" }
});

// Turns one written value into the value that belongs in the file. It throws with
// a sentence a person can act on, so a tool never writes something the loader
// would then refuse in silence.
// A plain object inherits names like `constructor` and `toString` from its
// prototype, so `CONFIG_SPEC[key]` answers for words that are not settings at
// all. Every lookup by a name from outside goes through this.
export function settingSpec(key) {
  return Object.prototype.hasOwnProperty.call(CONFIG_SPEC, key) ? CONFIG_SPEC[key] : undefined;
}

export function parseSetting(key, raw) {
  const spec = settingSpec(key);
  if (!spec) {
    throw new Error(`"${key}" is not a setting of this plugin. Run "show" to see the settings.`);
  }
  const text = typeof raw === "string" ? raw.trim() : raw;
  // An empty value means "clear this" only for a list. For everything else the
  // loader would fall back to the default, so writing it would be a setting that
  // silently does nothing, or worse: an empty value reads as the number 0.
  if (text === "" && spec.kind !== "textList") {
    throw new Error(`${key} needs a value. To put it back to its default, use "unset ${key}".`);
  }
  switch (spec.kind) {
    case "choice":
      if (!spec.values.includes(text)) {
        throw new Error(`${key} must be one of ${spec.values.join(", ")}, not "${text}".`);
      }
      return text;
    case "flag":
      if (["true", "1", "yes", "on", true].includes(text)) {
        return true;
      }
      if (["false", "0", "no", "off", false].includes(text)) {
        return false;
      }
      throw new Error(`${key} must be true or false, not "${text}".`);
    case "number": {
      const value = Number(text);
      if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
        throw new Error(`${key} must be a number from ${spec.min} to ${spec.max}, not "${text}".`);
      }
      return value;
    }
    case "textList": {
      if (Array.isArray(text)) {
        return text;
      }
      // An empty value means an empty list, which is how a list is cleared.
      const entries = String(text).split(",").map((entry) => entry.trim()).filter(Boolean);
      return entries;
    }
    default:
      if (typeof text !== "string" || text === "") {
        throw new Error(`${key} must be a text value.`);
      }
      return text;
  }
}

// Order: defaults, then config.json, then environment variables.
// Every caller must show `warnings` somewhere, so a bad value is never silent.
export function loadConfig(env = process.env) {
  const warnings = [];
  const file = readConfigFile(env, warnings);
  const merged = { ...DEFAULTS, ...file.values };

  // A damaged file may have asked for "shadow" or "off". Nobody can know, so the
  // safe reading is "shadow". An explicit ORCH_MODE still wins.
  let mode = env.ORCH_MODE || (file.unusable ? "shadow" : merged.mode);
  if (!MODES.has(mode)) {
    // A wrong mode must never rewrite calls by accident.
    warnings.push(`mode "${mode}" is not valid, so "shadow" was used`);
    mode = "shadow";
  }

  const config = {
    mode,
    kindGate: numberInRange("kindGate", merged.kindGate, DEFAULTS.kindGate, 0, 1, warnings),
    difficultyGate: numberInRange("difficultyGate", merged.difficultyGate, DEFAULTS.difficultyGate, 0, 1, warnings),
    selfContainedGate: numberInRange("selfContainedGate", merged.selfContainedGate, DEFAULTS.selfContainedGate, 0, 1, warnings),
    limitGate: numberInRange("limitGate", merged.limitGate, DEFAULTS.limitGate, 0, 100, warnings),
    completeRule: oneOf("completeRule", env.ORCH_COMPLETE_RULE ?? merged.completeRule, COMPLETE_RULES, DEFAULTS.completeRule, warnings),
    completeGate: numberInRange("completeGate", merged.completeGate, DEFAULTS.completeGate, 0, 1, warnings),
    pacing: flag("pacing", merged.pacing, DEFAULTS.pacing, warnings),
    paceAfter: numberInRange("paceAfter", merged.paceAfter, DEFAULTS.paceAfter, 0, 1, warnings),
    limitsMaxAgeMs: numberInRange("limitsMaxAgeMs", merged.limitsMaxAgeMs, DEFAULTS.limitsMaxAgeMs, 0, 24 * 3600 * 1000, warnings),
    jevEnabled: envFlag("ORCH_JEV_ENABLED", env.ORCH_JEV_ENABLED, flag("jevEnabled", merged.jevEnabled, false, warnings), warnings),
    jevTimeoutMs: numberInRange("jevTimeoutMs", env.ORCH_JEV_TIMEOUT_MS ?? merged.jevTimeoutMs, DEFAULTS.jevTimeoutMs, 100, 8000, warnings),
    jevModel: text("jevModel", merged.jevModel, DEFAULTS.jevModel, warnings),
    jevUrl: env.ORCH_TYPESAFE_URL || text("jevUrl", merged.jevUrl, DEFAULTS.jevUrl, warnings),
    promptLogChars: numberInRange("promptLogChars", merged.promptLogChars, DEFAULTS.promptLogChars, 0, 200000, warnings),
    resultLogChars: numberInRange("resultLogChars", merged.resultLogChars, DEFAULTS.resultLogChars, 0, 200000, warnings),
    codexEnabled: envFlag("ORCH_CODEX_ENABLED", env.ORCH_CODEX_ENABLED, flag("codexEnabled", merged.codexEnabled, false, warnings), warnings),
    codexIncludeUserRules: flag("codexIncludeUserRules", merged.codexIncludeUserRules, true, warnings),
    codexIncludeProjectRules: flag("codexIncludeProjectRules", merged.codexIncludeProjectRules, true, warnings),
    codexSpendCredits: flag("codexSpendCredits", merged.codexSpendCredits, false, warnings),
    routeOtherAgents: envFlag("ORCH_ROUTE_OTHER_AGENTS", env.ORCH_ROUTE_OTHER_AGENTS, flag("routeOtherAgents", merged.routeOtherAgents, true, warnings), warnings),
    keepModelAgents: textList("keepModelAgents", merged.keepModelAgents, DEFAULTS.keepModelAgents, warnings)
  };

  return { config, warnings };
}
